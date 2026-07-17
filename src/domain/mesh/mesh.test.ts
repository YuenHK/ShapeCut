import { describe, expect, test } from 'vitest';
import { openTetrahedron, tetrahedron } from '../../test/mesh-builders';
import { inspectMesh } from './inspect-mesh';
import { massProperties, MeshVolumeError } from './mass-properties';
import { parseSTL } from './parse-stl';
import type { TriangleMesh } from './types';

const asciiTetrahedron = `solid tetrahedron
facet normal 0 0 -1
 outer loop
  vertex 0 0 0
  vertex 0 1 0
  vertex 1 0 0
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 0 1
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex 0 0 0
  vertex 0 0 1
  vertex 0 1 0
 endloop
endfacet
facet normal 1 1 1
 outer loop
  vertex 1 0 0
  vertex 0 1 0
  vertex 0 0 1
 endloop
endfacet
endsolid tetrahedron`;

describe('mesh inspection', () => {
  test('an open tetrahedron has three boundary edges', () => {
    expect(inspectMesh(openTetrahedron()).boundaryEdgeCount).toBe(3);
  });

  test('a closed tetrahedron has no boundary edges', () => {
    expect(inspectMesh(tetrahedron()).boundaryEdgeCount).toBe(0);
  });

  test('detects a degenerate triangle', () => {
    const mesh: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    expect(inspectMesh(mesh).degenerateTriangleCount).toBe(1);
  });

  test('detects an edge incident to more than two triangles', () => {
    const mesh: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]),
    };
    expect(inspectMesh(mesh).nonManifoldEdgeCount).toBe(1);
  });

  test('does not modify mesh typed arrays', () => {
    const mesh = tetrahedron();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    inspectMesh(mesh);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
  });
});

describe('mass properties', () => {
  test('a unit tetrahedron centroid is one quarter on every axis', () => {
    const { centroid } = massProperties(tetrahedron());
    expect(centroid[0]).toBeCloseTo(0.25);
    expect(centroid[1]).toBeCloseTo(0.25);
    expect(centroid[2]).toBeCloseTo(0.25);
  });

  test('returns positive volume and the same centroid for reversed orientation', () => {
    const mesh = tetrahedron();
    const reversed = new Uint32Array(mesh.indices.length);
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      reversed.set([mesh.indices[offset], mesh.indices[offset + 2], mesh.indices[offset + 1]], offset);
    }
    const result = massProperties({ positions: mesh.positions, indices: reversed });
    expect(result.volume).toBeCloseTo(1 / 6);
    result.centroid.forEach((coordinate) => expect(coordinate).toBeCloseTo(0.25));
    expect(inspectMesh({ positions: mesh.positions, indices: reversed }).invertedVolume).toBe(true);
  });

  test('throws a typed error for near-zero signed volume', () => {
    expect(() => massProperties(openTetrahedron())).toThrow(MeshVolumeError);
  });

  test('does not modify mesh typed arrays', () => {
    const mesh = tetrahedron();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    massProperties(mesh);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
  });
});

describe('STL parsing', () => {
  test('parses ASCII STL into a stable indexed mesh', () => {
    const mesh = parseSTL(asciiTetrahedron);
    expect(mesh.positions.length / 3).toBe(4);
    expect(mesh.indices.length / 3).toBe(4);
    expect(massProperties(mesh).volume).toBeCloseTo(1 / 6);
  });

  test('parses binary STL into an indexed mesh', () => {
    const mesh = parseSTL(binarySTL(tetrahedron()));
    expect(mesh.positions.length / 3).toBe(4);
    expect(mesh.indices.length / 3).toBe(4);
    expect(massProperties(mesh).centroid[0]).toBeCloseTo(0.25);
  });

  test('rejects truncated binary STL', () => {
    expect(() => parseSTL(binarySTL(tetrahedron()).slice(0, 90))).toThrow(/truncated/i);
  });

  test.each([
    ['', /empty/i],
    ['solid bad\nfacet normal 0 0 1\nouter loop\nvertex NaN 0 0\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid bad', /finite/i],
  ])('rejects invalid ASCII STL', (input, expected) => {
    expect(() => parseSTL(input)).toThrow(expected);
  });

  test('does not modify binary input', () => {
    const input = binarySTL(tetrahedron());
    const before = new Uint8Array(input.slice(0));
    parseSTL(input);
    expect(new Uint8Array(input)).toEqual(before);
  });
});

function binarySTL(mesh: TriangleMesh): ArrayBuffer {
  const triangleCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangleCount, true);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const base = 84 + triangle * 50;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = mesh.indices[triangle * 3 + corner] * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        view.setFloat32(base + 12 + (corner * 3 + axis) * 4, mesh.positions[vertex + axis], true);
      }
    }
  }
  return buffer;
}
