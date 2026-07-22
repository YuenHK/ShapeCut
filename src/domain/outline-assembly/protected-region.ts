import type { Point2 } from '../decomposition/types';

export const MAX_FASTENER_LAYERS = 24;
export const MAX_PROTECTED_REGIONS_PER_LAYER = 4;
export const MAX_PROTECTED_REGION_POINTS = 4_096;
export const FASTENER_CIRCLE_POINT_COUNT = 48;

export type ProtectedRegionLayer = {
  readonly exterior: readonly Point2[];
  readonly protected: readonly (readonly Point2[])[];
};

export type CircleSafetyRequest = {
  readonly center: Point2;
  readonly radiusMm: number;
  readonly clearanceMm: number;
  readonly layers: readonly ProtectedRegionLayer[];
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};

export type PreparedProtectedRegions = {
  readonly layers: readonly ProtectedRegionLayer[];
  minimumClearanceMm(center: Point2): number;
};

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) {
    throw new RangeError('Fastener protected-region processing exceeded the runtime budget');
  }
}

function boundedLoop(
  loop: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): void {
  if (!Array.isArray(loop) || loop.length < 3 || loop.length > MAX_PROTECTED_REGION_POINTS) {
    throw new RangeError('Fastener protected regions require bounded loops of 3 to 4096 points');
  }
  for (let index = 0; index < loop.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const point = loop[index];
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      throw new RangeError('Fastener protected regions require finite two-dimensional points');
    }
  }
}

function validateLayers(
  layers: readonly ProtectedRegionLayer[],
  deadline: number,
  checkpoint: () => void,
): void {
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_FASTENER_LAYERS) {
    throw new RangeError('Fastener planning requires 1 to 24 bounded layers');
  }
  for (const layer of layers) {
    checkRuntime(deadline, checkpoint);
    if (!Array.isArray(layer.protected) || layer.protected.length > MAX_PROTECTED_REGIONS_PER_LAYER) {
      throw new RangeError('Each fastener layer permits at most 4 bounded protected regions');
    }
    boundedLoop(layer.exterior, deadline, checkpoint);
    for (const loop of layer.protected) boundedLoop(loop, deadline, checkpoint);
  }
}

function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator,
  ));
  return Math.hypot(point[0] - start[0] - dx * ratio, point[1] - start[1] - dy * ratio);
}

/** Positive inside, negative outside, and zero on the loop boundary. */
function signedDistanceToLoop(
  point: Point2,
  loop: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let inside = false;
  let distance = Infinity;
  for (let index = 0; index < loop.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const start = loop[index], end = loop[(index + 1) % loop.length];
    distance = Math.min(distance, pointSegmentDistance(point, start, end));
    if ((start[1] > point[1]) !== (end[1] > point[1])) {
      const intersectionX = start[0]
        + (point[1] - start[1]) * (end[0] - start[0]) / (end[1] - start[1]);
      if (intersectionX > point[0]) inside = !inside;
    }
  }
  if (distance <= Number.EPSILON) return 0;
  return inside ? distance : -distance;
}

export function minimumMaterialClearanceMm(
  center: Point2,
  layers: readonly ProtectedRegionLayer[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): number {
  return prepareProtectedRegions(layers, deadline, checkpoint).minimumClearanceMm(center);
}

export function prepareProtectedRegions(
  layers: readonly ProtectedRegionLayer[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): PreparedProtectedRegions {
  checkRuntime(deadline, checkpoint);
  validateLayers(layers, deadline, checkpoint);
  return {
    layers,
    minimumClearanceMm(center: Point2): number {
      checkRuntime(deadline, checkpoint);
      if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
        throw new RangeError('Fastener clearance requires a finite center');
      }
      let clearance = Infinity;
      for (const layer of layers) {
        checkRuntime(deadline, checkpoint);
        const exteriorDistance = signedDistanceToLoop(center, layer.exterior, deadline, checkpoint);
        if (exteriorDistance <= 0) return exteriorDistance;
        clearance = Math.min(clearance, exteriorDistance);
        for (const region of layer.protected) {
          checkRuntime(deadline, checkpoint);
          const regionDistance = signedDistanceToLoop(center, region, deadline, checkpoint);
          if (regionDistance >= 0) return -regionDistance;
          clearance = Math.min(clearance, -regionDistance);
        }
      }
      return clearance;
    },
  };
}

export function isCircleSafeThroughAllLayers(request: CircleSafetyRequest): boolean {
  const deadline = request.deadline ?? Infinity;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (!Number.isFinite(request.radiusMm) || request.radiusMm <= 0
    || !Number.isFinite(request.clearanceMm) || request.clearanceMm < 0) return false;
  const clearance = minimumMaterialClearanceMm(request.center, request.layers, deadline, checkpoint);
  return clearance + 1e-12 >= request.radiusMm + request.clearanceMm;
}

export function circleLoop48(center: Point2, radiusMm: number): readonly Point2[] {
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)
    || !Number.isFinite(radiusMm) || radiusMm <= 0) {
    throw new RangeError('Fastener circle requires a finite center and positive radius');
  }
  return Array.from({ length: FASTENER_CIRCLE_POINT_COUNT }, (_, index): Point2 => {
    const angle = index * Math.PI * 2 / FASTENER_CIRCLE_POINT_COUNT;
    return [center[0] + Math.cos(angle) * radiusMm, center[1] + Math.sin(angle) * radiusMm];
  });
}
