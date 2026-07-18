import type { Point2, Polygon2 } from './types';

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const onSegment = (p: Point2, q: Point2, r: Point2) => Math.abs(cross(p, q, r)) <= 1e-12 && r[0] >= Math.min(p[0], q[0]) && r[0] <= Math.max(p[0], q[0]) && r[1] >= Math.min(p[1], q[1]) && r[1] <= Math.max(p[1], q[1]);
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export function isSimplePolygon(polygon: Polygon2): boolean {
  const { points } = polygon;
  if (points.length < 3) return false;
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return false;
    }
  }
  return true;
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
