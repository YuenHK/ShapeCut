import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseSTL } from './parse-stl';
import { compareMeshes, repairMeshSafe } from './repair-mesh';
import type { TriangleMesh } from './types';
import {
  interpenetratingTetrahedra,
  tetrahedronWithOneReversedFace,
} from '../../test/mesh-builders';

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

  test('blocks a repair that removes the only face and leaves an empty mesh', () => {
    const source: TriangleMesh = {
      positions: new Float64Array([0, 0, 0]),
      indices: new Uint32Array([0, 0, 0]),
    };

    const result = repairMeshSafe(source);

    expect(result.after.inspection.triangleCount).toBe(0);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('修復結果無法形成有效實體');
  });

  test('blocks closed topology that has zero volume', () => {
    const result = repairMeshSafe(coplanarTetrahedron());

    expect(result.after.inspection).toMatchObject({
      triangleCount: 4,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
    });
    expect(result.comparison.afterAbsoluteVolume).toBe(0);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('修復結果無法形成有效實體');
  });

  test('removes same-winding duplicate volume pollution from the comparison baseline', () => {
    const result = repairMeshSafe(tetrahedronWithSameWindingDuplicate());

    expect(result.changes.removedDuplicate).toBe(1);
    expect(result.comparison.beforeAbsoluteVolume).toBeCloseTo(1 / 6, 12);
    expect(result.comparison.afterAbsoluteVolume).toBeCloseTo(1 / 6, 12);
    expect(result.comparison.volumeChangePercent).toBeCloseTo(0, 12);
    expect(result.accepted).toBe(true);
  });

  test.each([1e6, 1e10])(
    'ignores an unreferenced far vertex at scale %s in degeneracy and before-volume tolerances',
    (distance) => {
      const source = withUnreferencedVertex(tetrahedron(), [distance, distance, distance]);

      const result = repairMeshSafe(source);

      expect(result.before.inspection.degenerateTriangleCount).toBe(0);
      expect(result.changes.removedDegenerate).toBe(0);
      expect(result.after.inspection.triangleCount).toBe(4);
      expect(result.comparison.beforeAbsoluteVolume).toBeCloseTo(1 / 6, 12);
      expect(result.comparison.volumeChangePercent).toBeCloseTo(0, 12);
      expect(result.accepted).toBe(true);
    },
  );

  test('derives the weld cell size from the original referenced bounding box', () => {
    const source = repairableTinyTetrahedronWithDegenerateExtrema();

    const result = repairMeshSafe(source);

    expect(result.changes.removedDegenerate).toBe(1);
    expect(result.changes.weldedVertices).toBe(1);
    expect(result.after.inspection.boundaryEdgeCount).toBe(0);
  });

  test('welds vertices within tolerance across adjacent spatial cells', () => {
    const result = repairMeshSafe(tetrahedronWithSplitOrigin(0.99e-7, 1.01e-7));

    expect(result.changes.weldedVertices).toBe(1);
    expect(result.after.inspection.boundaryEdgeCount).toBe(0);
    expect(result.accepted).toBe(true);
  });

  test('does not weld vertices just beyond the global tolerance', () => {
    const result = repairMeshSafe(tetrahedronWithSplitOrigin(0, 1.0001e-7));

    expect(result.changes.weldedVertices).toBe(0);
    expect(result.after.inspection.boundaryEdgeCount).toBeGreaterThan(0);
    expect(result.accepted).toBe(false);
  });

  test('fails closed for a watertight tetrahedron with one locally reversed face', () => {
    const result = repairMeshSafe(tetrahedronWithOneReversedFace());

    expect(result.after.inspection).toMatchObject({ boundaryEdgeCount: 0, nonManifoldEdgeCount: 0 });
    expect(result.after.inconsistentWindingEdgeCount).toBe(3);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('修復結果仍有面方向不一致');
  });

  test('fails closed for two interpenetrating closed tetrahedra', () => {
    const result = repairMeshSafe(interpenetratingTetrahedra());

    expect(result.after.inspection).toMatchObject({ boundaryEdgeCount: 0, nonManifoldEdgeCount: 0 });
    expect(result.after.selfIntersectionCount).toBeGreaterThan(0);
    expect(result.after.selfIntersectionAnalysisComplete).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('仍有三維自相交');
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

  test('reports the exact 0.5 percent axis and 1 percent volume boundaries', () => {
    const axisBoundary = compareMeshes(tetrahedron(), transformMesh(tetrahedron(), [1.005, 1, 1]));
    const volumeScale = Math.cbrt(1.01);
    const volumeBoundary = compareMeshes(
      tetrahedron(),
      transformMesh(tetrahedron(), [volumeScale, volumeScale, volumeScale]),
    );

    expect(axisBoundary.axisChangePercent).toEqual([
      expect.closeTo(0.5, 12),
      0,
      0,
    ]);
    expect(axisBoundary.axisChangePercent[0]).toBeLessThanOrEqual(0.5);
    expect(volumeBoundary.volumeChangePercent).toBeCloseTo(1, 12);
    expect(volumeBoundary.volumeChangePercent).toBeLessThanOrEqual(1);
    expect(volumeBoundary.axisChangePercent.every((change) => change < 0.5)).toBe(true);
  });

  test('reports infinite drift from zero size and zero volume to a solid', () => {
    const comparison = compareMeshes(coplanarTetrahedron(), tetrahedron());

    expect(comparison.beforeSize).toEqual([1, 1, 0]);
    expect(comparison.beforeAbsoluteVolume).toBe(0);
    expect(comparison.axisChangePercent[2]).toBe(Number.POSITIVE_INFINITY);
    expect(comparison.volumeChangePercent).toBe(Number.POSITIVE_INFINITY);
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

function tetrahedronWithSameWindingDuplicate(): TriangleMesh {
  const mesh = tetrahedron();
  return {
    positions: mesh.positions.slice(),
    indices: new Uint32Array([...mesh.indices, 0, 2, 1]),
  };
}

function coplanarTetrahedron(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]),
    indices: tetrahedron().indices.slice(),
  };
}

function withUnreferencedVertex(mesh: TriangleMesh, vertex: readonly [number, number, number]): TriangleMesh {
  return {
    positions: new Float64Array([...mesh.positions, ...vertex]),
    indices: mesh.indices.slice(),
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

function tetrahedronWithSplitOrigin(originalX: number, splitX: number): TriangleMesh {
  return {
    positions: new Float64Array([
      originalX, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      splitX, 0, 0,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 4, 3,
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
