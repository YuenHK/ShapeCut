import type { Point2, Polygon2 } from '../decomposition/types';

export const MAX_ENGRAVING_REGIONS = 4096;
export const MAX_POLYGON_POINTS = 4096;

type Bounds = { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
type GeometryCache<T> = { readonly signature: string; readonly value: T };
const triangulationCache = new WeakMap<object, GeometryCache<Point2[][]>>();
const canonicalKeyCache = new WeakMap<object, GeometryCache<string>>();

/** Runtime callers can mutate nominally readonly input, so cache entries carry an exact coordinate signature. */
function polygonSignature(polygon: Polygon2): string {
  return polygon.points.map(([x, y]) => `${x},${y}`).join(';');
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function bounds(polygon: Polygon2): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon.points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function geometryScale(polygon: Polygon2): number {
  const box = bounds(polygon);
  return Math.max(Number.MIN_VALUE, box.maxX - box.minX, box.maxY - box.minY);
}

function lengthTolerance(polygons: readonly Polygon2[]): number {
  let scale = Number.MIN_VALUE, coordinate = 1;
  for (const polygon of polygons) {
    scale = Math.max(scale, geometryScale(polygon));
    for (const [x, y] of polygon.points) coordinate = Math.max(coordinate, Math.abs(x), Math.abs(y));
  }
  return Math.max(Number.MIN_VALUE, scale * 128 * Number.EPSILON, coordinate * 32 * Number.EPSILON);
}

function signedArea(polygon: Polygon2): number {
  const reference = polygon.points[0];
  let twiceArea = 0;
  for (let index = 1; index + 1 < polygon.points.length; index += 1) {
    twiceArea += cross(reference, polygon.points[index], polygon.points[index + 1]);
  }
  return twiceArea / 2;
}

function pointOnSegment(point: Point2, start: Point2, end: Point2, tolerance: number): boolean {
  const scale = Math.max(1, Math.hypot(end[0] - start[0], end[1] - start[1]));
  if (Math.abs(cross(start, end, point)) > tolerance * scale) return false;
  return point[0] >= Math.min(start[0], end[0]) - tolerance
    && point[0] <= Math.max(start[0], end[0]) + tolerance
    && point[1] >= Math.min(start[1], end[1]) - tolerance
    && point[1] <= Math.max(start[1], end[1]) + tolerance;
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2, tolerance: number): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return pointOnSegment(c, a, b, tolerance) || pointOnSegment(d, a, b, tolerance)
    || pointOnSegment(a, c, d, tolerance) || pointOnSegment(b, c, d, tolerance);
}

export function validatePolygon(polygon: Polygon2, checkpointOrIndex: (() => void) | number = () => undefined): boolean {
  const checkpoint = typeof checkpointOrIndex === 'function' ? checkpointOrIndex : () => undefined;
  if (polygon === null || typeof polygon !== 'object' || !Array.isArray(polygon.points)
    || polygon.points.length < 3 || polygon.points.length > MAX_POLYGON_POINTS) return false;
  for (let index = 0; index < polygon.points.length; index += 1) {
    if (!(index in polygon.points)) return false;
    const point = polygon.points[index];
    if (!Array.isArray(point) || point.length !== 2 || !(0 in point) || !(1 in point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  }
  const tolerance = lengthTolerance([polygon]);
  for (let index = 0; index < polygon.points.length; index += 1) {
    const point = polygon.points[index], next = polygon.points[(index + 1) % polygon.points.length];
    if (Math.hypot(next[0] - point[0], next[1] - point[1]) <= tolerance) return false;
  }
  const scale = geometryScale(polygon);
  if (Math.abs(signedArea(polygon)) <= scale * scale * 128 * Number.EPSILON) return false;
  for (let first = 0; first < polygon.points.length; first += 1) {
    checkpoint();
    const firstNext = (first + 1) % polygon.points.length;
    for (let second = first + 1; second < polygon.points.length; second += 1) {
      if ((second & 63) === 0) checkpoint();
      const secondNext = (second + 1) % polygon.points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(polygon.points[first], polygon.points[firstNext], polygon.points[second], polygon.points[secondNext], tolerance)) return false;
    }
  }
  return true;
}

export function clonePolygon(polygon: Polygon2): Polygon2 {
  return { points: polygon.points.map(([x, y]) => [x, y] as const) };
}

/** Returns -1 outside, 0 on the boundary, and 1 inside. */
export function pointLocation(polygon: Polygon2, point: Point2): -1 | 0 | 1 {
  const tolerance = lengthTolerance([polygon]);
  let inside = false;
  for (let index = 0, previous = polygon.points.length - 1; index < polygon.points.length; previous = index++) {
    const a = polygon.points[previous], b = polygon.points[index];
    if (pointOnSegment(point, a, b, tolerance)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (x > point[0]) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function pointInTriangle(point: Point2, a: Point2, b: Point2, c: Point2, tolerance: number): boolean {
  const first = cross(a, b, point), second = cross(b, c, point), third = cross(c, a, point);
  return first >= -tolerance && second >= -tolerance && third >= -tolerance;
}

function triangulate(polygon: Polygon2): Point2[][] {
  const signature = polygonSignature(polygon);
  const cached = triangulationCache.get(polygon);
  if (cached?.signature === signature) return cached.value;
  const points = signedArea(polygon) > 0 ? [...polygon.points] : [...polygon.points].reverse();
  const indices = points.map((_, index) => index), triangles: Point2[][] = [];
  const scale = geometryScale(polygon), areaTolerance = scale * scale * 128 * Number.EPSILON;
  let guard = 0;
  while (indices.length > 3 && guard++ < points.length * points.length) {
    let clipped = false;
    for (let offset = 0; offset < indices.length; offset += 1) {
      const before = indices[(offset + indices.length - 1) % indices.length], current = indices[offset], after = indices[(offset + 1) % indices.length];
      const a = points[before], b = points[current], c = points[after];
      if (cross(a, b, c) <= areaTolerance) continue;
      let contains = false;
      for (const candidate of indices) {
        if (candidate === before || candidate === current || candidate === after) continue;
        if (pointInTriangle(points[candidate], a, b, c, areaTolerance)) { contains = true; break; }
      }
      if (contains) continue;
      triangles.push([a, b, c]);
      indices.splice(offset, 1);
      clipped = true;
      break;
    }
    if (!clipped) return [];
  }
  if (indices.length === 3) triangles.push(indices.map((index) => points[index]));
  triangulationCache.set(polygon, { signature, value: triangles });
  return triangles;
}

function clipAgainstEdge(subject: Point2[], a: Point2, b: Point2, tolerance: number): Point2[] {
  const output: Point2[] = [];
  for (let index = 0; index < subject.length; index += 1) {
    const current = subject[index], previous = subject[(index + subject.length - 1) % subject.length];
    const currentCross = cross(a, b, current), previousCross = cross(a, b, previous);
    const currentInside = currentCross >= -tolerance, previousInside = previousCross >= -tolerance;
    if (currentInside !== previousInside) {
      const denominator = previousCross - currentCross;
      if (denominator !== 0) {
        const ratio = previousCross / denominator;
        output.push([
          previous[0] + (current[0] - previous[0]) * ratio,
          previous[1] + (current[1] - previous[1]) * ratio,
        ]);
      }
    }
    if (currentInside) output.push(current);
  }
  return output;
}

function triangleIntersectionArea(left: readonly Point2[], right: readonly Point2[], tolerance: number): number {
  let clipped = [...left];
  for (let index = 0; index < 3 && clipped.length > 0; index += 1) clipped = clipAgainstEdge(clipped, right[index], right[(index + 1) % 3], tolerance);
  if (clipped.length < 3) return 0;
  let area = 0;
  const reference = clipped[0];
  for (let index = 1; index + 1 < clipped.length; index += 1) area += Math.abs(cross(reference, clipped[index], clipped[index + 1])) / 2;
  return area;
}

function boundsOverlap(left: Bounds, right: Bounds, tolerance: number): boolean {
  return left.maxX >= right.minX - tolerance && right.maxX >= left.minX - tolerance
    && left.maxY >= right.minY - tolerance && right.maxY >= left.minY - tolerance;
}

export function polygonIntersectionArea(left: Polygon2, right: Polygon2): number {
  const tolerance = lengthTolerance([left, right]);
  if (!boundsOverlap(bounds(left), bounds(right), tolerance)) return 0;
  const leftTriangles = triangulate(left), rightTriangles = triangulate(right);
  if (leftTriangles.length === 0 || rightTriangles.length === 0) return Number.NaN;
  const scale = Math.min(geometryScale(left), geometryScale(right));
  const areaTolerance = scale * scale * 512 * Number.EPSILON;
  let sum = 0, correction = 0;
  for (const first of leftTriangles) for (const second of rightTriangles) {
    const value = triangleIntersectionArea(first, second, areaTolerance);
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

export function polygonsOverlapArea(left: Polygon2, right: Polygon2): boolean {
  const tolerance = lengthTolerance([left, right]);
  if (!boundsOverlap(bounds(left), bounds(right), tolerance)) return false;
  if (canonicalPolygonKey(left) === canonicalPolygonKey(right)) return true;
  const intersectionArea = polygonIntersectionArea(left, right);
  if (!Number.isFinite(intersectionArea)) return true;
  const smallerArea = Math.min(polygonMassProperties(left).area, polygonMassProperties(right).area);
  // Uncertainty is bounded relative to an accepted polygon's own area. A
  // scale-squared floor can exceed an ultra-thin polygon's entire valid area.
  const areaTolerance = Math.max(Number.MIN_VALUE, smallerArea * 4096 * Number.EPSILON);
  return intersectionArea > areaTolerance;
}

export function polygonsIntersectOrTouch(left: Polygon2, right: Polygon2, checkpoint: () => void = () => undefined): boolean {
  if (polygonsOverlapArea(left, right)) return true;
  const tolerance = lengthTolerance([left, right]);
  if (!boundsOverlap(bounds(left), bounds(right), tolerance)) return false;
  for (let leftIndex = 0; leftIndex < left.points.length; leftIndex += 1) for (let rightIndex = 0; rightIndex < right.points.length; rightIndex += 1) {
    if ((rightIndex & 63) === 0) checkpoint();
    if (segmentsIntersect(left.points[leftIndex], left.points[(leftIndex + 1) % left.points.length], right.points[rightIndex], right.points[(rightIndex + 1) % right.points.length], tolerance)) return true;
  }
  return pointLocation(left, right.points[0]) >= 0 || pointLocation(right, left.points[0]) >= 0;
}

export function rotatePolygon(polygon: Polygon2, angle: number, center: Point2): Polygon2 {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return { points: polygon.points.map(([x, y]) => {
    const dx = x - center[0], dy = y - center[1];
    const rotatedX = center[0] + dx * cosine - dy * sine, rotatedY = center[1] + dx * sine + dy * cosine;
    return [Math.abs(rotatedX) < 1e-15 ? 0 : rotatedX, Math.abs(rotatedY) < 1e-15 ? 0 : rotatedY] as const;
  }) };
}

export function canonicalPolygonKey(polygon: Polygon2): string {
  const signature = polygonSignature(polygon);
  const cached = canonicalKeyCache.get(polygon);
  if (cached?.signature === signature) return cached.value;
  const scale = geometryScale(polygon), tolerance = Math.max(Number.MIN_VALUE, scale * 1024 * Number.EPSILON);
  const encoded = polygon.points.map(([x, y]) => `${Math.round(x / tolerance)},${Math.round(y / tolerance)}`);
  const leastRotation = (values: readonly string[]): number => {
    const count = values.length;
    let left = 0, right = 1, offset = 0;
    while (left < count && right < count && offset < count) {
      const first = values[(left + offset) % count], second = values[(right + offset) % count];
      if (first === second) { offset += 1; continue; }
      if (first > second) { left += offset + 1; if (left === right) left += 1; }
      else { right += offset + 1; if (left === right) right += 1; }
      offset = 0;
    }
    return Math.min(left, right);
  };
  const keyAtLeastRotation = (values: readonly string[]): string => {
    const start = leastRotation(values), ordered = new Array<string>(values.length);
    for (let index = 0; index < values.length; index += 1) ordered[index] = values[(start + index) % values.length];
    return ordered.join(';');
  };
  const forward = keyAtLeastRotation(encoded), backward = keyAtLeastRotation([...encoded].reverse());
  const key = forward < backward ? forward : backward;
  canonicalKeyCache.set(polygon, { signature, value: key });
  return key;
}

export function polygonMassProperties(polygon: Polygon2): { readonly area: number; readonly centroid: Point2 } {
  const reference = polygon.points[0];
  const scale = geometryScale(polygon);
  let normalizedTwiceArea = 0, normalizedCentroidX = 0, normalizedCentroidY = 0;
  for (let index = 1; index + 1 < polygon.points.length; index += 1) {
    const b = polygon.points[index], c = polygon.points[index + 1];
    const bx = (b[0] - reference[0]) / scale, by = (b[1] - reference[1]) / scale;
    const cx = (c[0] - reference[0]) / scale, cy = (c[1] - reference[1]) / scale;
    const localCross = bx * cy - by * cx;
    normalizedTwiceArea += localCross;
    normalizedCentroidX += (bx + cx) * localCross;
    normalizedCentroidY += (by + cy) * localCross;
  }
  const area = Math.abs(normalizedTwiceArea) * scale * scale / 2;
  return {
    area,
    centroid: [
      reference[0] + scale * normalizedCentroidX / (3 * normalizedTwiceArea),
      reference[1] + scale * normalizedCentroidY / (3 * normalizedTwiceArea),
    ],
  };
}

/** Exact polar second area moment integral of x^2+y^2 about coordinate origin. */
export function polygonPolarSecondMoment(polygon: Polygon2): number {
  let scale = Number.MIN_VALUE;
  for (const [x, y] of polygon.points) scale = Math.max(scale, Math.abs(x), Math.abs(y));
  let normalizedMoment = 0;
  for (let index = 0; index < polygon.points.length; index += 1) {
    const point = polygon.points[index], next = polygon.points[(index + 1) % polygon.points.length];
    const x = point[0] / scale, y = point[1] / scale, nextX = next[0] / scale, nextY = next[1] / scale;
    const edgeCross = x * nextY - nextX * y;
    normalizedMoment += edgeCross * (x * x + x * nextX + nextX * nextX + y * y + y * nextY + nextY * nextY);
  }
  return Math.abs(normalizedMoment) * scale * scale * scale * scale / 12;
}
