import { describe, expect, test } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineAxisSelection, type OutlineLayerSpec } from './types';
import { extractExactContours, extractProjectedContours } from './extract';
import { validateOutlineLayer } from './validate';

const selection: OutlineAxisSelection = {
  source: 'candidate',
  axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
};
const specs: readonly OutlineLayerSpec[] = [{ index: 0, zStart: -0.5, zEnd: 0.5, zMid: 0 }];

function mesh(positions: readonly number[], indices: readonly number[]): TriangleMesh {
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function box(cx: number, cy: number, width: number, height: number, depth = 2, omitFace = -1): TriangleMesh {
  const x0 = cx - width / 2, x1 = cx + width / 2;
  const y0 = cy - height / 2, y1 = cy + height / 2;
  const z0 = -depth / 2, z1 = depth / 2;
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const faces = [
    [0, 2, 1, 0, 3, 2], [4, 5, 6, 4, 6, 7],
    [0, 1, 5, 0, 5, 4], [1, 2, 6, 1, 6, 5],
    [2, 3, 7, 2, 7, 6], [3, 0, 4, 3, 4, 7],
  ];
  return mesh(positions, faces.filter((_, index) => index !== omitFace).flat());
}

function combine(...meshes: readonly TriangleMesh[]): TriangleMesh {
  const positions: number[] = [], indices: number[] = [];
  for (const part of meshes) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    indices.push(...Array.from(part.indices, (index) => index + offset));
  }
  return mesh(positions, indices);
}

function sheet(cx: number, cy: number, width: number, height: number): TriangleMesh {
  const x0 = cx - width / 2, x1 = cx + width / 2, y0 = cy - height / 2, y1 = cy + height / 2;
  return mesh([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], [0, 1, 2, 0, 2, 3]);
}

function reverseTriangleOrder(value: TriangleMesh): TriangleMesh {
  const triangles: number[][] = [];
  for (let index = 0; index < value.indices.length; index += 3) triangles.push(Array.from(value.indices.slice(index, index + 3)));
  return mesh(Array.from(value.positions), triangles.reverse().flat());
}

function bounds(points: readonly (readonly [number, number])[]) {
  return {
    minX: Math.min(...points.map(([x]) => x)), maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)), maxY: Math.max(...points.map(([, y]) => y)),
  };
}

describe('extractProjectedContours', () => {
  test('keeps the largest component, fills holes, and is deterministic after triangle shuffling', () => {
    const twoComponents = combine(box(0, 0, 20, 12), box(40, 0, 4, 4));
    const first = extractProjectedContours(twoComponents, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    const shuffled = extractProjectedContours(reverseTriangleOrder(twoComponents), selection, specs, DEFAULT_OUTLINE_BUDGETS);

    expect(first).toEqual(shuffled);
    expect(first.removedComponentCount).toBeGreaterThanOrEqual(1);
    expect(first.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(first.removedComponentCount);
    expect(first.layers).toHaveLength(1);
    expect(first.layers[0].contour.holes).toEqual([]);
    expect(validateOutlineLayer(first.layers[0]).ok).toBe(true);
    const selected = bounds(first.layers[0].contour.outer);
    expect(selected.maxX - selected.minX).toBeLessThan(14);
    expect(selected.maxY - selected.minY).toBeLessThan(22);
  });

  test('fills an enclosed projected hole and returns only an exterior contour', () => {
    const frame = combine(
      sheet(0, -4.5, 12, 3), sheet(0, 4.5, 12, 3),
      sheet(-4.5, 0, 3, 7), sheet(4.5, 0, 3, 7),
    );
    const result = extractProjectedContours(frame, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers[0].contour.holes).toEqual([]);
    expect(result.layers[0].sourceAreaMm2).toBeGreaterThan(100);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test.each([
    ['open', box(0, 0, 10, 8, 2, 3)],
    ['self-intersecting', combine(box(-2, 0, 8, 3), box(2, 0, 8, 3))],
    ['overlapping', combine(box(-1, 0, 8, 8), box(1, 0, 8, 8))],
  ])('produces a valid exterior from %s mesh triangles', (_name, candidate) => {
    const result = extractProjectedContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].contour.holes).toEqual([]);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('fails closed for invalid meshes, empty masks, and raster budgets', () => {
    expect(() => extractProjectedContours(mesh([0, 0, Number.NaN], [0, 0, 0]), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow();
    expect(() => extractProjectedContours(box(0, 0, 2, 2), selection, [{ index: 0, zStart: 3, zEnd: 4, zMid: 3.5 }], DEFAULT_OUTLINE_BUDGETS)).toThrow(/empty/i);
    expect(() => extractProjectedContours(box(0, 0, 1_000, 20), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/budget/i);
  });

  test('rejects a layer midpoint outside its public interval', () => {
    expect(() => extractProjectedContours(box(0, 0, 2, 2), selection, [
      { index: 0, zStart: -0.5, zEnd: 0.5, zMid: 0.75 },
    ], DEFAULT_OUTLINE_BUDGETS)).toThrow(/midpoint|zMid|interval/i);
  });
});

describe('extractExactContours', () => {
  test('extracts the greatest closed slice deterministically', () => {
    const twoComponents = combine(box(0, 0, 20, 12), box(40, 0, 4, 4));
    const first = extractExactContours(twoComponents, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(first).toEqual(extractExactContours(reverseTriangleOrder(twoComponents), selection, specs, DEFAULT_OUTLINE_BUDGETS));
    expect(first.removedComponentCount).toBe(0);
    expect(first.layers[0].removedComponentCount).toBe(0);
    expect(first.layers[0].sourceAreaMm2).toBeCloseTo(240, 6);
    expect(first.layers[0].sourceBoundsMm).toEqual({ minX: -6, minY: -10, maxX: 6, maxY: 10 });
    expect(validateOutlineLayer(first.layers[0]).ok).toBe(true);
  });

  test('rejects open segment graphs', () => {
    expect(() => extractExactContours(box(0, 0, 10, 8, 2, 3), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/open/i);
  });

  test('accepts an exact plane through an ordinary shared vertex', () => {
    const tetrahedron = mesh([
      0, 1, 0,
      0, 0, 1,
      -1, -1, -1,
      1, -1, -1,
    ], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const result = extractExactContours(tetrahedron, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers).toHaveLength(1);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('accepts shared plane edges contributed from opposite sides exactly once', () => {
    const octahedron = mesh([
      1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0,
      0, 0, 1, 0, 0, -1,
    ], [
      4, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0,
      5, 1, 0, 5, 2, 1, 5, 3, 2, 5, 0, 3,
    ]);
    const result = extractExactContours(octahedron, selection, [
      { index: 0, zStart: 0, zMid: 0, zEnd: 0.5 },
    ], DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers[0].sourceAreaMm2).toBeCloseTo(2, 8);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('fails closed for a one-sided shared plane edge', () => {
    const foldedTangency = mesh([
      -1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1,
    ], [0, 1, 2, 1, 0, 3]);
    expect(() => extractExactContours(foldedTangency, selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/shared plane edge.*ambiguous/i);
  });

  test('fails closed for a coplanar triangle', () => {
    expect(() => extractExactContours(sheet(0, 0, 2, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/coplanar/i);
  });

  test('rejects a layer midpoint outside its public interval', () => {
    expect(() => extractExactContours(box(0, 0, 2, 2), selection, [
      { index: 0, zStart: -0.5, zEnd: 0.5, zMid: -0.75 },
    ], DEFAULT_OUTLINE_BUDGETS)).toThrow(/midpoint|zMid|interval/i);
  });

  test('fails closed when the runtime budget expires during bounded work', () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => { now += 10_001; return now; };
    try {
      expect(() => extractExactContours(box(0, 0, 20, 12), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/runtime budget/i);
      expect(() => extractProjectedContours(box(0, 0, 20, 12), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/runtime budget/i);
    } finally {
      Date.now = originalNow;
    }
  });
});
