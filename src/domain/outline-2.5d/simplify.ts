import type { Point2 } from '../decomposition/types';

export type Bounds2 = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

export function signedArea(points: readonly Point2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return twiceArea / 2;
}

export function contourBounds(points: readonly Point2[]): Bounds2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function pointSegmentDistanceSquared(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2;
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return (point[0] - start[0] - t * dx) ** 2 + (point[1] - start[1] - t * dy) ** 2;
}

function rdpOpen(points: readonly Point2[], toleranceSquared: number): Point2[] {
  if (points.length <= 2) return [...points];
  let greatestDistance = -1, greatestIndex = -1;
  for (let index = 1; index + 1 < points.length; index += 1) {
    const distance = pointSegmentDistanceSquared(points[index], points[0], points[points.length - 1]);
    if (distance > greatestDistance) { greatestDistance = distance; greatestIndex = index; }
  }
  if (greatestDistance <= toleranceSquared) return [points[0], points[points.length - 1]];
  const left = rdpOpen(points.slice(0, greatestIndex + 1), toleranceSquared);
  const right = rdpOpen(points.slice(greatestIndex), toleranceSquared);
  return [...left.slice(0, -1), ...right];
}

function canonicalClockwise(points: readonly Point2[]): Point2[] {
  const oriented = signedArea(points) > 0 ? [...points].reverse() : [...points];
  let first = 0;
  for (let index = 1; index < oriented.length; index += 1) {
    if (oriented[index][0] < oriented[first][0]
      || (oriented[index][0] === oriented[first][0] && oriented[index][1] < oriented[first][1])) first = index;
  }
  return [...oriented.slice(first), ...oriented.slice(0, first)];
}

function simplifyAtTolerance(points: readonly Point2[], tolerance: number): Point2[] {
  if (points.length <= 3) return canonicalClockwise(points);
  let split = 1, greatest = -1;
  for (let index = 1; index < points.length; index += 1) {
    const distance = (points[index][0] - points[0][0]) ** 2 + (points[index][1] - points[0][1]) ** 2;
    if (distance > greatest) { greatest = distance; split = index; }
  }
  const toleranceSquared = tolerance * tolerance;
  const first = rdpOpen(points.slice(0, split + 1), toleranceSquared);
  const second = rdpOpen([...points.slice(split), points[0]], toleranceSquared);
  const combined = [...first.slice(0, -1), ...second.slice(0, -1)];
  return canonicalClockwise(combined);
}

export function simplifyClosedLoop(
  points: readonly Point2[],
  tolerance: number,
  maximumPoints: number,
): readonly Point2[] {
  if (points.length < 3 || !Number.isFinite(tolerance) || tolerance < 0 || maximumPoints < 3) {
    throw new RangeError('Contour simplification requires a valid closed loop and budget');
  }
  let currentTolerance = tolerance;
  let result = simplifyAtTolerance(points, currentTolerance);
  for (let attempt = 0; result.length > maximumPoints && attempt < 32; attempt += 1) {
    currentTolerance = currentTolerance === 0 ? Number.EPSILON : currentTolerance * 2;
    result = simplifyAtTolerance(points, currentTolerance);
  }
  if (result.length > maximumPoints || result.length < 3) {
    throw new RangeError('Contour cannot be simplified within the point budget');
  }
  return result;
}
