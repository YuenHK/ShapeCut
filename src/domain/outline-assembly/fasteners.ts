import type { Point2 } from '../decomposition/types';
import {
  validateManufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from '../materials/manufacturing-profile';
import type { FeatureContour } from '../outline-features/types';
import { contourBounds, signedArea } from '../outline-2.5d/simplify';
import {
  circleLoop48,
  MAX_FASTENER_LAYERS,
  prepareProtectedRegions,
  type PreparedProtectedRegions,
  type ProtectedRegionLayer,
} from './protected-region';

export const FASTENER_FINISHED_DIAMETER_MM = 3 as const;
export const FASTENER_RADIAL_CANDIDATES = 128;
export const FASTENER_ANGULAR_CANDIDATES = 48;
export const FASTENER_SINGLE_GRID_STEPS = 32;
export const FASTENER_OMISSION_WARNING = '無法安全配置 3 mm 固定螺絲孔，已省略螺絲孔';

export type FastenerPlan = {
  readonly count: 0 | 1 | 2 | 3;
  readonly holes: readonly FeatureContour[];
  readonly centers: readonly Point2[];
  readonly finishedDiameterMm: 3;
  readonly pathDiameterMm: number;
  readonly radiusMm?: number;
  readonly rotationRad?: number;
  readonly warning?: string;
};

export type FastenerPlanningLayer = {
  readonly id: string;
  readonly exterior: FeatureContour;
  readonly centralHole?: FeatureContour;
  readonly launcherCuts: readonly FeatureContour[];
};

export type FastenerPlanningRequest = {
  readonly layers: readonly FastenerPlanningLayer[];
  readonly axisPoint: Point2;
  readonly material: ManufacturingGeometryProfile;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};

type CandidatePattern = {
  readonly centers: readonly Point2[];
  readonly radiusMm: number;
  readonly rotationRad: number;
  readonly minimumClearanceMm: number;
};

type CommonBounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Fastener planning exceeded the runtime budget');
}

function positiveAngle(angle: number): number {
  const full = Math.PI * 2;
  const normalized = (angle % full + full) % full;
  return normalized < 1e-12 || full - normalized < 1e-12 ? 0 : normalized;
}

function protectedLayers(layers: readonly FastenerPlanningLayer[]): readonly ProtectedRegionLayer[] {
  return layers.map((layer) => ({
    exterior: layer.exterior.outer,
    protected: [
      ...(layer.centralHole ? [layer.centralHole.outer] : []),
      ...layer.launcherCuts.map(({ outer }) => outer),
    ],
  }));
}

function commonBounds(
  layers: readonly FastenerPlanningLayer[],
  deadline: number,
  checkpoint: () => void,
): CommonBounds {
  let minX = -Infinity, minY = -Infinity, maxX = Infinity, maxY = Infinity;
  for (const layer of layers) {
    let layerMinX = Infinity, layerMinY = Infinity, layerMaxX = -Infinity, layerMaxY = -Infinity;
    for (let index = 0; index < layer.exterior.outer.length; index += 1) {
      if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
      const [x, y] = layer.exterior.outer[index];
      layerMinX = Math.min(layerMinX, x); layerMinY = Math.min(layerMinY, y);
      layerMaxX = Math.max(layerMaxX, x); layerMaxY = Math.max(layerMaxY, y);
    }
    minX = Math.max(minX, layerMinX); minY = Math.max(minY, layerMinY);
    maxX = Math.min(maxX, layerMaxX); maxY = Math.min(maxY, layerMaxY);
  }
  return { minX, minY, maxX, maxY };
}

function maximumBoundedRadius(
  layers: readonly FastenerPlanningLayer[],
  axisPoint: Point2,
  deadline: number,
  checkpoint: () => void,
): number {
  let commonMaximum = Infinity;
  for (const layer of layers) {
    let layerMaximum = 0;
    for (let index = 0; index < layer.exterior.outer.length; index += 1) {
      if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
      const point = layer.exterior.outer[index];
      layerMaximum = Math.max(layerMaximum, Math.hypot(point[0] - axisPoint[0], point[1] - axisPoint[1]));
    }
    commonMaximum = Math.min(commonMaximum, layerMaximum);
  }
  return commonMaximum;
}

function centersAt(
  count: 2 | 3,
  axisPoint: Point2,
  radiusMm: number,
  rotationRad: number,
): readonly Point2[] {
  return Array.from({ length: count }, (_, index): Point2 => {
    const angle = rotationRad + index * Math.PI * 2 / count;
    return [axisPoint[0] + Math.cos(angle) * radiusMm, axisPoint[1] + Math.sin(angle) * radiusMm];
  });
}

function patternClearance(
  centers: readonly Point2[],
  prepared: PreparedProtectedRegions,
  requiredBoundaryClearanceMm: number,
  minimumWebMm: number,
  deadline: number,
  checkpoint: () => void,
): number | undefined {
  let minimum = Infinity;
  for (let index = 0; index < centers.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const clearance = prepared.minimumClearanceMm(centers[index]);
    if (clearance + 1e-12 < requiredBoundaryClearanceMm) return undefined;
    minimum = Math.min(minimum, clearance);
    for (let other = 0; other < index; other += 1) {
      if (Math.hypot(
        centers[index][0] - centers[other][0],
        centers[index][1] - centers[other][1],
      ) + 1e-12 < FASTENER_FINISHED_DIAMETER_MM + minimumWebMm) return undefined;
    }
  }
  return minimum;
}

function searchPattern(
  count: 2 | 3,
  axisPoint: Point2,
  maximumRadiusMm: number,
  prepared: PreparedProtectedRegions,
  requiredBoundaryClearanceMm: number,
  minimumWebMm: number,
  deadline: number,
  checkpoint: () => void,
): CandidatePattern | undefined {
  const rotationPeriod = Math.PI * 2 / count;
  for (let radialIndex = 0; radialIndex < FASTENER_RADIAL_CANDIDATES; radialIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const radiusMm = maximumRadiusMm * (FASTENER_RADIAL_CANDIDATES - radialIndex)
      / FASTENER_RADIAL_CANDIDATES;
    const neighborDistance = 2 * radiusMm * Math.sin(Math.PI / count);
    if (neighborDistance + 1e-12 < FASTENER_FINISHED_DIAMETER_MM + minimumWebMm) continue;
    let safest: CandidatePattern | undefined;
    for (let angularIndex = 0; angularIndex < FASTENER_ANGULAR_CANDIDATES; angularIndex += 1) {
      checkRuntime(deadline, checkpoint);
      const rotationRad = angularIndex * rotationPeriod / FASTENER_ANGULAR_CANDIDATES;
      const centers = centersAt(count, axisPoint, radiusMm, rotationRad);
      const clearance = patternClearance(
        centers, prepared, requiredBoundaryClearanceMm, minimumWebMm, deadline, checkpoint,
      );
      if (clearance === undefined) continue;
      if (!safest || clearance > safest.minimumClearanceMm + 1e-12) {
        safest = { centers, radiusMm, rotationRad, minimumClearanceMm: clearance };
      }
    }
    if (safest) return safest;
  }
  return undefined;
}

function searchSingle(
  bounds: CommonBounds,
  axisPoint: Point2,
  prepared: PreparedProtectedRegions,
  requiredBoundaryClearanceMm: number,
  deadline: number,
  checkpoint: () => void,
): CandidatePattern | undefined {
  if (!(bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY)) return undefined;
  let safest: CandidatePattern | undefined;
  for (let xIndex = 0; xIndex <= FASTENER_SINGLE_GRID_STEPS; xIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const x = bounds.minX + (bounds.maxX - bounds.minX) * xIndex / FASTENER_SINGLE_GRID_STEPS;
    for (let yIndex = 0; yIndex <= FASTENER_SINGLE_GRID_STEPS; yIndex += 1) {
      checkRuntime(deadline, checkpoint);
      const y = bounds.minY + (bounds.maxY - bounds.minY) * yIndex / FASTENER_SINGLE_GRID_STEPS;
      const center: Point2 = [x, y];
      const clearance = prepared.minimumClearanceMm(center);
      if (clearance + 1e-12 < requiredBoundaryClearanceMm) continue;
      if (!safest || clearance > safest.minimumClearanceMm + 1e-12) {
        const dx = x - axisPoint[0], dy = y - axisPoint[1];
        safest = {
          centers: [center],
          radiusMm: Math.hypot(dx, dy),
          rotationRad: positiveAngle(Math.atan2(dy, dx)),
          minimumClearanceMm: clearance,
        };
      }
    }
  }
  return safest;
}

function featureContour(
  center: Point2,
  index: number,
  pathRadiusMm: number,
  deadline: number,
  checkpoint: () => void,
): FeatureContour {
  checkRuntime(deadline, checkpoint);
  const outer = circleLoop48(center, pathRadiusMm);
  return {
    id: `fastener-hole-${index + 1}`,
    role: 'CUT_BLACK',
    outer,
    boundsMm: contourBounds(outer, deadline, checkpoint),
    areaMm2: Math.abs(signedArea(outer, deadline, checkpoint)),
  };
}

export function planFastenerHoles(request: FastenerPlanningRequest): FastenerPlan {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (!Array.isArray(request.layers) || request.layers.length < 1 || request.layers.length > MAX_FASTENER_LAYERS) {
    throw new RangeError('Fastener planning requires 1 to 24 bounded layers');
  }
  if (!Array.isArray(request.axisPoint) || request.axisPoint.length !== 2
    || !request.axisPoint.every(Number.isFinite)) {
    throw new RangeError('Fastener planning requires a finite canonical axis point');
  }
  const material = validateManufacturingGeometryProfile(request.material);
  const pathDiameterMm = FASTENER_FINISHED_DIAMETER_MM - material.kerfMm;
  if (!Number.isFinite(pathDiameterMm) || pathDiameterMm <= 0) {
    throw new RangeError('Kerf must leave a positive path for a finished 3 mm fastener hole');
  }
  if (FASTENER_FINISHED_DIAMETER_MM + 1e-12 < material.minFeatureMm) {
    throw new RangeError('The finished 3 mm fastener hole is below the material minimum feature');
  }
  for (const layer of request.layers) {
    checkRuntime(deadline, checkpoint);
    if (!Array.isArray(layer.launcherCuts) || layer.launcherCuts.length > 3) {
      throw new RangeError('Each fastener layer permits at most three launcher cuts');
    }
  }
  const prepared = prepareProtectedRegions(protectedLayers(request.layers), deadline, checkpoint);
  const bounds = commonBounds(request.layers, deadline, checkpoint);
  const maximumRadiusMm = maximumBoundedRadius(request.layers, request.axisPoint, deadline, checkpoint);
  const requiredBoundaryClearanceMm = FASTENER_FINISHED_DIAMETER_MM / 2
    + material.minWebMm + material.kerfMm / 2;
  const candidate = searchPattern(
    3, request.axisPoint, maximumRadiusMm, prepared, requiredBoundaryClearanceMm,
    material.minWebMm, deadline, checkpoint,
  ) ?? searchPattern(
    2, request.axisPoint, maximumRadiusMm, prepared, requiredBoundaryClearanceMm,
    material.minWebMm, deadline, checkpoint,
  ) ?? searchSingle(
    bounds, request.axisPoint, prepared, requiredBoundaryClearanceMm, deadline, checkpoint,
  );
  if (!candidate) {
    return {
      count: 0,
      holes: [],
      centers: [],
      finishedDiameterMm: FASTENER_FINISHED_DIAMETER_MM,
      pathDiameterMm,
      warning: FASTENER_OMISSION_WARNING,
    };
  }
  const holes = candidate.centers.map((center, index) => featureContour(
    center, index, pathDiameterMm / 2, deadline, checkpoint,
  ));
  return {
    count: candidate.centers.length as 1 | 2 | 3,
    holes,
    centers: candidate.centers,
    finishedDiameterMm: FASTENER_FINISHED_DIAMETER_MM,
    pathDiameterMm,
    radiusMm: candidate.radiusMm,
    rotationRad: candidate.rotationRad,
  };
}
