import { describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import {
  areFinishedCirclesPairwiseSeparated,
  circleLoop48,
  isCircleSafeThroughAllLayers,
  minimumMaterialClearanceMm,
  type ProtectedRegionLayer,
} from './protected-region';

function rectangle(minX: number, minY: number, maxX: number, maxY: number): readonly Point2[] {
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
}

function circle(center: Point2, radius: number): readonly Point2[] {
  return Array.from({ length: 48 }, (_, index): Point2 => {
    const angle = index * Math.PI * 2 / 48;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius];
  });
}

describe('protected material regions', () => {
  const layers: readonly ProtectedRegionLayer[] = [
    { exterior: rectangle(-10, -10, 10, 10), protected: [circle([0, 0], 2)] },
    { exterior: rectangle(-8, -8, 8, 8), protected: [rectangle(5, -1, 7, 1)] },
  ];

  it('measures the minimum common material thickness to every exterior and protected boundary', () => {
    expect(minimumMaterialClearanceMm([0, 4], layers)).toBeCloseTo(2, 10);
    expect(minimumMaterialClearanceMm([0, 0], layers)).toBeLessThan(0);
    expect(minimumMaterialClearanceMm([9, 0], layers)).toBeLessThan(0);
    expect(minimumMaterialClearanceMm([6, 0], layers)).toBeLessThan(0);
  });

  it('checks a physical circle envelope and requested web through every layer', () => {
    expect(isCircleSafeThroughAllLayers({ center: [0, 4], radiusMm: 1.5, clearanceMm: 0.5, layers }))
      .toBe(true);
    expect(isCircleSafeThroughAllLayers({ center: [0, 3.99], radiusMm: 1.5, clearanceMm: 0.5, layers }))
      .toBe(false);
    expect(isCircleSafeThroughAllLayers({ center: [7, 4], radiusMm: 1.5, clearanceMm: 0.5, layers }))
      .toBe(false);
  });

  it('checks finished-hole pair separation and preserves exact bounded cancellation', () => {
    expect(areFinishedCirclesPairwiseSeparated({
      centers: [[0, 0], [3.5, 0]], finishedDiameterMm: 3, minimumWebMm: 0.5,
    })).toBe(true);
    expect(areFinishedCirclesPairwiseSeparated({
      centers: [[0, 0], [3.49, 0]], finishedDiameterMm: 3, minimumWebMm: 0.5,
    })).toBe(false);

    const cancellation = new Error('pair scan cancelled');
    expect(() => areFinishedCirclesPairwiseSeparated({
      centers: [[0, 0], [4, 0], [0, 4]],
      finishedDiameterMm: 3,
      minimumWebMm: 0.5,
      checkpoint: () => { throw cancellation; },
    })).toThrow(cancellation);
    expect(areFinishedCirclesPairwiseSeparated({
      centers: [[0, 0], [4, 0], [0, 4], [-4, 0]],
      finishedDiameterMm: 3,
      minimumWebMm: 0.5,
    })).toBe(false);
  });

  it('creates one deterministic fixed 48-point circle without closing-point duplication', () => {
    const loop = circleLoop48([2, -3], 1.4);
    expect(loop).toHaveLength(48);
    expect(loop[0]).toEqual([3.4, -3]);
    expect(loop.at(-1)).not.toEqual(loop[0]);
    expect(loop.every(([x, y]) => Math.hypot(x - 2, y + 3) - 1.4 < 1e-12)).toBe(true);
  });

  it('polls the caller checkpoint inside bounded contour scans and fails an expired deadline', () => {
    const cancellation = new Error('protected scan cancelled');
    let calls = 0;
    expect(() => minimumMaterialClearanceMm([0, 4], [{
      exterior: circle([0, 0], 10),
      protected: [circle([0, 0], 2)],
    }], Infinity, () => {
      calls += 1;
      if (calls === 4) throw cancellation;
    })).toThrow(cancellation);

    const checkpoint = vi.fn();
    expect(() => minimumMaterialClearanceMm([0, 4], layers, Date.now() - 1, checkpoint))
      .toThrow(/runtime budget/i);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('rejects unbounded layer, protected-region, and point inputs before searching', () => {
    const base = { exterior: rectangle(-10, -10, 10, 10), protected: [] } as const;
    expect(() => minimumMaterialClearanceMm([0, 0], Array.from({ length: 25 }, () => base)))
      .toThrow(/24|bounded/i);
    expect(() => minimumMaterialClearanceMm([0, 0], [{
      ...base, protected: Array.from({ length: 5 }, () => rectangle(-1, -1, 1, 1)),
    }])).toThrow(/4|bounded/i);
    expect(() => minimumMaterialClearanceMm([0, 0], [{
      exterior: Array.from({ length: 4_097 }, (_, index): Point2 => [index, index % 2]), protected: [],
    }])).toThrow(/4096|bounded/i);
  });
});
