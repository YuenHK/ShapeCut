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

/** Conservative built-in kernel: convex polygons only; complex offsets must use a vetted kernel adapter. */
export const convexPolygonKernel: PolygonKernel = {
  offset(polygon, mm) {
    if (!validatePolygon(polygon) || !Number.isFinite(mm)) throw new RangeError('Offset requires finite valid polygon geometry');
    if (!isConvex(polygon)) throw new RangeError('Built-in offset kernel accepts convex polygons only');
    if (mm === 0) return [{ points: polygon.points.map(([x, y]) => [x, y]) }];
    const orientation = Math.sign(signedArea(polygon));
    const lines = polygon.points.map((point, index) => {
      const next = polygon.points[(index + 1) % polygon.points.length];
      const direction: Point2 = [next[0] - point[0], next[1] - point[1]];
      const length = Math.hypot(...direction);
      const normal: Point2 = orientation > 0 ? [direction[1] / length, -direction[0] / length] : [-direction[1] / length, direction[0] / length];
      return { point: [point[0] + normal[0] * mm, point[1] + normal[1] * mm] as Point2, direction };
    });
    const points: Point2[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const prior = lines[(index - 1 + lines.length) % lines.length];
      const current = lines[index];
      const point = intersection(prior.point, prior.direction, current.point, current.direction);
      if (!point || !point.every(Number.isFinite)) throw new RangeError('Offset cannot resolve parallel or non-convex polygon edges');
      points.push(point);
    }
    const result = { points };
    if (!validatePolygon(result)) throw new RangeError('Offset collapsed or self-intersected the polygon');
    return [result];
  },
  intersects: polygonsOverlapArea,
};
