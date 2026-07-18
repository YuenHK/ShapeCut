import type { Point2, Polygon2 } from './types';

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2, areaTolerance: number, lengthTolerance: number): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const onSegment = (p: Point2, q: Point2, r: Point2) => Math.abs(cross(p, q, r)) <= areaTolerance
    && r[0] >= Math.min(p[0], q[0]) - lengthTolerance && r[0] <= Math.max(p[0], q[0]) + lengthTolerance
    && r[1] >= Math.min(p[1], q[1]) - lengthTolerance && r[1] <= Math.max(p[1], q[1]) + lengthTolerance;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function isSimplePolygon(polygon: Polygon2): boolean {
  const { points } = polygon;
  if (points.length < 3) return false;
  const scale = polygonScale([polygon]);
  const areaTolerance = scale * scale * 64 * Number.EPSILON, lengthTolerance = scale * 64 * Number.EPSILON;
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext], areaTolerance, lengthTolerance)) return false;
    }
  }
  return true;
}

/** Linear validation for the two monotone chains used by meridional rib silhouettes. */
export function isSimpleXMonotonePolygon(polygon: Polygon2): boolean {
  const { points } = polygon;
  if (points.length < 3 || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return false;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length];
    if (point[0] === next[0] && point[1] === next[1]) return false;
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  if (!Number.isFinite(twiceArea) || twiceArea === 0) return false;
  let minimum = 0, maximum = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][0] < points[minimum][0] || (points[index][0] === points[minimum][0] && points[index][1] < points[minimum][1])) minimum = index;
    if (points[index][0] > points[maximum][0] || (points[index][0] === points[maximum][0] && points[index][1] < points[maximum][1])) maximum = index;
  }
  const chain = (step: 1 | -1): Point2[] => {
    const result: Point2[] = [points[minimum]];
    let index = minimum, priorX = points[index][0];
    while (index !== maximum) {
      index = (index + step + points.length) % points.length;
      if (points[index][0] < priorX) return [];
      priorX = points[index][0];
      result.push(points[index]);
    }
    return result;
  };
  const forward = chain(1), backward = chain(-1);
  if (forward.length === 0 || backward.length === 0) return false;
  type Segment = { readonly start: Point2; readonly end: Point2 };
  const nonVerticalSegments = (pointsOnChain: readonly Point2[]): Segment[] => {
    const segments: Segment[] = [];
    for (let index = 1; index < pointsOnChain.length; index += 1) if (pointsOnChain[index][0] > pointsOnChain[index - 1][0]) segments.push({ start: pointsOnChain[index - 1], end: pointsOnChain[index] });
    return segments;
  };
  const lower = nonVerticalSegments(twiceArea > 0 ? forward : backward), upper = nonVerticalSegments(twiceArea > 0 ? backward : forward);
  if (lower.length === 0 || upper.length === 0) return false;
  const scale = polygonScale([polygon]);
  const tolerance = scale * 64 * Number.EPSILON;
  const yAt = (segment: Segment, x: number): number => segment.start[1] + (segment.end[1] - segment.start[1]) * (x - segment.start[0]) / (segment.end[0] - segment.start[0]);
  let lowerIndex = 0, upperIndex = 0;
  while (lowerIndex < lower.length && upperIndex < upper.length) {
    const lowerSegment = lower[lowerIndex], upperSegment = upper[upperIndex];
    const left = Math.max(lowerSegment.start[0], upperSegment.start[0]), right = Math.min(lowerSegment.end[0], upperSegment.end[0]);
    if (right >= left) {
      for (const x of [left, (left + right) / 2, right]) {
        const separation = yAt(upperSegment, x) - yAt(lowerSegment, x);
        const endpoint = Math.abs(x - points[minimum][0]) <= tolerance || Math.abs(x - points[maximum][0]) <= tolerance;
        if (endpoint ? separation < -tolerance : separation <= tolerance) return false;
      }
    }
    if (lowerSegment.end[0] <= upperSegment.end[0]) lowerIndex += 1;
    if (upperSegment.end[0] <= lowerSegment.end[0]) upperIndex += 1;
  }
  return lowerIndex === lower.length && upperIndex === upper.length;
}

/** Convex SAT. Boundary contact counts as intersection/unsafe. */
export function convexPolygonsIntersect(left: Polygon2, right: Polygon2): boolean {
  for (const polygon of [left, right]) {
    for (let index = 0; index < polygon.points.length; index += 1) {
      const a = polygon.points[index], b = polygon.points[(index + 1) % polygon.points.length];
      const axis: Point2 = [-(b[1] - a[1]), b[0] - a[0]];
      let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
      for (const point of left.points) { const value = point[0] * axis[0] + point[1] * axis[1]; leftMin = Math.min(leftMin, value); leftMax = Math.max(leftMax, value); }
      for (const point of right.points) { const value = point[0] * axis[0] + point[1] * axis[1]; rightMin = Math.min(rightMin, value); rightMax = Math.max(rightMax, value); }
      if (leftMax < rightMin || rightMax < leftMin) return false;
    }
  }
  return true;
}

export function validateRadialSlots(slots: readonly Polygon2[], innerRadius: number, outerRadius: number, margin: number): boolean {
  if (!(innerRadius >= 0) || !(outerRadius > innerRadius + margin * 2)) return false;
  for (const slot of slots) for (const point of slot.points) {
    const radius = Math.hypot(point[0], point[1]);
    if (!Number.isFinite(radius) || radius <= innerRadius + margin || radius >= outerRadius - margin) return false;
  }
  for (let left = 0; left < slots.length; left += 1) for (let right = left + 1; right < slots.length; right += 1) {
    if (convexPolygonsIntersect(slots[left], slots[right])) return false;
  }
  return true;
}

function polygonScale(polygons: readonly Polygon2[]): number {
  let scale = Number.MIN_VALUE;
  for (const polygon of polygons) for (const [x, y] of polygon.points) scale = Math.max(scale, Math.abs(x), Math.abs(y));
  return scale;
}

function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1], lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dy);
}

function strictSegmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2, tolerance: number): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const on = (p: Point2, q: Point2, r: Point2): boolean => Math.abs(cross(p, q, r)) <= tolerance
    && r[0] >= Math.min(p[0], q[0]) - tolerance && r[0] <= Math.max(p[0], q[0]) + tolerance
    && r[1] >= Math.min(p[1], q[1]) - tolerance && r[1] <= Math.max(p[1], q[1]) + tolerance;
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

function polygonBoundaryDistance(left: Polygon2, right: Polygon2, tolerance: number): number {
  let minimum = Infinity;
  for (let leftIndex = 0; leftIndex < left.points.length; leftIndex += 1) {
    const a = left.points[leftIndex], b = left.points[(leftIndex + 1) % left.points.length];
    for (let rightIndex = 0; rightIndex < right.points.length; rightIndex += 1) {
      const c = right.points[rightIndex], d = right.points[(rightIndex + 1) % right.points.length];
      if (strictSegmentsIntersect(a, b, c, d, tolerance)) return 0;
      minimum = Math.min(minimum, pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
    }
  }
  return minimum;
}

/** Validates open radial cut polygons against the actual convex support and complete hole edges. */
export function validateOpenRadialNotches(cuts: readonly Polygon2[], support: Polygon2, holes: readonly Polygon2[], margin: number): boolean {
  if (!Number.isFinite(margin) || margin < 0 || support.points.length < 3 || cuts.some((cut) => cut.points.length !== 4)) return false;
  const scale = polygonScale([support, ...holes, ...cuts]);
  const tolerance = Math.max(Number.MIN_VALUE, scale * scale * 64 * Number.EPSILON);
  let supportArea = 0;
  for (let index = 0; index < support.points.length; index += 1) {
    const point = support.points[index], next = support.points[(index + 1) % support.points.length];
    supportArea += point[0] * next[1] - next[0] * point[1];
  }
  const winding = Math.sign(supportArea);
  if (winding === 0) return false;
  for (const cut of cuts) {
    for (let pointIndex = 0; pointIndex < cut.points.length; pointIndex += 1) {
      const point = cut.points[pointIndex];
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
      const requiredMargin = pointIndex === 1 || pointIndex === 2 ? 0 : margin;
      for (let edge = 0; edge < support.points.length; edge += 1) {
        const start = support.points[edge], end = support.points[(edge + 1) % support.points.length];
        const edgeLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (winding * cross(start, end, point) < requiredMargin * edgeLength - tolerance) return false;
      }
    }
    for (const hole of holes) {
      if (convexPolygonsIntersect(cut, hole) || polygonBoundaryDistance(cut, hole, tolerance) <= margin) return false;
    }
  }
  for (let left = 0; left < cuts.length; left += 1) for (let right = left + 1; right < cuts.length; right += 1) {
    if (convexPolygonsIntersect(cuts[left], cuts[right])) return false;
  }
  return true;
}
