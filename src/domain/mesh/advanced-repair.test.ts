import { describe, expect, test } from 'vitest';
import { repairMeshAdvanced } from './advanced-repair';
import { repairMeshSafe } from './repair-mesh';
import type { TriangleMesh } from './types';

describe('bounded advanced mesh repair', () => {
  test('splits a non-manifold shared edge into independent closed manifold sheets', () => {
    const original = tetrahedraSharingOneEdge();
    const safe = repairMeshSafe(original).mesh;
    const originalSnapshot = cloneMesh(original);
    const safeSnapshot = cloneMesh(safe);

    const result = repairMeshAdvanced(original, safe);

    expect(result.mode).toBe('advanced');
    expect(result.changes.splitVertices).toBe(2);
    expect(result.after.inspection).toMatchObject({
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      invertedVolume: false,
    });
    expect(result.accepted).toBe(true);
    expect(original).toEqual(originalSnapshot);
    expect(safe).toEqual(safeSnapshot);
    expect(result.mesh.positions).not.toBe(original.positions);
    expect(result.mesh.positions).not.toBe(safe.positions);
    expect(result.mesh.indices).not.toBe(original.indices);
    expect(result.mesh.indices).not.toBe(safe.indices);
  });

  test('removes exact coincident faces before splitting topology', () => {
    const original = coincidentTetrahedronShells();
    const safe = repairMeshSafe(original).mesh;

    const result = repairMeshAdvanced(original, safe);

    expect(result.changes.removedDuplicate).toBe(4);
    expect(result.after.duplicateTriangleCount).toBe(0);
    expect(result.after.inspection.nonManifoldEdgeCount).toBe(0);
  });

  test('fills one planar boundary loop within two percent of the original longest edge', () => {
    const original = boxWithOneMissingTriangle(100, 0.5, 0.5);

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.changes.filledHoles).toBe(1);
    expect(result.after.inspection.boundaryEdgeCount).toBe(0);
  });

  test('leaves an oversized boundary loop blocking with a concrete reason', () => {
    const original = boxWithOneMissingTriangle(100, 1, 1);
    const safe = repairMeshSafe(original).mesh;
    const safeSnapshot = cloneMesh(safe);

    const result = repairMeshAdvanced(original, safe);

    expect(result.changes.filledHoles).toBe(0);
    expect(result.after.inspection.boundaryEdgeCount).toBe(3);
    expect(result.blockingReasons).toContain('缺口超出自動補合上限');
    expect(safe).toEqual(safeSnapshot);
  });

  test('fails closed when one connected surface fan cannot be split safely', () => {
    const original = connectedThreeFaceFan();
    const safe = repairMeshSafe(original).mesh;

    const result = repairMeshAdvanced(original, safe);

    expect(result.changes.splitVertices).toBe(0);
    expect(result.after.inspection.nonManifoldEdgeCount).toBe(1);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('非流形面扇無法在限制內安全拆分');
  });

  test('throws before a permitted hole fill would exceed the triangle growth limit', () => {
    const original = tallOpenTetrahedron();

    expect(() => repairMeshAdvanced(original, repairMeshSafe(original).mesh))
      .toThrow(/triangle.*limit/i);
  });

  test('fills bounded topology but rejects excessive volume drift', () => {
    const original = boxWithOneMissingTriangle(100, 0.5, 0.5);

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.changes.filledHoles).toBe(1);
    expect(result.comparison.volumeChangePercent).toBeGreaterThan(1);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('體積變化超過 1%');
  });

  test('reorients a closed connected shell with negative signed volume', () => {
    const original = reverseWinding(tetrahedron());

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.before.inspection.invertedVolume).toBe(true);
    expect(result.after.inspection.invertedVolume).toBe(false);
    expect(result.comparison.volumeChangePercent).toBeCloseTo(0, 12);
    expect(result.accepted).toBe(true);
  });
});

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

function tetrahedraSharingOneEdge(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      0, -1, 0,
      0, 0, -1,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 0, 3,
      0, 4, 1,
      0, 1, 5,
      1, 4, 5,
      4, 0, 5,
    ]),
  };
}

function coincidentTetrahedronShells(): TriangleMesh {
  const shell = tetrahedron();
  return {
    positions: new Float64Array([...shell.positions, ...shell.positions]),
    indices: new Uint32Array([
      ...shell.indices,
      ...Array.from(shell.indices, (index) => index + 4),
    ]),
  };
}

function boxWithOneMissingTriangle(length: number, width: number, height: number): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      length, 0, 0,
      length, width, 0,
      0, width, 0,
      0, 0, height,
      length, 0, height,
      length, width, height,
      0, width, height,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2,
      0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ]),
  };
}

function connectedThreeFaceFan(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, -1, 1,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 1, 2,
      1, 0, 3,
      0, 1, 4,
      0, 2, 3,
      1, 3, 4,
    ]),
  };
}

function tallOpenTetrahedron(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      0.001, 0, 0,
      0, 0.001, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 1, 3,
      1, 2, 3,
      2, 0, 3,
    ]),
  };
}

function reverseWinding(mesh: TriangleMesh): TriangleMesh {
  const indices = mesh.indices.slice();
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    [indices[offset + 1], indices[offset + 2]] = [indices[offset + 2], indices[offset + 1]];
  }
  return { positions: mesh.positions.slice(), indices };
}

function cloneMesh(mesh: TriangleMesh): TriangleMesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}
