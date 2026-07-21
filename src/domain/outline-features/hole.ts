import type { Point2 } from '../decomposition/types';
import type { Bounds2 } from '../outline-2.5d/simplify';

export const CENTRAL_HOLE_OMISSION_WARNING = 'No reliable central axle hole was found; the hole was omitted.';

export type CentralHoleCandidate = {
  readonly outer: readonly Point2[];
  /** Raster candidates carry direct occupied-cell area evidence. */
  readonly occupiedCellCount?: number;
  /** Explicitly false means the source boundary was observed to be open. */
  readonly closed?: boolean;
};

export type SelectedCentralHole = {
  readonly outer: readonly Point2[];
  readonly boundsMm: Bounds2;
  readonly areaMm2: number;
  readonly equivalentDiameterMm: number;
  readonly axisDistanceMm: number;
};

export type CentralHoleRequest = {
  readonly candidates: readonly CentralHoleCandidate[];
  readonly exterior: readonly Point2[];
  readonly axisPoint: Point2;
  readonly layerWidthMm: number;
  readonly planarDiameterMm?: number;
  readonly cellSizeMm: number;
  readonly deadline?: number;
};

export type CentralHoleSelection =
  | { readonly hole: SelectedCentralHole; readonly omissionReason?: undefined; readonly warning?: undefined }
  | {
    readonly hole: undefined;
    readonly omissionReason: 'NO_RELIABLE_CENTRAL_HOLE';
    readonly warning: typeof CENTRAL_HOLE_OMISSION_WARNING;
  };

type Segment = readonly [Point2, Point2];
type QualifiedCandidate = SelectedCentralHole & { readonly minimum: Point2 };

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new RangeError('Central hole selection exceeded the runtime budget');
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function signedArea(points: readonly Point2[], deadline: number): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const point = points[index], next = points[(index + 1) % points.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return twiceArea / 2;
}

function bounds(points: readonly Point2[], deadline: number): Bounds2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const [x, y] = points[index];
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function scaleOf(...loops: readonly (readonly Point2[])[]): number {
  let scale = 1;
  for (const loop of loops) for (const [x, y] of loop) scale = Math.max(scale, Math.abs(x), Math.abs(y));
  return scale;
}

function onSegment(a: Point2, b: Point2, point: Point2, areaTolerance: number, lengthTolerance: number): boolean {
  return Math.abs(cross(a, b, point)) <= areaTolerance
    && point[0] >= Math.min(a[0], b[0]) - lengthTolerance
    && point[0] <= Math.max(a[0], b[0]) + lengthTolerance
    && point[1] >= Math.min(a[1], b[1]) - lengthTolerance
    && point[1] <= Math.max(a[1], b[1]) + lengthTolerance;
}

function segmentsIntersect(
  [a, b]: Segment,
  [c, d]: Segment,
  areaTolerance: number,
  lengthTolerance: number,
): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > areaTolerance && abD < -areaTolerance) || (abC < -areaTolerance && abD > areaTolerance))
    && ((cdA > areaTolerance && cdB < -areaTolerance) || (cdA < -areaTolerance && cdB > areaTolerance))) return true;
  return onSegment(a, b, c, areaTolerance, lengthTolerance)
    || onSegment(a, b, d, areaTolerance, lengthTolerance)
    || onSegment(c, d, a, areaTolerance, lengthTolerance)
    || onSegment(c, d, b, areaTolerance, lengthTolerance);
}

function isFiniteSimpleLoop(points: readonly Point2[], deadline: number): boolean {
  if (points.length < 3 || points.length > 4096) return false;
  const unique = new Set<string>();
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const point = points[index], next = points[(index + 1) % points.length];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])
      || point[0] === next[0] && point[1] === next[1]) return false;
    unique.add(`${point[0]}:${point[1]}`);
  }
  if (unique.size < 3 || Math.abs(signedArea(points, deadline)) === 0) return false;
  const scale = scaleOf(points), areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  for (let first = 0; first < points.length; first += 1) {
    checkDeadline(deadline);
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      if ((second & 63) === 0) checkDeadline(deadline);
      const secondNext = (second + 1) % points.length;
      if (firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(
        [points[first], points[firstNext]], [points[second], points[secondNext]],
        areaTolerance, lengthTolerance,
      )) return false;
    }
  }
  return true;
}

function pointLocation(point: Point2, polygon: readonly Point2[], deadline: number): -1 | 0 | 1 {
  const scale = scaleOf(polygon, [point]), areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if (onSegment(a, b, point, areaTolerance, lengthTolerance)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (x > point[0]) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function distancePointToSegment(point: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const parameter = denominator === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator,
  ));
  return Math.hypot(point[0] - (a[0] + parameter * dx), point[1] - (a[1] + parameter * dy));
}

function boundaryClearance(inner: readonly Point2[], outer: readonly Point2[], deadline: number): number {
  let distance = Infinity;
  for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
    checkDeadline(deadline);
    const innerStart = inner[innerIndex], innerEnd = inner[(innerIndex + 1) % inner.length];
    for (let outerIndex = 0; outerIndex < outer.length; outerIndex += 1) {
      if ((outerIndex & 63) === 0) checkDeadline(deadline);
      const outerStart = outer[outerIndex], outerEnd = outer[(outerIndex + 1) % outer.length];
      distance = Math.min(
        distance,
        distancePointToSegment(innerStart, outerStart, outerEnd),
        distancePointToSegment(innerEnd, outerStart, outerEnd),
        distancePointToSegment(outerStart, innerStart, innerEnd),
        distancePointToSegment(outerEnd, innerStart, innerEnd),
      );
    }
  }
  return distance;
}

function centroid(points: readonly Point2[], area: number, deadline: number): Point2 {
  let x = 0, y = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const point = points[index], next = points[(index + 1) % points.length];
    const product = point[0] * next[1] - next[0] * point[1];
    x += (point[0] + next[0]) * product;
    y += (point[1] + next[1]) * product;
  }
  return [x / (6 * area), y / (6 * area)];
}

function omission(): CentralHoleSelection {
  return {
    hole: undefined,
    omissionReason: 'NO_RELIABLE_CENTRAL_HOLE',
    warning: CENTRAL_HOLE_OMISSION_WARNING,
  };
}

export function selectCentralHole(request: CentralHoleRequest): CentralHoleSelection {
  const deadline = request.deadline ?? Infinity;
  checkDeadline(deadline);
  const planarDiameterMm = request.planarDiameterMm ?? request.layerWidthMm;
  if (!Number.isFinite(request.layerWidthMm) || request.layerWidthMm <= 0
    || !Number.isFinite(planarDiameterMm) || planarDiameterMm <= 0
    || !Number.isFinite(request.cellSizeMm) || request.cellSizeMm < 0
    || request.axisPoint.some((value) => !Number.isFinite(value))
    || request.candidates.length > 64
    || !isFiniteSimpleLoop(request.exterior, deadline)) {
    throw new RangeError('Central hole selection requires finite bounded exterior evidence');
  }
  const minimumDiameter = Math.max(0.5, request.layerWidthMm * 0.01);
  const minimumClearance = Math.max(request.cellSizeMm, planarDiameterMm * 0.001);
  const qualified: QualifiedCandidate[] = [];
  for (let candidateIndex = 0; candidateIndex < request.candidates.length; candidateIndex += 1) {
    checkDeadline(deadline);
    const candidate = request.candidates[candidateIndex];
    if (candidate.closed === false || !isFiniteSimpleLoop(candidate.outer, deadline)
      || candidate.occupiedCellCount !== undefined
        && (!Number.isSafeInteger(candidate.occupiedCellCount) || candidate.occupiedCellCount <= 0)) continue;
    if (candidate.outer.some((point) => pointLocation(point, request.exterior, deadline) !== 1)) continue;
    if (boundaryClearance(candidate.outer, request.exterior, deadline) + 1e-12 < minimumClearance) continue;
    const area = signedArea(candidate.outer, deadline), areaMm2 = Math.abs(area);
    const evidenceArea = candidate.occupiedCellCount === undefined
      ? areaMm2
      : candidate.occupiedCellCount * request.cellSizeMm * request.cellSizeMm;
    if (!Number.isFinite(evidenceArea) || evidenceArea <= 0) continue;
    const equivalentDiameterMm = 2 * Math.sqrt(evidenceArea / Math.PI);
    if (equivalentDiameterMm + 1e-12 < minimumDiameter) continue;
    const center = centroid(candidate.outer, area, deadline);
    const axisDistanceMm = Math.hypot(center[0] - request.axisPoint[0], center[1] - request.axisPoint[1]);
    if (!Number.isFinite(axisDistanceMm)) continue;
    const candidateBounds = bounds(candidate.outer, deadline);
    qualified.push({
      outer: area > 0 ? [...candidate.outer] : [...candidate.outer].reverse(),
      boundsMm: candidateBounds,
      areaMm2,
      equivalentDiameterMm,
      axisDistanceMm,
      minimum: [candidateBounds.minX, candidateBounds.minY],
    });
  }
  if (qualified.length === 0) return omission();
  const nearest = Math.min(...qualified.map((candidate) => candidate.axisDistanceMm));
  const centralBand = Math.max(0.5, request.layerWidthMm * 0.02);
  const central = qualified.filter((candidate) => candidate.axisDistanceMm <= nearest + centralBand + 1e-12);
  central.sort((left, right) => {
    const areaDifference = right.areaMm2 - left.areaMm2;
    const areaTolerance = Math.max(left.areaMm2, right.areaMm2) * 1e-12;
    return Math.abs(areaDifference) > areaTolerance ? areaDifference
      : left.minimum[0] - right.minimum[0] || left.minimum[1] - right.minimum[1];
  });
  const { minimum: _minimum, ...hole } = central[0];
  checkDeadline(deadline);
  return { hole };
}
