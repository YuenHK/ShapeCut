import { describe, expect, test } from 'vitest';
import type { Point2 } from '../decomposition/types';
import {
  CENTRAL_HOLE_OMISSION_WARNING,
  isStrictlyContainedLoop,
  selectCentralHole,
  selectSharedCentralHole,
  type CentralHoleCandidate,
  type CentralHoleRequest,
} from './hole';

function referenceStrictContainment(
  exterior: readonly Point2[],
  candidate: readonly Point2[],
  minimumClearance: number,
): boolean {
  if (!Number.isFinite(minimumClearance) || minimumClearance < 0) return false;
  const allPoints = [...exterior, ...candidate];
  const scale = allPoints.reduce((largest, [x, y]) => Math.max(largest, Math.abs(x), Math.abs(y)), 1);
  const areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  const cross = (a: Point2, b: Point2, point: Point2): number =>
    (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  const onSegment = (a: Point2, b: Point2, point: Point2): boolean =>
    point[0] >= Math.min(a[0], b[0]) - lengthTolerance
    && point[0] <= Math.max(a[0], b[0]) + lengthTolerance
    && point[1] >= Math.min(a[1], b[1]) - lengthTolerance
    && point[1] <= Math.max(a[1], b[1]) + lengthTolerance
    && Math.abs(cross(a, b, point)) <= areaTolerance;
  const location = (point: Point2): -1 | 0 | 1 => {
    const pointScale = exterior.reduce(
      (largest, [x, y]) => Math.max(largest, Math.abs(x), Math.abs(y)),
      Math.max(1, Math.abs(point[0]), Math.abs(point[1])),
    );
    const pointAreaTolerance = pointScale * pointScale * 64 * Number.EPSILON;
    const pointLengthTolerance = pointScale * 64 * Number.EPSILON;
    const pointOnSegment = (a: Point2, b: Point2): boolean =>
      point[0] >= Math.min(a[0], b[0]) - pointLengthTolerance
      && point[0] <= Math.max(a[0], b[0]) + pointLengthTolerance
      && point[1] >= Math.min(a[1], b[1]) - pointLengthTolerance
      && point[1] <= Math.max(a[1], b[1]) + pointLengthTolerance
      && Math.abs(cross(a, b, point)) <= pointAreaTolerance;
    let inside = false;
    for (let index = 0; index < exterior.length; index += 1) {
      const start = exterior[index], end = exterior[(index + 1) % exterior.length];
      if (pointOnSegment(start, end)) return 0;
      if ((start[1] > point[1]) !== (end[1] > point[1])) {
        const crossingX = start[0]
          + (point[1] - start[1]) * (end[0] - start[0]) / (end[1] - start[1]);
        if (crossingX > point[0]) inside = !inside;
      }
    }
    return inside ? 1 : -1;
  };
  const intersects = (a: Point2, b: Point2, c: Point2, d: Point2): boolean => {
    if (Math.max(a[0], b[0]) + lengthTolerance < Math.min(c[0], d[0])
      || Math.max(c[0], d[0]) + lengthTolerance < Math.min(a[0], b[0])
      || Math.max(a[1], b[1]) + lengthTolerance < Math.min(c[1], d[1])
      || Math.max(c[1], d[1]) + lengthTolerance < Math.min(a[1], b[1])) return false;
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (((abC > areaTolerance && abD < -areaTolerance) || (abC < -areaTolerance && abD > areaTolerance))
      && ((cdA > areaTolerance && cdB < -areaTolerance) || (cdA < -areaTolerance && cdB > areaTolerance))) return true;
    return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  };
  const segmentDistance = (point: Point2, start: Point2, end: Point2): number => {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const denominator = dx * dx + dy * dy;
    const parameter = denominator === 0 ? 0 : Math.max(0, Math.min(1,
      ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator,
    ));
    return Math.hypot(point[0] - (start[0] + parameter * dx), point[1] - (start[1] + parameter * dy));
  };

  for (let index = 0; index < candidate.length; index += 1) {
    const start = candidate[index], end = candidate[(index + 1) % candidate.length];
    if (location(start) !== 1
      || location([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]) !== 1) return false;
    for (let outerIndex = 0; outerIndex < exterior.length; outerIndex += 1) {
      if (intersects(start, end, exterior[outerIndex], exterior[(outerIndex + 1) % exterior.length])) return false;
    }
  }
  let clearance = Infinity;
  for (let innerIndex = 0; innerIndex < candidate.length; innerIndex += 1) {
    const innerStart = candidate[innerIndex], innerEnd = candidate[(innerIndex + 1) % candidate.length];
    for (let outerIndex = 0; outerIndex < exterior.length; outerIndex += 1) {
      const outerStart = exterior[outerIndex], outerEnd = exterior[(outerIndex + 1) % exterior.length];
      clearance = Math.min(clearance,
        segmentDistance(innerStart, outerStart, outerEnd),
        segmentDistance(innerEnd, outerStart, outerEnd),
        segmentDistance(outerStart, innerStart, innerEnd),
        segmentDistance(outerEnd, innerStart, innerEnd));
    }
  }
  return clearance + 1e-12 >= minimumClearance;
}

function square(size: number, cx = 0, cy = 0): readonly Point2[] {
  const half = size / 2;
  return [
    [cx - half, cy - half], [cx - half, cy + half],
    [cx + half, cy + half], [cx + half, cy - half],
  ];
}

function circularHole(diameter: number, axisDistance: number, y = 0): CentralHoleCandidate {
  const radius = diameter / 2;
  return {
    outer: Array.from({ length: 128 }, (_, index): Point2 => {
      const angle = index / 128 * Math.PI * 2;
      return [axisDistance + radius * Math.cos(angle), y + radius * Math.sin(angle)];
    }),
  };
}

const request = (
  exterior: readonly Point2[],
  candidates: readonly CentralHoleCandidate[],
): CentralHoleRequest => ({
  exterior,
  candidates,
  axisPoint: [0, 0],
  layerWidthMm: 20,
  planarDiameterMm: 20,
  cellSizeMm: 0.1,
});

describe('isStrictlyContainedLoop', () => {
  const concave: readonly Point2[] = [
    [-6, -6], [6, -6], [6, 6], [2, 6], [2, -1], [-2, -1], [-2, 6], [-6, 6],
  ];
  const cases: readonly (readonly [string, readonly Point2[], readonly Point2[], number])[] = [
    ['strict concave containment', concave, square(2, 0, -3), 0.5],
    ['edge crossing a concave notch', concave, [[-3, 0], [-3, 1], [3, 1], [3, 0]], 0],
    ['midpoint escaping a concave notch', concave, [[-3, 0], [3, 0], [0, -4]], 0],
    ['touching the exterior', square(10), square(2, 4), 0],
    ['crossing the exterior', square(10), square(4, 4), 0],
    ['clearance exactly accepted by the allowance', square(10), square(8), 1 + 1e-12],
    ['clearance just beyond the allowance', square(10), square(8), 1 + 2e-12],
    ['mixed coordinate scales', square(2e9, 3e12, -4e12), square(2e6, 3e12, -4e12), 1],
    ['empty candidate legacy behavior', square(10), [], 1],
    ['empty exterior', [], square(2), 0],
    ['degenerate candidate', square(10), [[0, 0], [0, 0], [0, 0]], 0],
  ];

  test.each(cases)('matches the independent reference for %s', (_name, exterior, candidate, clearance) => {
    expect(isStrictlyContainedLoop(exterior, candidate, clearance)).toBe(
      referenceStrictContainment(exterior, candidate, clearance),
    );
  });

  test('matches the reference after translation and loop reversal', () => {
    const translate = (points: readonly Point2[]): readonly Point2[] =>
      points.map(([x, y]) => [x + 12_345.5, y - 98_765.25] as const);
    const exterior = translate([...concave].reverse());
    const candidate = translate([...square(2, 0, -3)].reverse());
    expect(isStrictlyContainedLoop(exterior, candidate, 0.5)).toBe(
      referenceStrictContainment(exterior, candidate, 0.5),
    );
  });

  test('matches the reference over deterministic positions, scales, translations, and windings', () => {
    for (const scale of [1e-6, 1, 1e6]) {
      for (const [dx, dy] of [[0, 0], [1e9, -1e9]] as const) {
        const move = (points: readonly Point2[]): readonly Point2[] => points.map(([x, y]) =>
          [x * scale + dx, y * scale + dy] as const);
        for (const reverse of [false, true]) {
          const exterior = move(reverse ? [...concave].reverse() : concave);
          for (const [x, y] of [[0, -3], [0, 0], [-3, 2], [5.5, -5.5]] as const) {
            const original = square(1.25, x, y);
            const candidate = move(reverse ? [...original].reverse() : original);
            for (const clearance of [0, 0.1 * scale, 0.625 * scale, 0.625 * scale + 2e-12]) {
              expect(isStrictlyContainedLoop(exterior, candidate, clearance)).toBe(
                referenceStrictContainment(exterior, candidate, clearance),
              );
            }
          }
        }
      }
    }
  });

  test.each([Number.NaN, -1, Infinity])('preserves malformed clearance rejection for %s', (clearance) => {
    expect(isStrictlyContainedLoop(square(10), square(2), clearance)).toBe(false);
  });

  test('preserves checkpoint cancellation', () => {
    expect(() => isStrictlyContainedLoop(square(10), square(2), 0, Infinity, () => {
      throw new Error('cancelled');
    })).toThrow('cancelled');
  });

  test('prepares exterior coordinates once instead of rescanning them for every point tolerance', () => {
    let coordinateReads = 0;
    const counted = (points: readonly Point2[]): readonly Point2[] => points.map(([x, y]) => {
      const point: number[] = [];
      Object.defineProperties(point, {
        0: { get: () => { coordinateReads += 1; return x; }, enumerable: true },
        1: { get: () => { coordinateReads += 1; return y; }, enumerable: true },
        length: { value: 2 },
      });
      return point as unknown as Point2;
    });
    const exterior = counted(Array.from({ length: 256 }, (_, index): Point2 => {
      const angle = index / 256 * Math.PI * 2;
      return [10 * Math.cos(angle), 10 * Math.sin(angle)];
    }));

    expect(isStrictlyContainedLoop(exterior, square(2), 0.1)).toBe(true);
    expect(coordinateReads).toBeLessThan(40_000);
  });
});

describe('selectCentralHole', () => {
  test('chooses the greatest-area near-axis hole and ignores a remote larger decoration', () => {
    const selection = selectCentralHole({
      candidates: [circularHole(8, 9), circularHole(3, 0.1), circularHole(4, 0.2)],
      exterior: square(30), axisPoint: [0, 0], layerWidthMm: 30, planarDiameterMm: Math.hypot(30, 30),
      cellSizeMm: 0.1, deadline: Infinity,
    });

    expect(selection.hole?.equivalentDiameterMm).toBeCloseTo(4, 2);
    expect(selection.hole?.axisDistanceMm).toBeCloseTo(0.2, 2);
    expect(selection.warning).toBeUndefined();
  });

  test.each([
    [30, 0.49],
    [100, 0.99],
  ])('omits a micro-hole below max(0.5 mm, one percent of %s mm)', (layerWidthMm, diameter) => {
    const selection = selectCentralHole({
      candidates: [circularHole(diameter, 0)], exterior: square(layerWidthMm), axisPoint: [0, 0],
      layerWidthMm, planarDiameterMm: Math.hypot(layerWidthMm, layerWidthMm), cellSizeMm: 0.05,
      deadline: Infinity,
    });

    expect(selection.hole).toBeUndefined();
    expect(selection.warning).toMatch(/reliable central axle hole/i);
    expect(selection.omissionReason).toBe('NO_RELIABLE_CENTRAL_HOLE');
  });

  test('uses the exact central equivalence band and lowest-min-X/Y deterministic tie break', () => {
    const withinBand = selectCentralHole({
      candidates: [circularHole(2, 0.1), circularHole(4, 0.7)],
      exterior: square(30), axisPoint: [0, 0], layerWidthMm: 30, planarDiameterMm: 30,
      cellSizeMm: 0.05, deadline: Infinity,
    });
    const outsideBand = selectCentralHole({
      candidates: [circularHole(2, 0.1), circularHole(4, 0.700_001)],
      exterior: square(30), axisPoint: [0, 0], layerWidthMm: 30, planarDiameterMm: 30,
      cellSizeMm: 0.05, deadline: Infinity,
    });
    const left = circularHole(3, -0.2, 0);
    const down = circularHole(3, 0, -0.2);
    const tie = selectCentralHole({
      candidates: [down, left], exterior: square(30), axisPoint: [0, 0], layerWidthMm: 30,
      planarDiameterMm: 30, cellSizeMm: 0.05, deadline: Infinity,
    });

    expect(withinBand.hole?.equivalentDiameterMm).toBeCloseTo(4, 2);
    expect(outsideBand.hole?.equivalentDiameterMm).toBeCloseTo(2, 2);
    expect(Math.min(...tie.hole!.outer.map(([x]) => x))).toBeLessThan(-1.69);
  });

  test('rejects open, non-simple, touching, and insufficient-clearance candidates without failing the exterior', () => {
    const invalid: readonly CentralHoleCandidate[] = [
      { outer: square(2), closed: false },
      { outer: [[-1, -1], [1, 1], [-1, 1], [1, -1]] },
      { outer: square(2, 9, 0) },
      { outer: square(2, 8.8, 0) },
    ];
    const selection = selectCentralHole({
      candidates: invalid, exterior: square(20), axisPoint: [0, 0], layerWidthMm: 20,
      planarDiameterMm: Math.hypot(20, 20), cellSizeMm: 0.25, deadline: Infinity,
    });

    expect(selection.hole).toBeUndefined();
    expect(selection.warning).toBe('No reliable central axle hole was found; the hole was omitted.');
    expect(selection.warning).not.toMatch(/[\\/@]|[\w.+-]+@[\w.-]+/);
  });

  test('rejects a candidate whose vertices are inside a concave exterior but whose edges cross its notch', () => {
    const concaveExterior: readonly Point2[] = [
      [-5, -5], [-5, 5], [-2, 5], [-2, -2],
      [2, -2], [2, 5], [5, 5], [5, -5],
    ];
    const crossingNotch: CentralHoleCandidate = {
      outer: [[-3, 0], [-3, 1], [3, 1], [3, 0]],
    };

    const selection = selectCentralHole({
      candidates: [crossingNotch], exterior: concaveExterior, axisPoint: [0, -4],
      layerWidthMm: 10, planarDiameterMm: Math.hypot(10, 10), cellSizeMm: 0.1,
      deadline: Infinity,
    });

    expect(selection).toEqual(expect.objectContaining({
      hole: undefined,
      omissionReason: 'NO_RELIABLE_CENTRAL_HOLE',
      warning: expect.stringMatching(/reliable central axle hole/i),
    }));
  });

  test('is translation invariant, triangle/candidate-order invariant, and emits a counter-clockwise hole', () => {
    const candidates = [circularHole(3, 0.1), circularHole(4, 0.2), circularHole(8, 9)];
    const first = selectCentralHole({
      candidates, exterior: square(30), axisPoint: [0, 0], layerWidthMm: 30,
      planarDiameterMm: Math.hypot(30, 30), cellSizeMm: 0.1, deadline: Infinity,
    });
    const dx = 40, dy = -17;
    const translate = (points: readonly Point2[]) => points.map(([x, y]): Point2 => [x + dx, y + dy]);
    const moved = selectCentralHole({
      candidates: [...candidates].reverse().map((candidate) => ({ ...candidate, outer: translate(candidate.outer) })),
      exterior: translate(square(30)), axisPoint: [dx, dy], layerWidthMm: 30,
      planarDiameterMm: Math.hypot(30, 30), cellSizeMm: 0.1, deadline: Infinity,
    });
    const signedArea = (points: readonly Point2[]) => points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2;

    expect(moved.hole?.equivalentDiameterMm).toBeCloseTo(first.hole!.equivalentDiameterMm, 10);
    expect(moved.hole?.axisDistanceMm).toBeCloseTo(first.hole!.axisDistanceMm, 10);
    expect(signedArea(first.hole!.outer)).toBeGreaterThan(0);
  });

  test('omits a no-hole layer with one bounded sanitized reason', () => {
    const selection = selectCentralHole({
      candidates: [], exterior: square(20), axisPoint: [0, 0], layerWidthMm: 20,
      planarDiameterMm: Math.hypot(20, 20), cellSizeMm: 0, deadline: Infinity,
    });

    expect(selection).toEqual({
      hole: undefined,
      omissionReason: 'NO_RELIABLE_CENTRAL_HOLE',
      warning: 'No reliable central axle hole was found; the hole was omitted.',
    });
  });
});

describe('selectSharedCentralHole', () => {
  test('keeps each source central reliability band before comparing globally safe candidates', () => {
    const exterior = square(30);
    const result = selectSharedCentralHole([
      {
        ...request(exterior, [circularHole(8, 9), circularHole(4, 0.2)]),
        layerWidthMm: 30,
        planarDiameterMm: Math.hypot(30, 30),
      },
      {
        ...request(exterior, [circularHole(7, 8), circularHole(3, 0.1)]),
        layerWidthMm: 30,
        planarDiameterMm: Math.hypot(30, 30),
      },
    ]);

    expect(result[0].hole?.equivalentDiameterMm).toBeCloseTo(4, 2);
    expect(result[1]).toEqual(result[0]);
  });

  test('recenters offset source evidence on the first request axis before shared containment', () => {
    const exterior = square(40);
    const result = selectSharedCentralHole([
      { ...request(exterior, []), axisPoint: [2, -3] },
      {
        ...request(exterior, [{ outer: square(4, 6.25, 4.75) }]),
        axisPoint: [6, 5],
      },
    ]);

    expect(result[0].hole).toMatchObject({
      boundsMm: { minX: 0, minY: -5, maxX: 4, maxY: -1 },
      areaMm2: 16,
      axisDistanceMm: 0,
    });
    expect(result[0].hole?.equivalentDiameterMm).toBeCloseTo(2 * Math.sqrt(16 / Math.PI), 10);
    expect(result[0].hole?.outer).toEqual([
      [4, -5], [4, -1], [0, -1], [0, -5],
    ]);
    expect(result[1]).toEqual(result[0]);
  });

  test('copies the exact largest globally safe contour to every layer', () => {
    const outer = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
    const large = { outer: [[-3, -3], [3, -3], [3, 3], [-3, 3]] as const };
    const small = { outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const };
    const result = selectSharedCentralHole([
      request(outer, [small, large]),
      request(outer, [large]),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].hole?.outer).toEqual(large.outer);
    expect(result[1]).toEqual(result[0]);
  });

  test('rejects a larger candidate that cannot fit every layer', () => {
    const wide = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
    const narrow = [[-2, -2], [2, -2], [2, 2], [-2, 2]] as const;
    const large = { outer: [[-3, -3], [3, -3], [3, 3], [-3, 3]] as const };
    const common = { outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const };
    const result = selectSharedCentralHole([
      request(wide, [large, common]),
      request(narrow, [common]),
    ]);
    expect(result.every((selection) => selection.hole?.outer === result[0].hole?.outer)).toBe(true);
    expect(result[0].hole?.outer).toEqual(common.outer);
  });

  test('omits the central cut from every layer when no shared candidate is safe', () => {
    const wide = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
    const narrow = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    const candidate = { outer: [[-2, -2], [2, -2], [2, 2], [-2, 2]] as const };
    expect(selectSharedCentralHole([
      request(wide, [candidate]),
      request(narrow, []),
    ])).toEqual([
      { hole: undefined, omissionReason: 'NO_RELIABLE_CENTRAL_HOLE', warning: CENTRAL_HOLE_OMISSION_WARNING },
      { hole: undefined, omissionReason: 'NO_RELIABLE_CENTRAL_HOLE', warning: CENTRAL_HOLE_OMISSION_WARNING },
    ]);
  });
});
