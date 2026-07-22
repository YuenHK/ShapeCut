import { describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { ManufacturingGeometryProfile } from '../materials/manufacturing-profile';
import type { FeatureContour } from '../outline-features/types';
import { featureEvidenceFingerprint, validateAutomaticColoredResult } from '../outline-features/types';
import { coloredResult } from '../../export/colored-outline-test-fixture';
import {
  FASTENER_ANGULAR_CANDIDATES,
  FASTENER_OMISSION_WARNING,
  FASTENER_SEARCH_RESOLUTION_MM,
  fastenerPatternIntervalUpperBound,
  materializeFastenerHoles,
  planFastenerHoles,
  shouldPruneFastenerSingleCell,
  type FastenerPlan,
  type FastenerPlanningLayer,
} from './fasteners';
import { isCircleSafeThroughAllLayers, type ProtectedRegionLayer } from './protected-region';

function contour(id: string, outer: readonly Point2[]): FeatureContour {
  let twiceArea = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < outer.length; index += 1) {
    const point = outer[index], next = outer[(index + 1) % outer.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  return { id, role: 'CUT_BLACK', outer, boundsMm: { minX, minY, maxX, maxY }, areaMm2: Math.abs(twiceArea / 2) };
}

function rectangle(id: string, minX: number, minY: number, maxX: number, maxY: number): FeatureContour {
  return contour(id, [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]);
}

function longTail(
  id: string,
  minX: number,
  chamberMaxX: number,
  chamberHalfHeight: number,
  neckHalfHeight = 1,
  tailMaxX = 1_000,
): FeatureContour {
  return contour(id, [
    [minX, -chamberHalfHeight], [chamberMaxX, -chamberHalfHeight],
    [chamberMaxX, -neckHalfHeight], [tailMaxX, -neckHalfHeight],
    [tailMaxX, neckHalfHeight], [chamberMaxX, neckHalfHeight],
    [chamberMaxX, chamberHalfHeight], [minX, chamberHalfHeight],
  ]);
}

function layer(id: string, exterior: FeatureContour, options: {
  readonly centralHole?: FeatureContour;
  readonly launcherCuts?: readonly FeatureContour[];
} = {}): FastenerPlanningLayer {
  return {
    id,
    exterior,
    centralHole: options.centralHole,
    launcherCuts: options.launcherCuts ?? [],
  };
}

const material: ManufacturingGeometryProfile = {
  id: 'plywood-3', name: 'Plywood 3 mm', thicknessMm: 3, kerfMm: 0.2,
  minFeatureMm: 0.8, minWebMm: 0.5,
  fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 },
};

function angleGap(left: Point2, right: Point2, axis: Point2 = [0, 0]): number {
  const first = Math.atan2(left[1] - axis[1], left[0] - axis[0]);
  const second = Math.atan2(right[1] - axis[1], right[0] - axis[0]);
  return ((second - first) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
}

function protectedLayers(layers: readonly FastenerPlanningLayer[]): readonly ProtectedRegionLayer[] {
  return layers.map((item) => ({
    exterior: item.exterior.outer,
    protected: [...(item.centralHole ? [item.centralHole.outer] : []), ...item.launcherCuts.map(({ outer }) => outer)],
  }));
}

describe('safe degrading fastener planning', () => {
  it('keeps refining a narrow potentially-safe radial window between unsafe samples', () => {
    expect(fastenerPatternIntervalUpperBound({
      lowMarginMm: -0.01,
      middleMarginMm: -0.01,
      highMarginMm: -0.01,
      widthMm: FASTENER_SEARCH_RESOLUTION_MM,
      lipschitz: 1,
    })).toBeGreaterThan(0);
  });

  it('does not prune an unresolved single-hole cell before the best point is safe', () => {
    expect(shouldPruneFastenerSingleCell({
      bestClearanceMm: 2,
      cellUpperClearanceMm: 2.2,
      requiredClearanceMm: 2.1,
    })).toBe(false);
    expect(shouldPruneFastenerSingleCell({
      bestClearanceMm: 2.1,
      cellUpperClearanceMm: 2.2,
      requiredClearanceMm: 2.1,
    })).toBe(true);
  });

  it('keeps shared geometry ID-free and materializes collision-free layer IDs without changing any point', () => {
    const plan = planFastenerHoles({
      layers: [layer('wide', rectangle('wide-exterior', -12, -12, 12, 12))],
      axisPoint: [0, 0], material,
    });
    expect(plan.count).toBe(3);
    expect(plan.holes.every((hole) => !Object.hasOwn(hole, 'id'))).toBe(true);

    const seed = coloredResult();
    const sourceLayers = seed.coloredLayers.map((source, index) => index === 0 ? {
      ...source,
      exterior: { ...source.exterior, id: `${source.id}-fastener-hole-1` },
    } : source);
    const materialized = materializeFastenerHoles(plan, sourceLayers);
    expect(materialized).toHaveLength(sourceLayers.length);
    expect(materialized.every((holes) => holes.length === plan.count)).toBe(true);
    for (const holes of materialized) {
      for (let index = 0; index < holes.length; index += 1) {
        expect(holes[index].outer).toEqual(plan.holes[index].outer);
      }
    }
    const allIds = [
      ...sourceLayers.flatMap((source) => [
        source.id, source.exterior.id, source.centralHole?.id,
        ...source.launcherCuts.map(({ id }) => id),
        ...source.deepFeatures.map(({ id }) => id),
        ...source.lightFeatures.map(({ id }) => id),
      ].filter((id): id is string => id !== undefined)),
      ...materialized.flatMap((holes) => holes.map(({ id }) => id)),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);

    const coloredLayers = sourceLayers.map((source, index) => ({ ...source, fastenerHoles: materialized[index] }));
    const withLayers = { ...seed, coloredLayers, preview: { ...seed.preview, layers: coloredLayers } };
    const complete = { ...withLayers, featureEvidenceFingerprint: featureEvidenceFingerprint(withLayers) };
    expect(() => validateAutomaticColoredResult(complete)).not.toThrow();
  });

  it('rejects forged IDs, unexpected keys, and malformed shared geometry before materialization', () => {
    const plan = planFastenerHoles({
      layers: [layer('wide', rectangle('wide-exterior', -12, -12, 12, 12))],
      axisPoint: [0, 0], material,
    });
    const sourceLayers = coloredResult().coloredLayers;
    const first = plan.holes[0];
    const replaceFirst = (geometry: object): FastenerPlan => ({
      ...plan,
      holes: [geometry, ...plan.holes.slice(1)],
    }) as unknown as FastenerPlan;

    expect(() => materializeFastenerHoles(replaceFirst({ ...first, id: 'forged-public-id' }), sourceLayers))
      .toThrow(/id|shared geometry|unexpected/i);
    expect(() => materializeFastenerHoles(replaceFirst({ ...first, secret: true }), sourceLayers))
      .toThrow(/unexpected|shared geometry/i);
    expect(() => materializeFastenerHoles({ ...plan, secret: true } as unknown as FastenerPlan, sourceLayers))
      .toThrow(/unexpected|plan/i);
    expect(() => materializeFastenerHoles(replaceFirst({
      ...first,
      outer: first.outer.slice(0, 47),
    }), sourceLayers)).toThrow(/48|geometry|contour/i);
    expect(() => materializeFastenerHoles(replaceFirst({
      ...first,
      boundsMm: { ...first.boundsMm, maxX: first.boundsMm.maxX + 1 },
    }), sourceLayers)).toThrow(/bounds|geometry|consistent/i);
    expect(() => materializeFastenerHoles({
      ...plan,
      count: 2,
    } as unknown as FastenerPlan, sourceLayers)).toThrow(/count|shared plan|bounded/i);
  });

  it('finds the review long-tail three-hole chamber without letting a remote vertex dominate radius resolution', () => {
    const exterior = contour('review-long-tail', [
      [-4, -4], [4, -4], [4, -1], [1_000, -1],
      [1_000, 1], [4, 1], [4, 4], [-4, 4],
    ]);
    const result = planFastenerHoles({
      layers: [layer('review', exterior)], axisPoint: [0, 0], material,
    });
    expect(result.count).toBe(3);
    expect(result.radiusMm).toBeGreaterThanOrEqual(3.5 / Math.sqrt(3) - 1e-12);
    expect(result.radiusMm).toBeLessThan(3);
    expect(angleGap(result.centers[0], result.centers[1])).toBeCloseTo(Math.PI * 2 / 3, 10);
  });

  it('finds a low-radius opposite pair in a long narrow chamber before degrading to one', () => {
    const result = planFastenerHoles({
      layers: [layer('long-two', longTail('long-two-exterior', -4, 4, 3))],
      axisPoint: [0, 0], material,
    });
    expect(result.count).toBe(2);
    expect(result.radiusMm).toBeGreaterThanOrEqual(1.75 - 1e-12);
    expect(result.radiusMm).toBeLessThan(2.25);
    expect(angleGap(result.centers[0], result.centers[1])).toBeCloseTo(Math.PI, 10);
  });

  it('finds one thick long-aspect chamber by local boundary scale instead of global AABB spacing', () => {
    const result = planFastenerHoles({
      layers: [layer('long-one', longTail('long-one-exterior', 0, 10, 5))],
      axisPoint: [0, 0], material,
    });
    expect(result.count).toBe(1);
    expect(result.centers[0][0]).toBeGreaterThan(2);
    expect(result.centers[0][0]).toBeLessThan(8);
    expect(Math.abs(result.centers[0][1])).toBeLessThan(4);
  });

  it('establishes a true zero at manufacturing resolution for a bounded undersized region', () => {
    const result = planFastenerHoles({
      layers: [layer('true-zero', rectangle('true-zero-exterior', -2, -2, 2, 2))],
      axisPoint: [0, 0], material,
    });
    expect(result.count).toBe(0);
    expect(result.warning).toBe(FASTENER_OMISSION_WARNING);
  });

  it('prefers three 120-degree holes at the maximum safe bounded radius with deterministic rotation', () => {
    const layers = [
      layer('top', rectangle('top-exterior', -12, -12, 12, 12)),
      layer('middle', rectangle('middle-exterior', -11, -11, 11, 11)),
      layer('bottom', rectangle('bottom-exterior', -12, -12, 12, 12)),
    ] as const;
    const first = planFastenerHoles({ layers, axisPoint: [0, 0], material });
    const second = planFastenerHoles({ layers, axisPoint: [0, 0], material });

    expect(first).toEqual(second);
    expect(first.count).toBe(3);
    expect(first.holes).toHaveLength(3);
    expect(first.centers).toHaveLength(3);
    expect(first.rotationRad).toBeGreaterThanOrEqual(0);
    expect(first.rotationRad).toBeLessThan(Math.PI * 2 / 3);
    expect(angleGap(first.centers[0], first.centers[1])).toBeCloseTo(Math.PI * 2 / 3, 10);
    expect(angleGap(first.centers[1], first.centers[2])).toBeCloseTo(Math.PI * 2 / 3, 10);
    expect(first.centers.map(([x, y]) => Math.hypot(x, y)))
      .toEqual(first.centers.map(() => expect.closeTo(first.radiusMm!, 10)));

    const common = protectedLayers(layers);
    expect(first.centers.every((center) => isCircleSafeThroughAllLayers({
      center, radiusMm: 1.5, clearanceMm: material.minWebMm + material.kerfMm / 2, layers: common,
    }))).toBe(true);
    const nextRadius = first.radiusMm! + FASTENER_SEARCH_RESOLUTION_MM;
    const anySaferLargerRotation = Array.from({ length: FASTENER_ANGULAR_CANDIDATES }, (_, index) => (
      index * (Math.PI * 2 / 3) / FASTENER_ANGULAR_CANDIDATES
    )).some((rotation) => [0, 1, 2].every((index) => {
      const angle = rotation + index * Math.PI * 2 / 3;
      return isCircleSafeThroughAllLayers({
        center: [Math.cos(angle) * nextRadius, Math.sin(angle) * nextRadius],
        radiusMm: 1.5,
        clearanceMm: material.minWebMm + material.kerfMm / 2,
        layers: common,
      });
    }));
    expect(anySaferLargerRotation).toBe(false);
  });

  it('degrades to the safest deterministic opposite pair when no three-hole pattern fits', () => {
    const layers = [
      layer('top', rectangle('top-exterior', -10, -3, 10, 3)),
      layer('bottom', rectangle('bottom-exterior', -9, -3, 9, 3)),
    ] as const;
    const result = planFastenerHoles({ layers, axisPoint: [0, 0], material });
    expect(result.count).toBe(2);
    expect(result.centers).toHaveLength(2);
    expect(angleGap(result.centers[0], result.centers[1])).toBeCloseTo(Math.PI, 10);
    expect(Math.hypot(...result.centers[0])).toBeCloseTo(Math.hypot(...result.centers[1]), 10);
    expect(result.rotationRad).toBeCloseTo(Math.PI / FASTENER_ANGULAR_CANDIDATES, 10);
    expect(result.radiusMm).toBeGreaterThan(6);
  });

  it('degrades to the common thickest-safe grid location when centered pairs cannot fit', () => {
    const layers = [
      layer('top', rectangle('top-exterior', 0, -5, 10, 5)),
      layer('bottom', rectangle('bottom-exterior', 0, -5, 10, 5)),
    ] as const;
    const result = planFastenerHoles({ layers, axisPoint: [0, 0], material });
    expect(result.count).toBe(1);
    expect(result.centers).toEqual([[5, 0]]);
    expect(result.radiusMm).toBe(5);
    expect(result.rotationRad).toBe(0);
  });

  it('omits all holes with one sanitized warning when no finished 3 mm envelope is safe', () => {
    const launcher = rectangle('launcher', -3, -3, 3, 3);
    const result = planFastenerHoles({
      layers: [layer('blocked', rectangle('blocked-exterior', -5, -5, 5, 5), { launcherCuts: [launcher] })],
      axisPoint: [0, 0], material,
    });
    expect(result).toEqual({
      count: 0,
      holes: [],
      centers: [],
      finishedDiameterMm: 3,
      pathDiameterMm: 2.8,
      warning: FASTENER_OMISSION_WARNING,
    });
  });

  it('emits 48-point CUT_BLACK paths compensated to a 3.00 mm finished hole', () => {
    const result = planFastenerHoles({
      layers: [layer('wide', rectangle('wide-exterior', -12, -12, 12, 12))],
      axisPoint: [0, 0], material,
    });
    expect(result.finishedDiameterMm).toBe(3);
    expect(result.pathDiameterMm).toBeCloseTo(3 - material.kerfMm, 12);
    expect(result.pathDiameterMm).toBeGreaterThan(0);
    expect(result.holes.every(({ role, outer }) => role === 'CUT_BLACK' && outer.length === 48)).toBe(true);
    for (let index = 0; index < result.holes.length; index += 1) {
      const center = result.centers[index];
      expect(Math.hypot(
        result.holes[index].outer[0][0] - center[0],
        result.holes[index].outer[0][1] - center[1],
      )).toBeCloseTo(result.pathDiameterMm / 2, 12);
    }
  });

  it('fails closed when kerf leaves no positive or manufacturable inside-cut path', () => {
    const request = {
      layers: [layer('wide', rectangle('wide-exterior', -12, -12, 12, 12))],
      axisPoint: [0, 0] as Point2,
    };
    expect(() => planFastenerHoles({ ...request, material: { ...material, kerfMm: 3 } }))
      .toThrow(/positive|3 mm|kerf/i);
    expect(planFastenerHoles({ ...request, material: { ...material, minFeatureMm: 2.9 } }).count)
      .toBeGreaterThan(0);
    expect(() => planFastenerHoles({ ...request, material: { ...material, minFeatureMm: 3.01 } }))
      .toThrow(/minimum feature|manufactur/i);
    const noWeb = planFastenerHoles({ ...request, material: { ...material, minWebMm: 50 } });
    expect(noWeb.count).toBe(0);
    expect(noWeb.warning).toBe(FASTENER_OMISSION_WARNING);
  });

  it('rejects a positive but numerically nonrepresentable near-3 mm path at a nonzero center', () => {
    const almostThree = 3 - 2 ** -51;
    expect(almostThree).toBeLessThan(3);
    expect(() => planFastenerHoles({
      layers: [layer('translated', rectangle(
        'translated-exterior', 999_988, -1_000_012, 1_000_012, -999_988,
      ))],
      axisPoint: [1_000_000, -1_000_000],
      material: { ...material, kerfMm: almostThree },
    })).toThrow(/representable|distinct|simple|area|contour/i);
  });

  it('shares one deadline/checkpoint, propagates cancellation, and keeps candidate work bounded', () => {
    const request = {
      layers: [layer('wide', rectangle('wide-exterior', -12, -12, 12, 12))],
      axisPoint: [0, 0] as Point2,
      material,
    };
    const expiredCheckpoint = vi.fn();
    expect(() => planFastenerHoles({ ...request, deadline: Date.now() - 1, checkpoint: expiredCheckpoint }))
      .toThrow(/runtime budget/i);
    expect(expiredCheckpoint).toHaveBeenCalledTimes(1);

    const cancellation = new Error('fastener search cancelled');
    let cancelledCalls = 0;
    expect(() => planFastenerHoles({ ...request, checkpoint: () => {
      cancelledCalls += 1;
      if (cancelledCalls === 12) throw cancellation;
    } })).toThrow(cancellation);

    let calls = 0;
    planFastenerHoles({
      layers: [layer('tiny', rectangle('tiny-exterior', -1.9, -1.9, 1.9, 1.9))],
      axisPoint: [0, 0], material, checkpoint: () => { calls += 1; },
    });
    expect(calls).toBeLessThan(50_000);
    expect(() => planFastenerHoles({ ...request, layers: Array.from({ length: 25 }, () => request.layers[0]) }))
      .toThrow(/24|bounded/i);
  });

  it('throws at an unresolved bounded-search cap instead of degrading to zero holes', () => {
    expect(() => planFastenerHoles({
      layers: [layer('wide', rectangle('wide-exterior', -12, -12, 12, 12))],
      axisPoint: [0, 0],
      material,
      searchLimits: { maxRadialEvaluations: 1 },
    })).toThrow(/radial search|completeness|bounded/i);
  });
});
