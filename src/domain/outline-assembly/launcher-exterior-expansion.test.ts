import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point2, Polygon2 } from '../decomposition/types';
import { simpleMiterPolygonKernel } from '../layout/polygon-kernel';
import type { FeatureContour } from '../outline-features/types';
import {
  expandLauncherExterior,
  LAUNCHER_EXTERIOR_EXPANSION_MAX_MM,
  LAUNCHER_EXTERIOR_EXPANSION_MODE,
  LAUNCHER_EXTERIOR_EXPANSION_STEP_MM,
  LauncherExteriorExpansionExceededError,
  normalizeLauncherExteriorExpansionMm,
} from './launcher-exterior-expansion';

function squareExterior(id: string, sizeMm: number): FeatureContour {
  const halfSize = sizeMm / 2;
  const outer: readonly Point2[] = [
    [-halfSize, -halfSize],
    [-halfSize, halfSize],
    [halfSize, halfSize],
    [halfSize, -halfSize],
  ];
  return {
    id,
    role: 'CUT_BLACK',
    outer,
    boundsMm: { minX: -halfSize, minY: -halfSize, maxX: halfSize, maxY: halfSize },
    areaMm2: sizeMm * sizeMm,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('launcher exterior expansion contract', () => {
  it('publishes the shared uniform 0.01 mm grid and 6 mm bound', () => {
    expect(LAUNCHER_EXTERIOR_EXPANSION_MODE).toBe('shared-uniform');
    expect(LAUNCHER_EXTERIOR_EXPANSION_STEP_MM).toBe(0.01);
    expect(LAUNCHER_EXTERIOR_EXPANSION_MAX_MM).toBe(6);
  });

  it('normalizes finite non-negative requirements upward on the integer hundredth grid', () => {
    expect(normalizeLauncherExteriorExpansionMm(0)).toBe(0);
    expect(normalizeLauncherExteriorExpansionMm(0.001)).toBe(0.01);
    expect(normalizeLauncherExteriorExpansionMm(5.999)).toBe(6);
    expect(() => normalizeLauncherExteriorExpansionMm(6.001))
      .toThrow(LauncherExteriorExpansionExceededError);

    const thrown = (() => {
      try {
        normalizeLauncherExteriorExpansionMm(6.001);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toMatchObject({
      name: 'LauncherExteriorExpansionExceededError',
      code: 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
      requiredOffsetMm: 6.01,
    });
  });

  it.each([NaN, Infinity, -Infinity, -0.001])(
    'rejects the invalid required expansion %s',
    (requiredMm) => {
      expect(() => normalizeLauncherExteriorExpansionMm(requiredMm)).toThrow(RangeError);
    },
  );

  it('expands one contour, restores clockwise winding, and leaves the source byte-equivalent', () => {
    const original = squareExterior('top', 20);
    const originalPoints = structuredClone(original.outer);

    const expanded = expandLauncherExterior(original, 1);

    expect(expanded).toMatchObject({ id: 'top', role: 'CUT_BLACK' });
    expect(expanded.boundsMm).toEqual({ minX: -11, minY: -11, maxX: 11, maxY: 11 });
    expect(expanded.areaMm2).toBeCloseTo(484, 10);
    expect(expanded.outer.reduce((sum, point, index) => {
      const next = expanded.outer[(index + 1) % expanded.outer.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)).toBeLessThan(0);
    expect(original.outer).toEqual(originalPoints);
  });

  it('normalizes the supplied offset before expanding', () => {
    const expanded = expandLauncherExterior(squareExterior('top', 20), 0.001);
    expect(expanded.boundsMm).toEqual({
      minX: -10.01,
      minY: -10.01,
      maxX: 10.01,
      maxY: 10.01,
    });
  });

  it.each([NaN, Infinity, -0.01, 6.001])(
    'rejects invalid offset %s without mutating the source',
    (offsetMm) => {
      const original = squareExterior('top', 20);
      const snapshot = structuredClone(original);
      expect(() => expandLauncherExterior(original, offsetMm)).toThrow(RangeError);
      expect(original).toEqual(snapshot);
    },
  );

  it('rejects invalid source geometry without returning partial geometry', () => {
    const invalid: FeatureContour = {
      ...squareExterior('invalid', 20),
      outer: [[-10, -10], [NaN, 10], [10, 10], [10, -10]],
    };
    const snapshot = structuredClone(invalid);
    expect(() => expandLauncherExterior(invalid, 1)).toThrow(RangeError);
    expect(invalid.outer[0]).toEqual(snapshot.outer[0]);
    expect(Number.isNaN(invalid.outer[1][0])).toBe(true);
  });

  it.each([
    { name: 'collapsed', output: [] as Polygon2[] },
    {
      name: 'multi-polygon',
      output: [
        { points: squareExterior('first', 22).outer },
        { points: squareExterior('second', 22).outer },
      ] as Polygon2[],
    },
    {
      name: 'non-simple',
      output: [{ points: [[-11, -11], [11, 11], [-11, 11], [11, -11]] }],
    } as { name: string; output: Polygon2[] },
  ])('rejects $name kernel output without mutating the source', ({ output }) => {
    const original = squareExterior('top', 20);
    const snapshot = structuredClone(original);
    vi.spyOn(simpleMiterPolygonKernel, 'offset').mockReturnValueOnce(output);

    expect(() => expandLauncherExterior(original, 1)).toThrow(RangeError);
    expect(original).toEqual(snapshot);
  });

  it('checks the absolute deadline and propagates caller cancellation by identity', () => {
    const checkpoint = vi.fn();
    expect(() => expandLauncherExterior(
      squareExterior('top', 20),
      1,
      Date.now() - 1,
      checkpoint,
    )).toThrow(/runtime budget/i);
    expect(checkpoint).toHaveBeenCalled();

    const cancellation = new Error('cancel exterior expansion');
    let calls = 0;
    let thrown: unknown;
    try {
      expandLauncherExterior(squareExterior('top', 20), 1, Infinity, () => {
        calls += 1;
        if (calls === 4) throw cancellation;
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(4);
    expect(thrown).toBe(cancellation);
  });
});
