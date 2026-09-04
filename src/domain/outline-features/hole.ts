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
type QualifiedCandidate = SelectedCentralHole & {
  readonly minimum: Point2;
  readonly evidenceAreaMm2: number;
};

function checkDeadline(deadline: number, checkpoint?: () => void): void {
  checkpoint?.();
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
  return point[0] >= Math.min(a[0], b[0]) - lengthTolerance
    && point[0] <= Math.max(a[0], b[0]) + lengthTolerance
    && point[1] >= Math.min(a[1], b[1]) - lengthTolerance
    && point[1] <= Math.max(a[1], b[1]) + lengthTolerance
    && Math.abs(cross(a, b, point)) <= areaTolerance;
}

function segmentsIntersect(
  [a, b]: Segment,
  [c, d]: Segment,
  areaTolerance: number,
  lengthTolerance: number,
): boolean {
  if (Math.max(a[0], b[0]) + lengthTolerance < Math.min(c[0], d[0])
    || Math.max(c[0], d[0]) + lengthTolerance < Math.min(a[0], b[0])
    || Math.max(a[1], b[1]) + lengthTolerance < Math.min(c[1], d[1])
    || Math.max(c[1], d[1]) + lengthTolerance < Math.min(a[1], b[1])) return false;
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
  const consider = (point: Point2, start: Point2, end: Point2): void => {
    if (point[0] < Math.min(start[0], end[0]) - distance
      || point[0] > Math.max(start[0], end[0]) + distance
      || point[1] < Math.min(start[1], end[1]) - distance
      || point[1] > Math.max(start[1], end[1]) + distance) return;
    distance = Math.min(distance, distancePointToSegment(point, start, end));
  };
  for (let innerIndex = 0; innerIndex < inner.length; innerIndex += 1) {
    checkDeadline(deadline);
    const innerStart = inner[innerIndex], innerEnd = inner[(innerIndex + 1) % inner.length];
    for (let outerIndex = 0; outerIndex < outer.length; outerIndex += 1) {
      if ((outerIndex & 63) === 0) checkDeadline(deadline);
      const outerStart = outer[outerIndex], outerEnd = outer[(outerIndex + 1) % outer.length];
      consider(innerStart, outerStart, outerEnd);
      consider(innerEnd, outerStart, outerEnd);
      consider(outerStart, innerStart, innerEnd);
      consider(outerEnd, innerStart, innerEnd);
    }
  }
  return distance;
}

export function isStrictlyContainedLoop(
  exterior: readonly Point2[],
  candidate: readonly Point2[],
  minimumClearance: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): boolean {
  checkDeadline(deadline, checkpoint);
  if (!Number.isFinite(minimumClearance) || minimumClearance < 0) return false;
  const scale = scaleOf(exterior, candidate);
  const areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
    checkDeadline(deadline, checkpoint);
    const start = candidate[candidateIndex], end = candidate[(candidateIndex + 1) % candidate.length];
    if (pointLocation(start, exterior, deadline) !== 1
      || pointLocation([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], exterior, deadline) !== 1) return false;
    for (let exteriorIndex = 0; exteriorIndex < exterior.length; exteriorIndex += 1) {
      if ((exteriorIndex & 63) === 0) checkDeadline(deadline, checkpoint);
      if (segmentsIntersect(
        [start, end],
        [exterior[exteriorIndex], exterior[(exteriorIndex + 1) % exterior.length]],
        areaTolerance,
        lengthTolerance,
      )) return false;
    }
  }
  checkDeadline(deadline, checkpoint);
  return boundaryClearance(candidate, exterior, deadline) + 1e-12 >= minimumClearance;
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

function minimumClearance(request: CentralHoleRequest): number {
  const planarDiameterMm = request.planarDiameterMm ?? request.layerWidthMm;
  return Math.max(request.cellSizeMm, planarDiameterMm * 0.001);
}

function validateRequest(request: CentralHoleRequest, deadline: number): void {
  const planarDiameterMm = request.planarDiameterMm ?? request.layerWidthMm;
  checkDeadline(deadline);
  if (!Number.isFinite(request.layerWidthMm) || request.layerWidthMm <= 0
    || !Number.isFinite(planarDiameterMm) || planarDiameterMm <= 0
    || !Number.isFinite(request.cellSizeMm) || request.cellSizeMm < 0
    || request.axisPoint.some((value) => !Number.isFinite(value))
    || request.candidates.length > 64
    || !isFiniteSimpleLoop(request.exterior, deadline)) {
    throw new RangeError('Central hole selection requires finite bounded exterior evidence');
  }
}

function qualifyCandidates(request: CentralHoleRequest, deadline: number): QualifiedCandidate[] {
  validateRequest(request, deadline);
  const minimumDiameter = Math.max(0.5, request.layerWidthMm * 0.01);
  const qualified: QualifiedCandidate[] = [];
  for (let candidateIndex = 0; candidateIndex < request.candidates.length; candidateIndex += 1) {
    checkDeadline(deadline);
    const candidate = request.candidates[candidateIndex];
    if (candidate.closed === false || !isFiniteSimpleLoop(candidate.outer, deadline)
      || candidate.occupiedCellCount !== undefined
        && (!Number.isSafeInteger(candidate.occupiedCellCount) || candidate.occupiedCellCount <= 0)) continue;
    if (!isStrictlyContainedLoop(
      request.exterior, candidate.outer, minimumClearance(request), deadline,
    )) continue;
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
      evidenceAreaMm2: evidenceArea,
    });
  }
  return qualified;
}

function qualifyCentralCandidates(request: CentralHoleRequest, deadline: number): QualifiedCandidate[] {
  const qualified = qualifyCandidates(request, deadline);
  if (qualified.length === 0) return qualified;
  const nearest = Math.min(...qualified.map((candidate) => candidate.axisDistanceMm));
  const centralBand = Math.max(0.5, request.layerWidthMm * 0.02);
  return qualified.filter((candidate) => candidate.axisDistanceMm <= nearest + centralBand + 1e-12);
}

function compareQualifiedCandidates(left: QualifiedCandidate, right: QualifiedCandidate): number {
  const areaDifference = right.areaMm2 - left.areaMm2;
  const areaTolerance = Math.max(left.areaMm2, right.areaMm2) * 1e-12;
  return Math.abs(areaDifference) > areaTolerance ? areaDifference
    : left.minimum[0] - right.minimum[0] || left.minimum[1] - right.minimum[1];
}

function withoutPrivateSortEvidence(candidate: QualifiedCandidate): SelectedCentralHole {
  const { minimum: _minimum, evidenceAreaMm2: _evidenceAreaMm2, ...hole } = candidate;
  return hole;
}

function alignCandidateToAxis(
  candidate: QualifiedCandidate,
  axisPoint: Point2,
  deadline: number,
): QualifiedCandidate {
  const sourceArea = signedArea(candidate.outer, deadline);
  const sourceCenter = centroid(candidate.outer, sourceArea, deadline);
  const offsetX = axisPoint[0] - sourceCenter[0], offsetY = axisPoint[1] - sourceCenter[1];
  const outer = candidate.outer.map(([x, y], index): Point2 => {
    if ((index & 63) === 0) checkDeadline(deadline);
    return [x + offsetX, y + offsetY];
  });
  const alignedArea = signedArea(outer, deadline);
  const areaMm2 = Math.abs(alignedArea);
  const alignedCenter = centroid(outer, alignedArea, deadline);
  const candidateBounds = bounds(outer, deadline);
  return {
    outer,
    boundsMm: candidateBounds,
    areaMm2,
    equivalentDiameterMm: 2 * Math.sqrt(candidate.evidenceAreaMm2 / Math.PI),
    axisDistanceMm: Math.hypot(alignedCenter[0] - axisPoint[0], alignedCenter[1] - axisPoint[1]),
    minimum: [candidateBounds.minX, candidateBounds.minY],
    evidenceAreaMm2: candidate.evidenceAreaMm2,
  };
}

function contourKey(points: readonly Point2[], deadline: number): string {
  const coordinate = (point: Point2): string => `${point[0]}:${point[1]}`;
  let start = 0;
  for (let index = 1; index < points.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    if (coordinate(points[index]) < coordinate(points[start])) start = index;
  }
  return Array.from({ length: points.length }, (_, index) => {
    if ((index & 63) === 0) checkDeadline(deadline);
    return coordinate(points[(start + index) % points.length]);
  }).join('|');
}

export function selectCentralHole(request: CentralHoleRequest): CentralHoleSelection {
  const deadline = request.deadline ?? Infinity;
  const central = qualifyCentralCandidates(request, deadline);
  if (central.length === 0) return omission();
  central.sort(compareQualifiedCandidates);
  checkDeadline(deadline);
  return { hole: withoutPrivateSortEvidence(central[0]) };
}

export function selectSharedCentralHole(
  requests: readonly CentralHoleRequest[],
): readonly CentralHoleSelection[] {
  if (requests.length === 0 || requests.length > 24) {
    throw new RangeError('Shared central hole selection requires between one and twenty-four layers');
  }
  const deadline = Math.min(...requests.map((request) => request.deadline ?? Infinity));
  // Ordered extraction requests share one coordinate space. The first layer's axis is canonical
  // when request evidence differs; every source contour is recentered there before safety checks.
  const commonAxisPoint = requests[0].axisPoint;
  const candidates = requests.flatMap((request) => qualifyCentralCandidates(request, deadline))
    .map((candidate) => alignCandidateToAxis(candidate, commonAxisPoint, deadline));
  candidates.sort(compareQualifiedCandidates);
  const contourKeys = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    checkDeadline(deadline);
    const key = contourKey(candidate.outer, deadline);
    if (contourKeys.has(key)) return false;
    contourKeys.add(key);
    return true;
  });
  const shared = uniqueCandidates.find((candidate) => requests.every((request) =>
    isStrictlyContainedLoop(
      request.exterior,
      candidate.outer,
      minimumClearance(request),
      deadline,
    )));
  const selection: CentralHoleSelection = shared
    ? { hole: withoutPrivateSortEvidence(shared) }
    : omission();
  return requests.map(() => selection);
}
