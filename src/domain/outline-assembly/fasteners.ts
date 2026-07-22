import type { Point2 } from '../decomposition/types';
import {
  validateManufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from '../materials/manufacturing-profile';
import type { ColoredOutlineLayer, FeatureContour } from '../outline-features/types';
import { validatePolygon } from '../engraving/geometry';
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
export const FASTENER_SEARCH_RESOLUTION_MM = 0.25;
const FASTENER_MAX_RADIAL_SEEDS = 2_048;
const FASTENER_MAX_RADIAL_EVALUATIONS = 4_096;
const FASTENER_MAX_SINGLE_CELLS = 8_192;
export const FASTENER_OMISSION_WARNING = '無法安全配置 3 mm 固定螺絲孔，已省略螺絲孔';

export type FastenerHoleGeometry = Omit<FeatureContour, 'id'>;

export type FastenerPlan = {
  readonly count: 0 | 1 | 2 | 3;
  readonly holes: readonly FastenerHoleGeometry[];
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
  readonly searchLimits?: FastenerSearchLimits;
};

export type FastenerSearchLimits = {
  readonly maxRadialEvaluations?: number;
  readonly maxSingleCells?: number;
};

export type FastenerMaterializationLayer = Pick<
  ColoredOutlineLayer,
  'id' | 'exterior' | 'centralHole' | 'launcherCuts' | 'fastenerHoles' | 'deepFeatures' | 'lightFeatures'
>;

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

type PatternEvaluation = {
  readonly marginMm: number;
  readonly candidate?: CandidatePattern;
};

type SearchCell = CommonBounds & {
  readonly center: Point2;
  readonly clearanceMm: number;
  readonly upperClearanceMm: number;
};

type ResolvedSearchLimits = {
  readonly maxRadialEvaluations: number;
  readonly maxSingleCells: number;
};

export function fastenerPatternIntervalUpperBound(input: {
  readonly lowMarginMm: number;
  readonly middleMarginMm: number;
  readonly highMarginMm: number;
  readonly widthMm: number;
  readonly lipschitz: number;
}): number {
  const values = [
    input.lowMarginMm, input.middleMarginMm, input.highMarginMm,
    input.widthMm, input.lipschitz,
  ];
  if (!values.every(Number.isFinite) || input.widthMm <= 0 || input.lipschitz < 0) {
    throw new RangeError('Fastener interval certification requires finite Lipschitz samples and positive width');
  }
  const halfWidth = input.widthMm / 2;
  const halfUpperBound = (left: number, right: number): number => Math.max(
    left,
    right,
    (left + right + input.lipschitz * halfWidth) / 2,
  );
  return Math.max(
    halfUpperBound(input.lowMarginMm, input.middleMarginMm),
    halfUpperBound(input.middleMarginMm, input.highMarginMm),
  );
}

export function shouldPruneFastenerSingleCell(input: {
  readonly bestClearanceMm?: number;
  readonly cellUpperClearanceMm: number;
  readonly requiredClearanceMm: number;
}): boolean {
  if (!Number.isFinite(input.cellUpperClearanceMm)
    || !Number.isFinite(input.requiredClearanceMm)) return false;
  if (input.bestClearanceMm !== undefined
    && Number.isFinite(input.bestClearanceMm)
    && input.bestClearanceMm + 1e-12 >= input.requiredClearanceMm) {
    return input.cellUpperClearanceMm
      <= input.bestClearanceMm + FASTENER_SEARCH_RESOLUTION_MM;
  }
  return input.cellUpperClearanceMm < input.requiredClearanceMm;
}

function resolvedSearchLimits(limits: FastenerSearchLimits | undefined): ResolvedSearchLimits {
  const resolve = (value: number | undefined, fallback: number, name: string): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > fallback) {
      throw new RangeError(`Fastener ${name} must be a positive bounded integer`);
    }
    return resolved;
  };
  return {
    maxRadialEvaluations: resolve(
      limits?.maxRadialEvaluations, FASTENER_MAX_RADIAL_EVALUATIONS, 'radial evaluation limit',
    ),
    maxSingleCells: resolve(limits?.maxSingleCells, FASTENER_MAX_SINGLE_CELLS, 'single-cell limit'),
  };
}

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
): { readonly marginMm: number; readonly minimumClearanceMm: number } {
  let minimum = Infinity, margin = Infinity;
  for (let index = 0; index < centers.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const clearance = prepared.minimumClearanceMm(centers[index]);
    margin = Math.min(margin, clearance - requiredBoundaryClearanceMm);
    minimum = Math.min(minimum, clearance);
    for (let other = 0; other < index; other += 1) {
      margin = Math.min(margin, Math.hypot(
        centers[index][0] - centers[other][0],
        centers[index][1] - centers[other][1],
      ) - FASTENER_FINISHED_DIAMETER_MM - minimumWebMm);
    }
  }
  return { marginMm: margin, minimumClearanceMm: minimum };
}

function axisSegmentDistance(axisPoint: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1,
    ((axisPoint[0] - start[0]) * dx + (axisPoint[1] - start[1]) * dy) / denominator,
  ));
  return Math.hypot(start[0] + dx * ratio - axisPoint[0], start[1] + dy * ratio - axisPoint[1]);
}

function radialSeeds(
  count: 2 | 3,
  axisPoint: Point2,
  maximumRadiusMm: number,
  prepared: PreparedProtectedRegions,
  requiredBoundaryClearanceMm: number,
  minimumWebMm: number,
  deadline: number,
  checkpoint: () => void,
): readonly number[] {
  const minimumRadiusMm = (FASTENER_FINISHED_DIAMETER_MM + minimumWebMm)
    / (2 * Math.sin(Math.PI / count));
  if (minimumRadiusMm > maximumRadiusMm) return [];
  const seeds = new Set<number>();
  const add = (radius: number, quantize = false): void => {
    if (!Number.isFinite(radius)) return;
    const bounded = Math.max(minimumRadiusMm, Math.min(maximumRadiusMm, radius));
    const value = quantize
      ? Math.round(bounded / FASTENER_SEARCH_RESOLUTION_MM) * FASTENER_SEARCH_RESOLUTION_MM
      : bounded;
    if (value >= minimumRadiusMm - 1e-12 && value <= maximumRadiusMm + 1e-12) seeds.add(value);
    if (seeds.size > FASTENER_MAX_RADIAL_SEEDS) {
      throw new RangeError('Fastener radial features exceed the bounded manufacturing-resolution search');
    }
  };
  add(minimumRadiusMm); add(maximumRadiusMm);
  const lowMaximum = Math.min(maximumRadiusMm, minimumRadiusMm + 32);
  for (let radius = minimumRadiusMm; radius <= lowMaximum + 1e-12; radius += FASTENER_SEARCH_RESOLUTION_MM) {
    checkRuntime(deadline, checkpoint);
    add(radius);
  }
  if (maximumRadiusMm > lowMaximum + FASTENER_SEARCH_RESOLUTION_MM) {
    for (let index = 0; index <= FASTENER_RADIAL_CANDIDATES; index += 1) {
      checkRuntime(deadline, checkpoint);
      add(lowMaximum + (maximumRadiusMm - lowMaximum) * index / FASTENER_RADIAL_CANDIDATES);
    }
  }
  for (const layer of prepared.layers) {
    for (const loop of [layer.exterior, ...layer.protected]) {
      for (let index = 0; index < loop.length; index += 1) {
        if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
        const point = loop[index], next = loop[(index + 1) % loop.length];
        for (const distance of [
          Math.hypot(point[0] - axisPoint[0], point[1] - axisPoint[1]),
          axisSegmentDistance(axisPoint, point, next),
        ]) {
          add(distance, true);
          add(distance - requiredBoundaryClearanceMm, true);
          add(distance + requiredBoundaryClearanceMm, true);
        }
      }
    }
  }
  return [...seeds].sort((left, right) => left - right);
}

function evaluatePatternRadius(
  count: 2 | 3,
  axisPoint: Point2,
  radiusMm: number,
  prepared: PreparedProtectedRegions,
  requiredBoundaryClearanceMm: number,
  minimumWebMm: number,
  deadline: number,
  checkpoint: () => void,
): PatternEvaluation {
  const rotationPeriod = Math.PI * 2 / count;
  let bestMargin = -Infinity, safest: CandidatePattern | undefined;
  for (let angularIndex = 0; angularIndex < FASTENER_ANGULAR_CANDIDATES; angularIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const rotationRad = angularIndex * rotationPeriod / FASTENER_ANGULAR_CANDIDATES;
    const centers = centersAt(count, axisPoint, radiusMm, rotationRad);
    const result = patternClearance(
      centers, prepared, requiredBoundaryClearanceMm, minimumWebMm, deadline, checkpoint,
    );
    if (result.marginMm > bestMargin) bestMargin = result.marginMm;
    if (result.marginMm >= -1e-12
      && (!safest || result.minimumClearanceMm > safest.minimumClearanceMm + 1e-12)) {
      safest = { centers, radiusMm, rotationRad, minimumClearanceMm: result.minimumClearanceMm };
    }
  }
  return { marginMm: bestMargin, candidate: safest };
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
  limits: ResolvedSearchLimits,
): CandidatePattern | undefined {
  const seeds = radialSeeds(
    count, axisPoint, maximumRadiusMm, prepared, requiredBoundaryClearanceMm,
    minimumWebMm, deadline, checkpoint,
  );
  if (seeds.length === 0) return undefined;
  const evaluations = new Map<number, PatternEvaluation>();
  const evaluate = (radius: number): PatternEvaluation => {
    let value = evaluations.get(radius);
    if (value) return value;
    if (evaluations.size >= limits.maxRadialEvaluations) {
      throw new RangeError('Fastener radial search could not establish bounded manufacturing-resolution completeness');
    }
    value = evaluatePatternRadius(
      count, axisPoint, radius, prepared, requiredBoundaryClearanceMm,
      minimumWebMm, deadline, checkpoint,
    );
    evaluations.set(radius, value);
    return value;
  };
  let best: CandidatePattern | undefined;
  for (const radius of seeds) {
    const candidate = evaluate(radius).candidate;
    if (candidate && (!best || candidate.radiusMm > best.radiusMm + 1e-12
      || Math.abs(candidate.radiusMm - best.radiusMm) <= 1e-12
        && candidate.minimumClearanceMm > best.minimumClearanceMm + 1e-12)) best = candidate;
  }
  const intervals = seeds.slice(1).map((_, index) => ({ low: seeds[index], high: seeds[index + 1] }));
  const lipschitz = Math.max(1, 2 * Math.sin(Math.PI / count));
  while (intervals.length > 0) {
    intervals.sort((left, right) => right.high - left.high || right.low - left.low);
    const interval = intervals.shift()!;
    if (best && interval.high <= best.radiusMm + FASTENER_SEARCH_RESOLUTION_MM) continue;
    const width = interval.high - interval.low;
    const middle = (interval.low + interval.high) / 2;
    if (!(middle > interval.low && middle < interval.high)) {
      throw new RangeError('Fastener radial search could not resolve a potentially safe representable interval');
    }
    const middleEvaluation = evaluate(middle);
    if (middleEvaluation.candidate && (!best || middle > best.radiusMm + 1e-12)) {
      best = middleEvaluation.candidate;
    }
    const upperBound = fastenerPatternIntervalUpperBound({
      lowMarginMm: evaluate(interval.low).marginMm,
      middleMarginMm: middleEvaluation.marginMm,
      highMarginMm: evaluate(interval.high).marginMm,
      widthMm: width,
      lipschitz,
    });
    if (upperBound < -1e-12) continue;
    intervals.push({ low: interval.low, high: middle }, { low: middle, high: interval.high });
  }
  return best;
}

function comparePoint(left: Point2, right: Point2): number {
  return left[0] - right[0] || left[1] - right[1];
}

function makeCell(
  bounds: CommonBounds,
  prepared: PreparedProtectedRegions,
  deadline: number,
  checkpoint: () => void,
): SearchCell {
  const center: Point2 = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
  const clearanceMm = prepared.minimumClearanceMm(center);
  checkRuntime(deadline, checkpoint);
  return {
    ...bounds,
    center,
    clearanceMm,
    upperClearanceMm: clearanceMm + Math.hypot(
      (bounds.maxX - bounds.minX) / 2,
      (bounds.maxY - bounds.minY) / 2,
    ),
  };
}

function searchSingle(
  bounds: CommonBounds,
  axisPoint: Point2,
  prepared: PreparedProtectedRegions,
  requiredBoundaryClearanceMm: number,
  deadline: number,
  checkpoint: () => void,
  limits: ResolvedSearchLimits,
): CandidatePattern | undefined {
  if (!(bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY)) return undefined;
  let safest: CandidatePattern | undefined;
  const update = (center: Point2, clearance: number): void => {
    if (!Number.isFinite(clearance)) return;
    if (safest && (clearance < safest.minimumClearanceMm - 1e-12
      || Math.abs(clearance - safest.minimumClearanceMm) <= 1e-12
        && comparePoint(center, safest.centers[0]) >= 0)) return;
    const dx = center[0] - axisPoint[0], dy = center[1] - axisPoint[1];
    safest = {
      centers: [center], radiusMm: Math.hypot(dx, dy),
      rotationRad: positiveAngle(Math.atan2(dy, dx)), minimumClearanceMm: clearance,
    };
  };
  update(axisPoint, prepared.minimumClearanceMm(axisPoint));
  const xCoordinates = new Set<number>([bounds.minX, bounds.maxX]);
  const yCoordinates = new Set<number>([bounds.minY, bounds.maxY]);
  for (const layer of prepared.layers) {
    for (const loop of [layer.exterior, ...layer.protected]) {
      for (let index = 0; index < loop.length; index += 1) {
        if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
        const point = loop[index], next = loop[(index + 1) % loop.length];
        update(point, prepared.minimumClearanceMm(point));
        update([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2],
          prepared.minimumClearanceMm([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2]));
        xCoordinates.add(point[0]); yCoordinates.add(point[1]);
      }
    }
  }
  if (xCoordinates.size <= 64 && yCoordinates.size <= 64) {
    const xs = [...xCoordinates].sort((left, right) => left - right);
    const ys = [...yCoordinates].sort((left, right) => left - right);
    for (let xIndex = 1; xIndex < xs.length; xIndex += 1) {
      for (let yIndex = 1; yIndex < ys.length; yIndex += 1) {
        checkRuntime(deadline, checkpoint);
        const center: Point2 = [(xs[xIndex - 1] + xs[xIndex]) / 2, (ys[yIndex - 1] + ys[yIndex]) / 2];
        update(center, prepared.minimumClearanceMm(center));
      }
    }
  }
  const cells: SearchCell[] = [makeCell(bounds, prepared, deadline, checkpoint)];
  let visited = 0;
  while (cells.length > 0) {
    cells.sort((left, right) => right.upperClearanceMm - left.upperClearanceMm || comparePoint(left.center, right.center));
    const cell = cells.shift()!;
    visited += 1;
    if (visited > limits.maxSingleCells) {
      throw new RangeError('Fastener single-hole search could not establish bounded manufacturing-resolution completeness');
    }
    update(cell.center, cell.clearanceMm);
    if (shouldPruneFastenerSingleCell({
      bestClearanceMm: safest?.minimumClearanceMm,
      cellUpperClearanceMm: cell.upperClearanceMm,
      requiredClearanceMm: requiredBoundaryClearanceMm,
    })) continue;
    const width = cell.maxX - cell.minX, height = cell.maxY - cell.minY;
    if (width >= height) {
      const midX = (cell.minX + cell.maxX) / 2;
      if (!(midX > cell.minX && midX < cell.maxX)) {
        throw new RangeError('Fastener single-hole search could not resolve a potentially safe representable cell');
      }
      for (const child of [
        { minX: cell.minX, minY: cell.minY, maxX: midX, maxY: cell.maxY },
        { minX: midX, minY: cell.minY, maxX: cell.maxX, maxY: cell.maxY },
      ]) cells.push(makeCell(child, prepared, deadline, checkpoint));
    } else {
      const midY = (cell.minY + cell.maxY) / 2;
      if (!(midY > cell.minY && midY < cell.maxY)) {
        throw new RangeError('Fastener single-hole search could not resolve a potentially safe representable cell');
      }
      for (const child of [
        { minX: cell.minX, minY: cell.minY, maxX: cell.maxX, maxY: midY },
        { minX: cell.minX, minY: midY, maxX: cell.maxX, maxY: cell.maxY },
      ]) cells.push(makeCell(child, prepared, deadline, checkpoint));
    }
  }
  if (!safest || safest.minimumClearanceMm + 1e-12 < requiredBoundaryClearanceMm) return undefined;
  return safest;
}

function featureContour(
  center: Point2,
  pathRadiusMm: number,
  deadline: number,
  checkpoint: () => void,
): FastenerHoleGeometry {
  checkRuntime(deadline, checkpoint);
  const outer = circleLoop48(center, pathRadiusMm);
  const distinct = new Set<string>();
  for (let pointIndex = 0; pointIndex < outer.length; pointIndex += 1) {
    if ((pointIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    const point = outer[pointIndex];
    if (!point.every(Number.isFinite)) {
      throw new RangeError('Fastener path contour must contain finite representable points');
    }
    distinct.add(`${point[0]}:${point[1]}`);
  }
  if (distinct.size !== outer.length
    || !validatePolygon({ points: outer }, () => checkRuntime(deadline, checkpoint))) {
    throw new RangeError('Fastener path contour must remain distinct, simple, and representable');
  }
  const boundsMm = contourBounds(outer, deadline, checkpoint);
  const areaMm2 = Math.abs(signedArea(outer, deadline, checkpoint));
  if (!Number.isFinite(areaMm2) || areaMm2 <= 0
    || !(boundsMm.maxX > boundsMm.minX) || !(boundsMm.maxY > boundsMm.minY)) {
    throw new RangeError('Fastener path contour must have finite nonzero area and bounds');
  }
  return {
    role: 'CUT_BLACK',
    outer,
    boundsMm,
    areaMm2,
  };
}

function featureIds(layer: FastenerMaterializationLayer): readonly string[] {
  return [
    layer.id,
    layer.exterior.id,
    ...(layer.centralHole ? [layer.centralHole.id] : []),
    ...layer.launcherCuts.map(({ id }) => id),
    ...layer.fastenerHoles.map(({ id }) => id),
    ...layer.deepFeatures.map(({ id }) => id),
    ...layer.lightFeatures.map(({ id }) => id),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireOnlyKeys(
  value: unknown,
  permitted: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => (
    typeof key !== 'string' || !permitted.has(key)
  ))) {
    throw new RangeError(`Fastener ${label} contains an unexpected runtime key or shape`);
  }
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 64 * Math.max(1, Math.abs(left), Math.abs(right));
}

const FASTENER_PLAN_KEYS = new Set([
  'count', 'holes', 'centers', 'finishedDiameterMm', 'pathDiameterMm',
  'radiusMm', 'rotationRad', 'warning',
]);
const FASTENER_GEOMETRY_KEYS = new Set(['role', 'outer', 'boundsMm', 'areaMm2']);
const FASTENER_BOUNDS_KEYS = new Set(['minX', 'minY', 'maxX', 'maxY']);

function validateMaterializationPlan(
  value: FastenerPlan,
  deadline: number,
  checkpoint: () => void,
): void {
  requireOnlyKeys(value, FASTENER_PLAN_KEYS, 'shared plan');
  const count = value.count;
  if (!Number.isInteger(count) || ![0, 1, 2, 3].includes(count)
    || !Array.isArray(value.holes) || value.holes.length !== count
    || !Array.isArray(value.centers) || value.centers.length !== count
    || value.finishedDiameterMm !== FASTENER_FINISHED_DIAMETER_MM
    || !Number.isFinite(value.pathDiameterMm) || value.pathDiameterMm <= 0) {
    throw new RangeError('Fastener materialization requires one bounded shared plan with a consistent count');
  }
  if (count === 0) {
    if (value.warning !== FASTENER_OMISSION_WARNING
      || value.radiusMm !== undefined || value.rotationRad !== undefined) {
      throw new RangeError('Fastener zero-hole plan requires only the canonical omission warning');
    }
    return;
  }
  if (value.warning !== undefined
    || !Number.isFinite(value.radiusMm) || value.radiusMm! < 0
    || !Number.isFinite(value.rotationRad)) {
    throw new RangeError('Fastener nonzero plan requires finite radius and rotation without an omission warning');
  }
  const pathRadiusMm = value.pathDiameterMm / 2;
  for (let index = 0; index < count; index += 1) {
    checkRuntime(deadline, checkpoint);
    const center = value.centers[index];
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
      throw new RangeError('Fastener shared plan centers must be finite two-dimensional points');
    }
    const geometry = value.holes[index];
    if (isRecord(geometry) && Object.hasOwn(geometry, 'id')) {
      throw new RangeError('Fastener shared geometry must remain ID-free');
    }
    requireOnlyKeys(geometry, FASTENER_GEOMETRY_KEYS, 'shared geometry');
    const outer = geometry.outer;
    const areaMm2 = geometry.areaMm2;
    if (geometry.role !== 'CUT_BLACK' || !Array.isArray(outer)
      || outer.length !== 48 || typeof areaMm2 !== 'number'
      || !Number.isFinite(areaMm2) || areaMm2 <= 0) {
      throw new RangeError('Fastener shared geometry requires one finite 48-point CUT_BLACK contour');
    }
    const distinct = new Set<string>();
    for (let pointIndex = 0; pointIndex < outer.length; pointIndex += 1) {
      const point = outer[pointIndex];
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
        throw new RangeError('Fastener shared geometry contour points must be finite');
      }
      distinct.add(`${point[0]}:${point[1]}`);
      const angle = pointIndex * Math.PI * 2 / 48;
      const expected: Point2 = [
        center[0] + Math.cos(angle) * pathRadiusMm,
        center[1] + Math.sin(angle) * pathRadiusMm,
      ];
      if (!nearlyEqual(point[0], expected[0]) || !nearlyEqual(point[1], expected[1])) {
        throw new RangeError('Fastener shared geometry must be consistent with its center and path diameter');
      }
    }
    if (distinct.size !== 48
      || !validatePolygon({ points: outer as readonly Point2[] }, () => checkRuntime(deadline, checkpoint))) {
      throw new RangeError('Fastener shared geometry contour must be distinct and simple');
    }
    requireOnlyKeys(geometry.boundsMm, FASTENER_BOUNDS_KEYS, 'geometry bounds');
    const geometryBounds = geometry.boundsMm;
    const minX = geometryBounds.minX, minY = geometryBounds.minY;
    const maxX = geometryBounds.maxX, maxY = geometryBounds.maxY;
    const bounds = contourBounds(outer as readonly Point2[], deadline, checkpoint);
    const area = Math.abs(signedArea(outer as readonly Point2[], deadline, checkpoint));
    if (![minX, minY, maxX, maxY].every((item) => typeof item === 'number' && Number.isFinite(item))
      || !nearlyEqual(minX as number, bounds.minX)
      || !nearlyEqual(minY as number, bounds.minY)
      || !nearlyEqual(maxX as number, bounds.maxX)
      || !nearlyEqual(maxY as number, bounds.maxY)
      || !nearlyEqual(areaMm2, area)) {
      throw new RangeError('Fastener shared geometry area and bounds must remain consistent');
    }
  }
}

export function materializeFastenerHoles(
  plan: FastenerPlan,
  layers: readonly FastenerMaterializationLayer[],
  deadline = Date.now() + 30_000,
  checkpoint: () => void = () => undefined,
): readonly (readonly FeatureContour[])[] {
  checkRuntime(deadline, checkpoint);
  validateMaterializationPlan(plan, deadline, checkpoint);
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_FASTENER_LAYERS) {
    throw new RangeError('Fastener materialization requires one bounded shared plan and 1 to 24 layers');
  }
  const used = new Set<string>();
  for (const layer of layers) {
    checkRuntime(deadline, checkpoint);
    for (const id of featureIds(layer)) {
      if (typeof id !== 'string' || id.length === 0 || used.has(id)) {
        throw new RangeError('Fastener materialization requires globally unique existing public IDs');
      }
      used.add(id);
    }
  }
  return layers.map((layer) => plan.holes.map((geometry, index): FeatureContour => {
    checkRuntime(deadline, checkpoint);
    const base = `${layer.id}-fastener-hole-${index + 1}`;
    let id = base, suffix = 2;
    while (used.has(id)) {
      checkRuntime(deadline, checkpoint);
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { ...geometry, id };
  }));
}

export function planFastenerHoles(request: FastenerPlanningRequest): FastenerPlan {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  const searchLimits = resolvedSearchLimits(request.searchLimits);
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
    material.minWebMm, deadline, checkpoint, searchLimits,
  ) ?? searchPattern(
    2, request.axisPoint, maximumRadiusMm, prepared, requiredBoundaryClearanceMm,
    material.minWebMm, deadline, checkpoint, searchLimits,
  ) ?? searchSingle(
    bounds, request.axisPoint, prepared, requiredBoundaryClearanceMm, deadline, checkpoint, searchLimits,
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
  const holes = candidate.centers.map((center) => featureContour(
    center, pathDiameterMm / 2, deadline, checkpoint,
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
