import type { Point2, Polygon2 } from '../decomposition/types';
import { polygonsOverlapArea, validatePolygon } from '../engraving/geometry';

export interface PolygonKernel {
  offset(polygon: Polygon2, mm: number): Polygon2[];
  intersects(left: Polygon2, right: Polygon2): boolean;
}

function signedArea({ points }: Polygon2): number {
  return points.reduce((sum, [x, y], index) => {
    const next = points[(index + 1) % points.length];
    return sum + x * next[1] - next[0] * y;
  }, 0) / 2;
}

function isConvex(polygon: Polygon2): boolean {
  const orientation = Math.sign(signedArea(polygon));
  for (let index = 0; index < polygon.points.length; index += 1) {
    const prior = polygon.points[(index - 1 + polygon.points.length) % polygon.points.length];
    const point = polygon.points[index];
    const next = polygon.points[(index + 1) % polygon.points.length];
    const cross = (point[0] - prior[0]) * (next[1] - point[1]) - (point[1] - prior[1]) * (next[0] - point[0]);
    if (cross !== 0 && Math.sign(cross) !== orientation) return false;
  }
  return true;
}

function intersection(a: Point2, directionA: Point2, b: Point2, directionB: Point2): Point2 | undefined {
  const denominator = directionA[0] * directionB[1] - directionA[1] * directionB[0];
  if (Math.abs(denominator) <= 64 * Number.EPSILON) return undefined;
  const t = ((b[0] - a[0]) * directionB[1] - (b[1] - a[1]) * directionB[0]) / denominator;
  return [a[0] + directionA[0] * t, a[1] + directionA[1] * t];
}

function offsetMitered(polygon: Polygon2, mm: number, allowConcave: boolean): Polygon2[] {
  if (!validatePolygon(polygon) || !Number.isFinite(mm)) throw new RangeError('Offset requires finite valid polygon geometry');
  if (!allowConcave && !isConvex(polygon)) throw new RangeError('Built-in offset kernel accepts convex polygons only');
  if (mm === 0) return [{ points: polygon.points.map(([x, y]) => [x, y]) }];
  const orientation = Math.sign(signedArea(polygon));
  const lines = polygon.points.map((point, index) => {
    const next = polygon.points[(index + 1) % polygon.points.length];
    const direction: Point2 = [next[0] - point[0], next[1] - point[1]];
    const length = Math.hypot(...direction);
    const normal: Point2 = orientation > 0 ? [direction[1] / length, -direction[0] / length] : [-direction[1] / length, direction[0] / length];
    return { point: [point[0] + normal[0] * mm, point[1] + normal[1] * mm] as Point2, direction, length };
  });
  const points: Point2[] = [];
  const scale = Math.max(...polygon.points.map(([x, y]) => Math.hypot(x, y)), 1);
  for (let index = 0; index < lines.length; index += 1) {
    const prior = lines[(index - 1 + lines.length) % lines.length];
    const current = lines[index];
    let point = intersection(prior.point, prior.direction, current.point, current.direction);
    if (!point) {
      const cross = prior.direction[0] * current.direction[1] - prior.direction[1] * current.direction[0];
      const dot = prior.direction[0] * current.direction[0] + prior.direction[1] * current.direction[1];
      const tolerance = Math.max(prior.length * current.length, 1) * 256 * Number.EPSILON;
      if (Math.abs(cross) > tolerance || dot <= 0) throw new RangeError('Offset cannot resolve a folded or numerically unstable polygon vertex');
      point = current.point;
    }
    if (!point.every(Number.isFinite) || Math.hypot(point[0] - polygon.points[index][0], point[1] - polygon.points[index][1]) > Math.max(scale, Math.abs(mm)) * 64) {
      throw new RangeError('Offset miter exceeds the bounded geometry limit');
    }
    const previous = points.at(-1);
    if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > scale * 256 * Number.EPSILON) points.push(point);
  }
  if (points.length > 1 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) <= scale * 256 * Number.EPSILON) points.pop();
  const result = { points };
  if (!validatePolygon(result)) throw new RangeError('Offset collapsed or self-intersected the polygon');
  return [result];
}

/** Conservative built-in kernel: convex polygons only; complex offsets must use a vetted kernel adapter. */
export const convexPolygonKernel: PolygonKernel = {
  offset: (polygon, mm) => offsetMitered(polygon, mm, false),
  intersects: polygonsOverlapArea,
};

/** Explicit adapter for validated simple manufacturing outlines, including concave notches. */
export const simpleMiterPolygonKernel: PolygonKernel = {
  offset: (polygon, mm) => offsetMitered(polygon, mm, true),
  intersects: polygonsOverlapArea,
};
