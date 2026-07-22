import { describe, expect, test } from 'vitest';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineBudgets } from './types';
import {
  createOutlineAxisBasis,
  markLineSupercover,
  projectMesh,
  projectPointToOutlineBasis,
  rasterProjectLayer,
  type ProjectedMesh,
} from './raster';
import type { TriangleMesh } from '../mesh/types';

describe('deterministic outline axis basis', () => {
  test.each([
    ['X', [1, 0, 0] as const],
    ['Y', [0, 1, 0] as const],
    ['Z', [0, 0, 1] as const],
    ['oblique', [1, 2, 3] as const],
  ])('projects a translated point consistently for %s axis', (_label, direction) => {
    const origin = [17, -11, 23] as const;
    const basis = createOutlineAxisBasis({ origin, direction });
    const display = [4, 7, -5] as const;
    const point = [
      origin[0] + basis.planeX[0] * display[0] + basis.axial[0] * display[1] + basis.planeY[0] * display[2],
      origin[1] + basis.planeX[1] * display[0] + basis.axial[1] * display[1] + basis.planeY[1] * display[2],
      origin[2] + basis.planeX[2] * display[0] + basis.axial[2] * display[1] + basis.planeY[2] * display[2],
    ] as const;

    const [planeX, planeY, axial] = projectPointToOutlineBasis(point, basis);
    expect([planeX, axial, planeY]).toEqual(expect.arrayContaining([
      expect.closeTo(display[0], 10),
      expect.closeTo(display[1], 10),
      expect.closeTo(display[2], 10),
    ]));
  });
});

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

function projectedFrame(open = false, island = false): ProjectedMesh {
  const rectangles = [
    [-6, -6, 6, -3], [-6, 3, 6, 6], [-6, -3, -3, 3],
    ...(open ? [] : [[3, -3, 6, 3]]),
    ...(island ? [[-1, -1, 1, 1]] : []),
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

  test('omits a multiply-connected void surrounding an occupied island', () => {
    const raster = rasterProjectLayer(
      projectedFrame(false, true), { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
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

  test('propagates the original cancellation from inside mesh projection', () => {
    const mesh: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const cancellation = new Error('projection cancelled');
    let calls = 0;
    let caught: unknown;
    try {
      projectMesh(mesh, {
        axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
        source: 'candidate',
      }, Infinity, () => {
        calls += 1;
        if (calls === 2) throw cancellation;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancellation);
    expect(calls).toBe(2);
  });

  test('propagates the original cancellation from inside raster work', () => {
    const cancellation = new RangeError('raster cancelled');
    let calls = 0;
    let caught: unknown;
    try {
      rasterProjectLayer(
        projectedFrame(), { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
        DEFAULT_OUTLINE_BUDGETS, Infinity, () => {
          calls += 1;
          if (calls === 4) throw cancellation;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancellation);
    expect(calls).toBe(4);
  });

  test('bounds polling through late source-evidence point preparation', () => {
    const segmentCount = 1_024;
    const rawVertices: [number, number, number][] = [[0, 0, 0]];
    for (let index = 0; index < segmentCount; index += 1) {
      const angle = index * Math.PI * 2 / segmentCount;
      rawVertices.push([Math.cos(angle) * 10, Math.sin(angle) * 10, 0]);
    }
    const triangles = Array.from({ length: segmentCount }, (_, index) => [
      0, index + 1, (index + 1) % segmentCount + 1,
    ] as const);
    let vertexReads = 0;
    const vertices = new Proxy(rawVertices, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) vertexReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const projected: ProjectedMesh = {
      vertices, triangles, minX: -10, minY: -10, maxX: 10, maxY: 10, planarDiameter: Math.hypot(20, 20),
    };
    const firstPassReads = segmentCount * 3;
    let lastEvidenceReads = firstPassReads;
    const cancellation = new Error('source evidence cancelled');
    let caught: unknown;
    try {
      rasterProjectLayer(
        projected, { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
        DEFAULT_OUTLINE_BUDGETS, Infinity, () => {
          if (vertexReads <= firstPassReads) return;
          const interval = vertexReads - lastEvidenceReads;
          if (interval > 256) throw new Error(`source evidence checkpoint interval ${interval}`);
          lastEvidenceReads = vertexReads;
          if (vertexReads >= firstPassReads + 768) throw cancellation;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancellation);
  });
});
