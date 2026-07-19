import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseSTL } from './parse-stl';
import { compareMeshes, repairMeshSafe } from './repair-mesh';
import type { TriangleMesh } from './types';

describe('safe mesh repair', () => {
  test('removes degenerate and duplicate faces, welds near vertices, and compacts unused vertices', () => {
    const result = repairMeshSafe(repairableTetrahedron());

    expect(result.mode).toBe('safe');
    expect(result.after.inspection).toMatchObject({
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
    });
    expect(result.after.duplicateTriangleCount).toBe(0);
    expect(result.changes).toMatchObject({
      removedDegenerate: 1,
      removedDuplicate: 2,
      weldedVertices: 1,
      splitVertices: 0,
      filledHoles: 0,
    });
    expect(result.mesh.positions.length / 3).toBe(4);
    expect(result.mesh.indices).toEqual(new Uint32Array([
      0, 1, 2,
      0, 2, 3,
      2, 1, 3,
      1, 0, 3,
    ]));
    expect(result.accepted).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  test('does not mutate source or hide unresolved non-manifold edges', () => {
    const source = threeFacesSharingOneEdge();
    const before = cloneMesh(source);

    const result = repairMeshSafe(source);

    expect(source).toEqual(before);
    expect(result.mesh).not.toBe(source);
    expect(result.mesh.positions).not.toBe(source.positions);
    expect(result.mesh.indices).not.toBe(source.indices);
    expect(result.accepted).toBe(false);
    expect(result.after.inspection.nonManifoldEdgeCount).toBe(1);
    expect(result.blockingReasons).toContain('仍有非流形邊');
  });

  test('derives the weld cell size from the original referenced bounding box', () => {
    const source = repairableTinyTetrahedronWithDegenerateExtrema();

    const result = repairMeshSafe(source);

    expect(result.changes.removedDegenerate).toBe(1);
    expect(result.changes.weldedVertices).toBe(1);
    expect(result.after.inspection.boundaryEdgeCount).toBe(0);
  });

  test('compares axis sizes and absolute volume without mutating either mesh', () => {
    const before = tetrahedron();
    const after = transformMesh(before, [1.004, 0.997, 1.006]);
    const beforeSnapshot = cloneMesh(before);
    const afterSnapshot = cloneMesh(after);

    const comparison = compareMeshes(before, after);

    expect(comparison.beforeSize).toEqual([1, 1, 1]);
    expect(comparison.afterSize[0]).toBeCloseTo(1.004, 12);
    expect(comparison.afterSize[1]).toBeCloseTo(0.997, 12);
    expect(comparison.afterSize[2]).toBeCloseTo(1.006, 12);
    expect(comparison.axisChangePercent[0]).toBeCloseTo(0.4, 12);
    expect(comparison.axisChangePercent[1]).toBeCloseTo(0.3, 12);
    expect(comparison.axisChangePercent[2]).toBeCloseTo(0.6, 12);
    expect(comparison.beforeAbsoluteVolume).toBeCloseTo(1 / 6, 12);
    expect(comparison.afterAbsoluteVolume).toBeCloseTo((1.004 * 0.997 * 1.006) / 6, 12);
    expect(comparison.volumeChangePercent).toBeCloseTo(
      Math.abs(1.004 * 0.997 * 1.006 - 1) * 100,
      12,
    );
    expect(before).toEqual(beforeSnapshot);
    expect(after).toEqual(afterSnapshot);
  });
});

const knightFortressPath = [
  resolve(process.cwd(), 'Copy of Beyblade X Knight Fortress.stl'),
  resolve(process.cwd(), '../../Copy of Beyblade X Knight Fortress.stl'),
].find(existsSync);

describe.runIf(knightFortressPath !== undefined)('Knight Fortress safe repair regression', () => {
  test('removes all 63 degenerate faces without falsely accepting unresolved topology', () => {
    const input = readFileSync(knightFortressPath!);
    const source = parseSTL(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));

    const result = repairMeshSafe(source);

    expect(result.before.inspection.degenerateTriangleCount).toBe(63);
    expect(result.changes.removedDegenerate).toBe(63);
    expect(result.after.inspection.degenerateTriangleCount).toBe(0);
    expect(result.after.inspection.nonManifoldEdgeCount).toBeGreaterThan(0);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('仍有非流形邊');
  });
});

function repairableTetrahedron(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      5e-8, 0, 0,
      0.25, 0.25, 0.25,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 4, 3,
      0, 2, 1,
      1, 2, 0,
      5, 5, 1,
    ]),
  };
}

function tetrahedron(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 0, 3,
    ]),
  };
}

function repairableTinyTetrahedronWithDegenerateExtrema(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1e-6, 0, 0,
      0, 1e-6, 0,
      0, 0, 1e-6,
      5e-8, 0, 0,
      1, 0, 0,
      2, 0, 0,
      3, 0, 0,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 4, 3,
      5, 6, 7,
    ]),
  };
}

function threeFacesSharingOneEdge(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, -1, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 1, 2,
      1, 0, 3,
      0, 1, 4,
    ]),
  };
}

function transformMesh(mesh: TriangleMesh, scale: readonly [number, number, number]): TriangleMesh {
  return {
    positions: new Float64Array(mesh.positions.map((value, index) => value * scale[index % 3])),
    indices: mesh.indices.slice(),
  };
}

function cloneMesh(mesh: TriangleMesh): TriangleMesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}
