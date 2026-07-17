import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openTetrahedron, tetrahedron } from '../../test/mesh-builders';
import { inspectMesh } from './inspect-mesh';
import { massProperties, MeshVolumeError } from './mass-properties';
import { MAX_STL_BYTES, MAX_TRIANGLES, parseSTL } from './parse-stl';
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

  test.each([1e-6, 1e6])('does not mark a valid tetrahedron degenerate at scale %s', (scale) => {
    expect(inspectMesh(transformMesh(tetrahedron(), scale)).degenerateTriangleCount).toBe(0);
  });

  test.each([1e-9, 1e9])('marks a truly collinear triangle degenerate at scale %s', (scale) => {
    const mesh: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, scale, 0, 0, 2 * scale, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    expect(inspectMesh(mesh).degenerateTriangleCount).toBe(1);
  });

  test('does not modify mesh typed arrays', () => {
    const mesh = tetrahedron();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    inspectMesh(mesh);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
  });

  test('is stable for a tetrahedron translated far from the origin', () => {
    const result = massProperties(transformMesh(tetrahedron(), 1, 1e9));
    expect(result.volume).toBeCloseTo(1 / 6, 10);
    result.centroid.forEach((coordinate) => expect(coordinate).toBeCloseTo(1e9 + 0.25, 5));
  });

  test('detects inverted volume for a reversed tetrahedron translated far from the origin', () => {
    const mesh = transformMesh(tetrahedron(), 1, 1e9);
    const reversed = reverseMesh(mesh);
    const result = massProperties(reversed);
    expect(result.volume).toBeCloseTo(1 / 6, 10);
    result.centroid.forEach((coordinate) => expect(coordinate).toBeCloseTo(1e9 + 0.25, 5));
    expect(inspectMesh(reversed).invertedVolume).toBe(true);
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
    const flatMesh: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    expect(() => massProperties(flatMesh)).toThrow(MeshVolumeError);
  });

  test('does not modify mesh typed arrays', () => {
    const mesh = tetrahedron();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    massProperties(mesh);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
  });

  test.each([1e-6, 1e6])('computes a valid tetrahedron volume at scale %s', (scale) => {
    const expectedVolume = scale ** 3 / 6;
    const result = massProperties(transformMesh(tetrahedron(), scale));
    expect(Math.abs(result.volume / expectedVolume - 1)).toBeLessThan(1e-10);
    expect(Math.abs(result.centroid[0] / (scale / 4) - 1)).toBeLessThan(1e-10);
  });
});

describe('STL parsing', () => {
  test('parses the symmetric spinner fixture as a closed positive-volume mesh', () => {
    const input = readFileSync(resolve(process.cwd(), 'fixtures/stl/symmetric-spinner.stl'));
    const mesh = parseSTL(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    expect(inspectMesh(mesh).boundaryEdgeCount).toBe(0);
    expect(massProperties(mesh).volume).toBeGreaterThan(0);
  });

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

  test('prefers an exact-length binary STL despite a misleading solid header', () => {
    const mesh = parseSTL(binarySTL(tetrahedron(), 'solid facet misleading binary'));
    expect(mesh.positions.length / 3).toBe(4);
    expect(mesh.indices.length / 3).toBe(4);
  });

  test('parses ASCII STL whose first facet occurs beyond the detection prefix', () => {
    const delayedASCII = asciiTetrahedron.replace('solid tetrahedron\n', `solid tetrahedron\n${' '.repeat(300)}\n`);
    const mesh = parseSTL(new TextEncoder().encode(delayedASCII).buffer);
    expect(mesh.positions.length / 3).toBe(4);
    expect(mesh.indices.length / 3).toBe(4);
  });

  test('rejects truncated binary STL', () => {
    expect(() => parseSTL(binarySTL(tetrahedron()).slice(0, 90))).toThrow(/truncated/i);
  });

  test('rejects a binary triangle count above the resource limit before allocation', () => {
    const input = new ArrayBuffer(84);
    new DataView(input).setUint32(80, MAX_TRIANGLES + 1, true);
    expect(() => parseSTL(input)).toThrow(/triangle.*limit/i);
  });

  test('rejects an ASCII string above the byte limit before parsing', () => {
    const input = `solid oversized\n${' '.repeat(MAX_STL_BYTES)}endsolid oversized`;
    expect(() => parseSTL(input)).toThrow(/byte.*limit/i);
  });

  test('applies an injected byte limit to a small input', () => {
    expect(() => parseSTL(asciiTetrahedron, { maxBytes: 32, maxTriangles: 10, maxUniqueVertices: 10 })).toThrow(
      /byte.*limit/i,
    );
  });

  test('rejects binary triangle count before entering the mesh builder', () => {
    expect(() =>
      parseSTL(binarySTL(tetrahedron()), { maxBytes: 1024, maxTriangles: 2, maxUniqueVertices: 0 }),
    ).toThrow(/triangle.*limit/i);
  });

  test('rejects two triangles with more unique vertices than the injected limit', () => {
    const input = `solid four_vertices
facet normal 0 0 1 outer loop
vertex 0 0 0 vertex 1 0 0 vertex 0 1 0
endloop endfacet
facet normal 0 0 1 outer loop
vertex 0 0 0 vertex 0 1 0 vertex 0 0 1
endloop endfacet
endsolid four_vertices`;
    expect(() => parseSTL(input, { maxBytes: 1024, maxTriangles: 2, maxUniqueVertices: 3 })).toThrow(
      /unique vertex.*limit/i,
    );
  });

  test('welded vertices count once against the injected unique-vertex limit', () => {
    const input = `solid welded
facet normal 0 0 1 outer loop
vertex 0 0 0 vertex 1 0 0 vertex 0 1 0
endloop endfacet
facet normal 0 0 1 outer loop
vertex 0 1 0 vertex 1 0 0 vertex 0 0 0
endloop endfacet
endsolid welded`;
    const mesh = parseSTL(input, { maxBytes: 1024, maxTriangles: 2, maxUniqueVertices: 3 });
    expect(mesh.positions.length / 3).toBe(3);
    expect(mesh.indices.length / 3).toBe(2);
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

function binarySTL(mesh: TriangleMesh, header = ''): ArrayBuffer {
  const triangleCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, Math.min(80, header.length)).set(new TextEncoder().encode(header).slice(0, 80));
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

function transformMesh(mesh: TriangleMesh, scale: number, translation = 0): TriangleMesh {
  return {
    positions: new Float64Array(Array.from(mesh.positions, (value) => value * scale + translation)),
    indices: mesh.indices.slice(),
  };
}

function reverseMesh(mesh: TriangleMesh): TriangleMesh {
  const indices = mesh.indices.slice();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const second = indices[offset + 1];
    indices[offset + 1] = indices[offset + 2];
    indices[offset + 2] = second;
  }
  return { positions: mesh.positions.slice(), indices };
}
