import { describe, expect, test } from 'vitest';
import type { Point2 } from '../decomposition/types';
import {
  CENTRAL_HOLE_OMISSION_WARNING,
  selectCentralHole,
  selectSharedCentralHole,
  type CentralHoleCandidate,
  type CentralHoleRequest,
} from './hole';

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
