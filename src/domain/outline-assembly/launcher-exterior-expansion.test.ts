import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point2, Polygon2 } from '../decomposition/types';
import { pointLocation, validatePolygon } from '../engraving/geometry';
import {
  constructRawMiterOffset,
  simpleMiterPolygonKernel,
} from '../layout/polygon-kernel';
import type { FeatureContour } from '../outline-features/types';
import {
  LauncherExteriorOffsetComplexityError,
  launcherExteriorOffsetAdapterTestSeam,
  resolveLauncherExteriorMiterOffset,
} from './launcher-exterior-offset-adapter';
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

function regularCycle(pointCount: number, radius = 10): readonly Point2[] {
  return Array.from({ length: pointCount }, (_, index): Point2 => {
    const angle = index * Math.PI * 2 / pointCount;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
}

function captureThrown(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

function collapsedNotchExterior(): FeatureContour {
  const outer: readonly Point2[] = [
    [0, 0],
    [10, 0],
    [10, 4],
    [6, 5],
    [10, 6],
    [10, 10],
    [0, 10],
  ];
  return {
    id: 'collapsed-notch',
    role: 'CUT_BLACK',
    outer,
    boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    areaMm2: 96,
  };
}

function collapsedMultiNotchExterior(): FeatureContour {
  const outer: readonly Point2[] = [
    [-6.271804108856543, 22.021065918753003],
    [-3.4710371721379083, 19.4749141580997],
    [2.003189113266693, 19.347606570067036],
    [5.695109166213985, 18.329145865805714],
    [7.222800222605965, 17.437992749577056],
    [8.877798867030613, 17.947223101707714],
    [11.29664303965125, 16.29222445728307],
    [15, -10],
    [5, -10],
    [5, -5],
    [1, -5],
    [1, -10],
    [-15, -10],
  ];
  return {
    id: 'collapsed-multi-notch',
    role: 'CUT_BLACK',
    outer,
    boundsMm: { minX: -15, minY: -10, maxX: 15, maxY: 22.021065918753003 },
    areaMm2: Math.abs(outer.reduce((sum, point, index) => {
      const next = outer[(index + 1) % outer.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2),
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

  it('clips a collapsed concave-notch loop into one exact outer miter contour', () => {
    const original = collapsedNotchExterior();
    const snapshot = structuredClone(original);
    const source = { points: original.outer };

    expect(() => simpleMiterPolygonKernel.offset(
      source,
      2.10,
    )).toThrow('Offset collapsed or self-intersected the polygon');

    const rawOffset = constructRawMiterOffset(source, 2.10);
    expect(Array.isArray(rawOffset)).toBe(true);
    const resolved = resolveLauncherExteriorMiterOffset(
      source,
      rawOffset,
      Infinity,
      () => undefined,
    );
    expect(validatePolygon(resolved)).toBe(true);
    expect(resolved.points.reduce((sum, point, index) => {
      const next = resolved.points[(index + 1) % resolved.points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)).toBeLessThan(0);

    const expanded = expandLauncherExterior(original, 2.1);

    expect(validatePolygon({ points: expanded.outer })).toBe(true);
    expect(expanded.outer).toHaveLength(4);
    expect(expanded.boundsMm).toEqual({ minX: -2.1, minY: -2.1, maxX: 12.1, maxY: 12.1 });
    expect(expanded.areaMm2).toBeCloseTo(14.2 ** 2, 10);
    expect(expanded.outer.every((point) => pointLocation(
      { points: expanded.outer },
      point,
    ) === 0)).toBe(true);
    expect(original.outer.every((point) => pointLocation(
      { points: expanded.outer },
      point,
    ) >= 0)).toBe(true);
    expect(original).toEqual(snapshot);
  });

  it('preserves signed traversal while splitting a collinear overlap', () => {
    const source: Polygon2 = {
      points: [[1, 1], [2, 1], [2, 2], [1, 2]],
    };
    const rawOffset: readonly Point2[] = [
      [-1, -1],
      [4, -1],
      [4, 4],
      [-1, 4],
      [-1, -1],
      [2, -1],
    ];

    const resolved = resolveLauncherExteriorMiterOffset(
      source,
      rawOffset,
      Infinity,
      () => undefined,
    );

    expect(new Set(resolved.points.map((point) => point.join(',')))).toEqual(new Set([
      '-1,-1',
      '4,-1',
      '4,4',
      '-1,4',
    ]));
    expect(resolved.points.reduce((sum, point, index) => {
      const next = resolved.points[(index + 1) % resolved.points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0)).toBeLessThan(0);
  });

  it('traces a collapsed multi-notch arrangement across a near-zero connector', () => {
    const original = collapsedMultiNotchExterior();
    const snapshot = structuredClone(original);

    const expanded = expandLauncherExterior(original, 5.74);

    expect(validatePolygon({ points: expanded.outer })).toBe(true);
    expect(expanded.outer).toHaveLength(9);
    expect(expanded.areaMm2).toBeCloseTo(1470.0823732768595, 9);
    expect(original.outer.every((point) => pointLocation(
      { points: expanded.outer },
      point,
    ) >= 0)).toBe(true);
    expect(expandLauncherExterior(original, 5.74)).toEqual(expanded);
    expect(original).toEqual(snapshot);
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

    const collision = new RangeError('Offset collapsed or self-intersected the polygon');
    let collisionThrown: unknown;
    let collisionRaised = false;
    try {
      expandLauncherExterior(collapsedNotchExterior(), 2.10, Infinity, () => {
        if (!collisionRaised && new Error().stack?.includes('offsetMitered')) {
          collisionRaised = true;
          throw collision;
        }
      });
    } catch (error) {
      collisionThrown = error;
    }
    expect(collisionRaised).toBe(true);
    expect(collisionThrown).toBe(collision);
  });

  it('bounds raw adapter input and propagates in-arrangement cancellation by identity', () => {
    const source = { points: collapsedNotchExterior().outer };
    const rawOffset = constructRawMiterOffset(source, 2.10);
    expect(() => resolveLauncherExteriorMiterOffset(
      source,
      Array.from({ length: 4_097 }, (_, index) => [index, index % 2] as Point2),
      Infinity,
      () => undefined,
    )).toThrow(/bounded finite geometry/i);

    let topologyFailure: unknown;
    try {
      resolveLauncherExteriorMiterOffset(
        source,
        [[100, 100], [110, 100], [100, 110]],
        Infinity,
        () => undefined,
      );
    } catch (error) {
      topologyFailure = error;
    }
    expect(topologyFailure).toMatchObject({
      name: 'LauncherExteriorOffsetTopologyError',
    });

    const cancellation = new Error('cancel half-edge arrangement');
    let calls = 0;
    let thrown: unknown;
    try {
      resolveLauncherExteriorMiterOffset(source, rawOffset, Infinity, () => {
        calls += 1;
        if (calls === 8) throw cancellation;
      });
    } catch (error) {
      thrown = error;
    }
    expect(calls).toBe(8);
    expect(thrown).toBe(cancellation);
  });

  it('polls exact cancellation and deadline failures from inside pair intersection splitting', () => {
    const source: Polygon2 = { points: squareExterior('source', 2).outer };
    const rawOffset = regularCycle(128);
    const cancellation = new Error('cancel pair intersection splitting');
    let cancellationReached = false;

    const cancellationThrown = captureThrown(() => resolveLauncherExteriorMiterOffset(
      source,
      rawOffset,
      Infinity,
      () => {
        if (!new Error().stack?.includes('splitAtPairIntersections')) return;
        cancellationReached = true;
        throw cancellation;
      },
    ));

    expect(cancellationReached).toBe(true);
    expect(cancellationThrown).toBe(cancellation);

    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (
      new Error().stack?.includes('splitAtPairIntersections') ? 2 : 0
    ));
    const deadlineThrown = captureThrown(() => resolveLauncherExteriorMiterOffset(
      source,
      rawOffset,
      1,
      () => undefined,
    ));
    nowSpy.mockRestore();

    expect(deadlineThrown).toMatchObject({
      name: 'RangeError',
      message: expect.stringMatching(/runtime budget/i),
    });
  });

  it('throws a typed non-recoverable bound when intersections exceed 4,096 pieces', () => {
    const source: Polygon2 = { points: squareExterior('source', 2).outer };
    const rawOffset: readonly Point2[] = [
      [-10, -10],
      [10, 10],
      [-10, 10],
      [10, -10],
      ...Array.from({ length: 4_092 }, (_, index): Point2 => [
        100 + index,
        100 + index % 2,
      ]),
    ];

    const thrown = captureThrown(() => resolveLauncherExteriorMiterOffset(
      source,
      rawOffset,
      Infinity,
      () => undefined,
    ));

    expect(thrown).toBeInstanceOf(LauncherExteriorOffsetComplexityError);
    expect(thrown).toMatchObject({
      name: 'LauncherExteriorOffsetComplexityError',
      message: 'Launcher exterior offset exceeded the 4096-point arrangement bound',
    });
  });

  it('throws the typed 4,096-point output bound for an oversized selected interface cycle', () => {
    const thrown = captureThrown(() => {
      launcherExteriorOffsetAdapterTestSeam.traceSelectedInterfaceCycle(
        regularCycle(4_097),
        Infinity,
        () => undefined,
      );
    });

    expect(thrown).toBeInstanceOf(LauncherExteriorOffsetComplexityError);
    expect(thrown).toMatchObject({
      name: 'LauncherExteriorOffsetComplexityError',
      message: 'Launcher exterior offset exceeded the 4096-point output bound',
    });
  });
});
