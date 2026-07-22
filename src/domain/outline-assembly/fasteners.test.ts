import { describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { ManufacturingGeometryProfile } from '../materials/manufacturing-profile';
import type { FeatureContour } from '../outline-features/types';
import {
  FASTENER_ANGULAR_CANDIDATES,
  FASTENER_OMISSION_WARNING,
  FASTENER_RADIAL_CANDIDATES,
  planFastenerHoles,
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
    const radialStep = Math.hypot(11, 11) / FASTENER_RADIAL_CANDIDATES;
    const nextRadius = first.radiusMm! + radialStep;
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
});
