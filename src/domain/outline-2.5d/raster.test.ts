import { describe, expect, test } from 'vitest';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineBudgets } from './types';
import { markLineSupercover, rasterProjectLayer, type ProjectedMesh } from './raster';

function occupied(mask: Uint8Array, width: number): string[] {
  return Array.from(mask.entries())
    .filter(([, value]) => value !== 0)
    .map(([index]) => `${index % width},${Math.floor(index / width)}`);
}

function componentCount(mask: Uint8Array, width: number, height: number): number {
  const visited = new Uint8Array(mask.length);
  let count = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    count += 1;
    const queue = [start];
    visited[start] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head], x = current % width, y = Math.floor(current / width);
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) if (next >= 0 && mask[next] && !visited[next]) {
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  return count;
}

describe('markLineSupercover', () => {
  test('marks exactly the cells intersected by an edge away from grid boundaries', () => {
    const mask = new Uint8Array(5 * 4);
    markLineSupercover(mask, 5, 4, 0.25, 1.25, 2.75, 1.25, Infinity);
    expect(occupied(mask, 5)).toEqual(['0,1', '1,1', '2,1']);
  });

  test('conservatively marks both sides of an edge on a cell boundary without bounds expansion', () => {
    const mask = new Uint8Array(5 * 4);
    markLineSupercover(mask, 5, 4, 0.25, 1, 2.75, 1, Infinity);
    expect(occupied(mask, 5)).toEqual(['0,0', '1,0', '2,0', '0,1', '1,1', '2,1']);
  });

  test('does not bridge geometrically separated edge components', () => {
    const width = 5, height = 5, mask = new Uint8Array(width * height);
    markLineSupercover(mask, width, height, 0.25, 1.25, 2.75, 1.25, Infinity);
    markLineSupercover(mask, width, height, 0.25, 3.25, 2.75, 3.25, Infinity);
    expect(componentCount(mask, width, height)).toBe(2);
    expect(occupied(mask, width).some((cell) => cell.endsWith(',2'))).toBe(false);
  });
});

function projectedFrame(open = false): ProjectedMesh {
  const rectangles = [
    [-6, -6, 6, -3], [-6, 3, 6, 6], [-6, -3, -3, 3],
    ...(open ? [] : [[3, -3, 6, 3]]),
  ];
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  for (const [x0, y0, x1, y1] of rectangles) {
    const offset = vertices.length;
    vertices.push([x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]);
    triangles.push([offset, offset + 1, offset + 2], [offset, offset + 2, offset + 3]);
  }
  return {
    vertices, triangles, minX: -6, minY: -6, maxX: 6, maxY: 6,
    planarDiameter: Math.hypot(12, 12),
  };
}

describe('rasterProjectLayer enclosed void evidence', () => {
  test('preserves one bounded pre-fill void while retaining the same filled exterior', () => {
    const raster = rasterProjectLayer(
      projectedFrame(), { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
      DEFAULT_OUTLINE_BUDGETS, Infinity,
    );

    expect(raster.enclosedVoids).toHaveLength(1);
    expect(raster.enclosedVoids[0].occupiedCellCount).toBeGreaterThan(1_000);
    expect(raster.enclosedVoids[0].outer.length).toBeGreaterThanOrEqual(4);
    expect(raster.occupiedCellCount).toBeGreaterThan(raster.enclosedVoids[0].occupiedCellCount);
  });

  test('does not misclassify an open gap as a projected hole', () => {
    const raster = rasterProjectLayer(
      projectedFrame(true), { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
      DEFAULT_OUTLINE_BUDGETS, Infinity,
    );

    expect(raster.enclosedVoids).toEqual([]);
  });

  test('checks the per-layer total raster-cell and absolute deadline budgets', () => {
    expect(() => rasterProjectLayer(
      projectedFrame(), { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
      { ...DEFAULT_OUTLINE_BUDGETS, maxRasterCellsTotal: 10 } as unknown as OutlineBudgets, Infinity,
    )).toThrow(/total raster cell budget/i);
    expect(() => rasterProjectLayer(
      projectedFrame(), { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
      DEFAULT_OUTLINE_BUDGETS, -1,
    )).toThrow(/runtime budget/i);
  });
});
