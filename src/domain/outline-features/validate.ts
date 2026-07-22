import type { Point2 } from '../decomposition/types';
import { contourBounds, signedArea } from '../outline-2.5d/simplify';
import type { FeatureContour, FeatureRole } from './types';
import { isStrictlyContainedLoop } from './hole';

export type DepthFeatureValidationRequest = {
  readonly exterior: readonly Point2[];
  readonly centralHole?: readonly Point2[];
  readonly red?: FeatureContour | readonly FeatureContour[];
  readonly blue?: FeatureContour | readonly FeatureContour[];
  readonly clearanceMm: number;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};

export type DepthFeatureValidation = {
  readonly ok: boolean;
  readonly reasons: readonly string[];
};

type Segment = readonly [Point2, Point2];

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Depth feature validation exceeded the runtime budget');
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function scaleOf(
  loops: readonly (readonly Point2[])[],
  deadline: number,
  checkpoint: () => void,
): number {
  let scale = 1;
  for (const loop of loops) for (let index = 0; index < loop.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const [x, y] = loop[index];
    scale = Math.max(scale, Math.abs(x), Math.abs(y));
  }
  return scale;
}

function onSegment(a: Point2, b: Point2, point: Point2, areaTolerance: number, lengthTolerance: number): boolean {
  return Math.abs(cross(a, b, point)) <= areaTolerance
    && point[0] >= Math.min(a[0], b[0]) - lengthTolerance
    && point[0] <= Math.max(a[0], b[0]) + lengthTolerance
    && point[1] >= Math.min(a[1], b[1]) - lengthTolerance
    && point[1] <= Math.max(a[1], b[1]) + lengthTolerance;
}

function segmentIntersectionKind(
  [a, b]: Segment,
  [c, d]: Segment,
  areaTolerance: number,
  lengthTolerance: number,
): 'none' | 'touch' | 'collinear-overlap' | 'proper' {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > areaTolerance && abD < -areaTolerance) || (abC < -areaTolerance && abD > areaTolerance))
    && ((cdA > areaTolerance && cdB < -areaTolerance) || (cdA < -areaTolerance && cdB > areaTolerance))) {
    return 'proper';
  }
  if ([abC, abD, cdA, cdB].every((value) => Math.abs(value) <= areaTolerance)) {
    const useX = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const leftMinimum = Math.min(a[useX ? 0 : 1], b[useX ? 0 : 1]);
    const leftMaximum = Math.max(a[useX ? 0 : 1], b[useX ? 0 : 1]);
    const rightMinimum = Math.min(c[useX ? 0 : 1], d[useX ? 0 : 1]);
    const rightMaximum = Math.max(c[useX ? 0 : 1], d[useX ? 0 : 1]);
    if (Math.min(leftMaximum, rightMaximum) - Math.max(leftMinimum, rightMinimum) > lengthTolerance) {
      return 'collinear-overlap';
    }
  }
  return onSegment(a, b, c, areaTolerance, lengthTolerance)
    || onSegment(a, b, d, areaTolerance, lengthTolerance)
    || onSegment(c, d, a, areaTolerance, lengthTolerance)
    || onSegment(c, d, b, areaTolerance, lengthTolerance)
    ? 'touch'
    : 'none';
}

function pointLocation(
  point: Point2,
  loop: readonly Point2[],
  areaTolerance: number,
  lengthTolerance: number,
  deadline: number,
  checkpoint: () => void,
): -1 | 0 | 1 {
  let inside = false;
  for (let index = 0; index < loop.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const a = loop[index], b = loop[(index + 1) % loop.length];
    if (onSegment(a, b, point, areaTolerance, lengthTolerance)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const intersectionX = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (intersectionX > point[0]) inside = !inside;
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
  return Math.hypot(point[0] - a[0] - parameter * dx, point[1] - a[1] - parameter * dy);
}

function boundaryClearance(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let minimum = Infinity;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const leftStart = left[leftIndex], leftEnd = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if ((rightIndex & 63) === 0) checkRuntime(deadline, checkpoint);
      const rightStart = right[rightIndex], rightEnd = right[(rightIndex + 1) % right.length];
      minimum = Math.min(
        minimum,
        distancePointToSegment(leftStart, rightStart, rightEnd),
        distancePointToSegment(leftEnd, rightStart, rightEnd),
        distancePointToSegment(rightStart, leftStart, leftEnd),
        distancePointToSegment(rightEnd, leftStart, leftEnd),
      );
    }
  }
  return minimum;
}

function simpleLoop(
  points: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): boolean {
  if (points.length < 3 || points.length > 4096) return false;
  const unique = new Set<string>(), scale = scaleOf([points], deadline, checkpoint);
  const areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const point = points[index], next = points[(index + 1) % points.length];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])
      || point[0] === next[0] && point[1] === next[1]) return false;
    unique.add(`${point[0]}:${point[1]}`);
  }
  if (unique.size < 3 || Math.abs(signedArea(points, deadline, checkpoint)) <= areaTolerance) return false;
  for (let first = 0; first < points.length; first += 1) {
    checkRuntime(deadline, checkpoint);
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      if ((second & 63) === 0) checkRuntime(deadline, checkpoint);
      const secondNext = (second + 1) % points.length;
      if (firstNext === second || secondNext === first) continue;
      if (segmentIntersectionKind(
        [points[first], points[firstNext]], [points[second], points[secondNext]],
        areaTolerance, lengthTolerance,
      ) !== 'none') return false;
    }
  }
  return true;
}

function contourReasons(
  contour: FeatureContour,
  role: FeatureRole,
  label: string,
  deadline: number,
  checkpoint: () => void,
): string[] {
  checkRuntime(deadline, checkpoint);
  const reasons: string[] = [];
  if (contour.role !== role) reasons.push(`${label} role must be ${role}`);
  if (typeof contour.id !== 'string' || contour.id.trim().length === 0) reasons.push(`${label} ID must be non-empty`);
  if (!Array.isArray(contour.outer) || !simpleLoop(contour.outer, deadline, checkpoint)) {
    reasons.push(`${label} must be a finite simple closed contour with 3 to 4096 points`);
    return reasons;
  }
  const actualBounds = contourBounds(contour.outer, deadline, checkpoint);
  const actualArea = Math.abs(signedArea(contour.outer, deadline, checkpoint));
  const metadata = contour.boundsMm;
  const values = metadata && [metadata.minX, metadata.minY, metadata.maxX, metadata.maxY];
  const tolerance = Math.max(1e-9, scaleOf([contour.outer], deadline, checkpoint) * 1e-9);
  if (!values || !values.every(Number.isFinite)
    || Math.abs(actualBounds.minX - metadata.minX) > tolerance
    || Math.abs(actualBounds.minY - metadata.minY) > tolerance
    || Math.abs(actualBounds.maxX - metadata.maxX) > tolerance
    || Math.abs(actualBounds.maxY - metadata.maxY) > tolerance) {
    reasons.push(`${label} bounds metadata must match its geometry`);
  }
  if (!Number.isFinite(contour.areaMm2) || contour.areaMm2 <= 0
    || Math.abs(actualArea - contour.areaMm2) > Math.max(1e-9, actualArea * 1e-9)) {
    reasons.push(`${label} area metadata must match its geometry`);
  }
  return reasons;
}

function loopsOverlap(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): boolean {
  const scale = scaleOf([left, right], deadline, checkpoint), areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  const leftOrientation = Math.sign(signedArea(left, deadline, checkpoint));
  const rightOrientation = Math.sign(signedArea(right, deadline, checkpoint));
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    checkRuntime(deadline, checkpoint);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if ((rightIndex & 63) === 0) checkRuntime(deadline, checkpoint);
      const leftStart = left[leftIndex], leftEnd = left[(leftIndex + 1) % left.length];
      const rightStart = right[rightIndex], rightEnd = right[(rightIndex + 1) % right.length];
      const intersection = segmentIntersectionKind(
        [leftStart, leftEnd],
        [rightStart, rightEnd],
        areaTolerance,
        lengthTolerance,
      );
      if (intersection === 'proper') return true;
      if (intersection === 'collinear-overlap') {
        const leftDx = leftEnd[0] - leftStart[0], leftDy = leftEnd[1] - leftStart[1];
        const rightDx = rightEnd[0] - rightStart[0], rightDy = rightEnd[1] - rightStart[1];
        const leftLength = Math.hypot(leftDx, leftDy), rightLength = Math.hypot(rightDx, rightDy);
        const leftNormal: Point2 = [
          -leftDy / leftLength * leftOrientation,
          leftDx / leftLength * leftOrientation,
        ];
        const rightNormal: Point2 = [
          -rightDy / rightLength * rightOrientation,
          rightDx / rightLength * rightOrientation,
        ];
        if (leftNormal[0] * rightNormal[0] + leftNormal[1] * rightNormal[1] > 0) return true;
      }
    }
  }
  const leftLocations = left.map((point) => pointLocation(
    point, right, areaTolerance, lengthTolerance, deadline, checkpoint,
  ));
  if (leftLocations.some((location) => location === 1)) return true;
  const rightLocations = right.map((point) => pointLocation(
    point, left, areaTolerance, lengthTolerance, deadline, checkpoint,
  ));
  return rightLocations.some((location) => location === 1)
    || leftLocations.every((location) => location === 0) && rightLocations.every((location) => location === 0);
}

function conflictsWithHole(
  feature: readonly Point2[],
  hole: readonly Point2[],
  clearanceMm: number,
  deadline: number,
  checkpoint: () => void,
): boolean {
  const scale = scaleOf([feature, hole], deadline, checkpoint), areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  if (boundaryClearance(feature, hole, deadline, checkpoint) <= clearanceMm + 1e-12) return true;
  if (feature.some((point) => pointLocation(
    point, hole, areaTolerance, lengthTolerance, deadline, checkpoint,
  ) >= 0)) return true;
  return hole.some((point) => pointLocation(
    point, feature, areaTolerance, lengthTolerance, deadline, checkpoint,
  ) >= 0);
}

function roleFeatures(value: FeatureContour | readonly FeatureContour[] | undefined): readonly FeatureContour[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as FeatureContour];
}

export function validateDepthFeatureContours(request: DepthFeatureValidationRequest): DepthFeatureValidation {
  const deadline = request.deadline ?? Infinity, checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  const reasons: string[] = [];
  if (!Number.isFinite(request.clearanceMm) || request.clearanceMm < 0) {
    return { ok: false, reasons: ['Depth feature clearance must be finite and non-negative'] };
  }
  if (!simpleLoop(request.exterior, deadline, checkpoint)) {
    return { ok: false, reasons: ['Depth feature exterior must be a finite simple closed contour'] };
  }
  if (request.centralHole && !simpleLoop(request.centralHole, deadline, checkpoint)) {
    return { ok: false, reasons: ['Depth feature central hole must be a finite simple closed contour'] };
  }
  const red = roleFeatures(request.red), blue = roleFeatures(request.blue);
  if (red.length > 12) reasons.push('At most 12 DEEP_RED features are permitted');
  if (blue.length > 12) reasons.push('At most 12 LIGHT_BLUE features are permitted');
  const candidates: {
    readonly feature: FeatureContour;
    readonly role: 'DEEP_RED' | 'LIGHT_BLUE';
    readonly label: string;
  }[] = [];
  for (const [index, feature] of red.entries()) {
    candidates.push({ feature, role: 'DEEP_RED', label: `Deep feature ${index + 1}` });
  }
  for (const [index, feature] of blue.entries()) {
    candidates.push({ feature, role: 'LIGHT_BLUE', label: `Light feature ${index + 1}` });
  }
  const validCandidates: typeof candidates = [];
  for (const candidate of candidates) {
    checkRuntime(deadline, checkpoint);
    const featureReasons = contourReasons(
      candidate.feature, candidate.role, candidate.label, deadline, checkpoint,
    );
    reasons.push(...featureReasons);
    if (featureReasons.length > 0) continue;
    validCandidates.push(candidate);
    if (!isStrictlyContainedLoop(
      request.exterior,
      candidate.feature.outer,
      request.clearanceMm,
      deadline,
      checkpoint,
    )) reasons.push(`${candidate.label} must be strictly contained by the exterior with required clearance`);
    if (request.centralHole && conflictsWithHole(
      candidate.feature.outer, request.centralHole, request.clearanceMm, deadline, checkpoint,
    )) reasons.push(`${candidate.label} must not overlap or touch the central hole clearance`);
  }
  const validRed = validCandidates.filter((candidate) => candidate.role === 'DEEP_RED');
  const validBlue = validCandidates.filter((candidate) => candidate.role === 'LIGHT_BLUE');
  for (const redFeature of validRed) for (const blueFeature of validBlue) {
    if (loopsOverlap(redFeature.feature.outer, blueFeature.feature.outer, deadline, checkpoint)) {
      reasons.push('Deep and light features must not overlap');
    }
  }
  checkRuntime(deadline, checkpoint);
  return { ok: reasons.length === 0, reasons };
}

export function assertValidDepthFeatureContours(request: DepthFeatureValidationRequest): void {
  const validation = validateDepthFeatureContours(request);
  if (!validation.ok) throw new RangeError(`Invalid depth feature geometry: ${validation.reasons.join('; ')}`);
}
