import { describe, expect, test } from 'vitest';
import { repairMeshAdvanced } from './advanced-repair';
import { repairMeshSafe } from './repair-mesh';
import type { TriangleMesh } from './types';
import { interpenetratingTetrahedra } from '../../test/mesh-builders';

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

  test('rejects a planar boundary loop whose non-adjacent edges intersect', () => {
    const original = selfIntersectingBoundaryMesh();

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.changes.filledHoles).toBe(0);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('缺口邊界自相交，無法安全補合');
  });

  test('rejects mixed directed boundary edges instead of majority-voting cap orientation', () => {
    const original = mixedDirectionBoundaryMesh();

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.changes.filledHoles).toBe(0);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('缺口邊界方向不一致，無法安全補合');
  });

  test('does not accept a closed result with same-direction incident faces', () => {
    const original = tetrahedronWithOneReversedFace();

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.after.inspection).toMatchObject({ boundaryEdgeCount: 0, nonManifoldEdgeCount: 0 });
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('修復結果仍有面方向不一致');
  });

  test('does not accept interpenetrating closed shells that topology-only checks would pass', () => {
    const original = interpenetratingTetrahedra();

    const result = repairMeshAdvanced(original, repairMeshSafe(original).mesh);

    expect(result.after.selfIntersectionCount).toBeGreaterThan(0);
    expect(result.after.selfIntersectionAnalysisComplete).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.blockingReasons).toContain('仍有三維自相交');
  });

  test('triangulates the same legal hole at the origin and after a large translation', () => {
    const atOrigin = boxWithOneMissingTriangle(100, 0.5, 0.5);
    const translated = translateMesh(atOrigin, [1e8, 1e8, 1e8]);

    const originResult = repairMeshAdvanced(atOrigin, repairMeshSafe(atOrigin).mesh);
    const translatedResult = repairMeshAdvanced(translated, repairMeshSafe(translated).mesh);

    expect(originResult.changes.filledHoles).toBe(1);
    expect(translatedResult.changes.filledHoles).toBe(1);
    expect(translatedResult.after.inspection.boundaryEdgeCount).toBe(0);
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

function selfIntersectingBoundaryMesh(): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let vertex = 0; vertex < 5; vertex += 1) {
    const angle = vertex * Math.PI * 2 / 5;
    positions.push(Math.cos(angle) * 0.1, Math.sin(angle) * 0.1, 0);
  }
  const apex = positions.length / 3;
  positions.push(0, 0, 100);
  const starOrder = [0, 2, 4, 1, 3];
  for (let index = 0; index < starOrder.length; index += 1) {
    indices.push(apex, starOrder[index], starOrder[(index + 1) % starOrder.length]);
  }
  for (let shell = 0; shell < 7; shell += 1) {
    const offset = positions.length / 3;
    const x = 10 + shell * 12;
    positions.push(
      x, 0, 0,
      x + 10, 0, 0,
      x, 10, 0,
      x, 0, 10,
    );
    indices.push(
      offset, offset + 2, offset + 1,
      offset, offset + 1, offset + 3,
      offset + 1, offset + 2, offset + 3,
      offset + 2, offset, offset + 3,
    );
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function mixedDirectionBoundaryMesh(): TriangleMesh {
  const box = boxWithOneMissingTriangle(100, 0.5, 0.5);
  const positions = [...box.positions];
  const indices = [...box.indices];
  [indices[16], indices[17]] = [indices[17], indices[16]];
  for (let shell = 0; shell < 7; shell += 1) {
    const offset = positions.length / 3;
    const x = 10 + shell * 12;
    positions.push(
      x, 20, 0,
      x + 10, 20, 0,
      x, 30, 0,
      x, 20, 10,
    );
    indices.push(
      offset, offset + 2, offset + 1,
      offset, offset + 1, offset + 3,
      offset + 1, offset + 2, offset + 3,
      offset + 2, offset, offset + 3,
    );
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function tetrahedronWithOneReversedFace(): TriangleMesh {
  const mesh = tetrahedron();
  const positions = new Float64Array([
    ...mesh.positions,
    -10, -10, -10,
    10, -10, -10,
    -10, 10, -10,
    -10, -10, 10,
  ]);
  const indices = new Uint32Array([
    ...mesh.indices,
    4, 6, 5,
    4, 5, 7,
    5, 6, 7,
    6, 4, 7,
  ]);
  [indices[4], indices[5]] = [indices[5], indices[4]];
  return { positions, indices };
}

function translateMesh(mesh: TriangleMesh, offset: readonly [number, number, number]): TriangleMesh {
  return {
    positions: new Float64Array(mesh.positions.map((value, index) => value + offset[index % 3])),
    indices: mesh.indices.slice(),
  };
}

function cloneMesh(mesh: TriangleMesh): TriangleMesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}
