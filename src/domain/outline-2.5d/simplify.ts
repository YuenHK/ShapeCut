import type { Point2 } from '../decomposition/types';

export type Bounds2 = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
}

export function signedArea(points: readonly Point2[], deadline = Infinity): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const point = points[index], next = points[(index + 1) % points.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return twiceArea / 2;
}

export function contourBounds(points: readonly Point2[], deadline = Infinity): Bounds2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const [x, y] = points[index];
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

function rdpOpenIndices(
  points: readonly Point2[],
  rangeStart: number,
  rangeEnd: number,
  toleranceSquared: number,
  deadline: number,
): number[] {
  const rangeLength = rangeEnd - rangeStart + 1;
  if (rangeLength <= 2) return [rangeStart % points.length, rangeEnd % points.length];
  const retained = new Uint8Array(rangeLength);
  retained[0] = 1; retained[rangeLength - 1] = 1;
  const stack: number[] = [0, rangeLength - 1];
  while (stack.length > 0) {
    checkDeadline(deadline);
    const endOffset = stack.pop()!, startOffset = stack.pop()!;
    const start = points[(rangeStart + startOffset) % points.length];
    const end = points[(rangeStart + endOffset) % points.length];
    let greatestDistance = -1, greatestOffset = -1;
    for (let offset = startOffset + 1; offset < endOffset; offset += 1) {
      if ((offset & 255) === 0) checkDeadline(deadline);
      const distance = pointSegmentDistanceSquared(points[(rangeStart + offset) % points.length], start, end);
      if (distance > greatestDistance) { greatestDistance = distance; greatestOffset = offset; }
    }
    if (greatestDistance > toleranceSquared) {
      retained[greatestOffset] = 1;
      stack.push(startOffset, greatestOffset, greatestOffset, endOffset);
    }
  }
  const result: number[] = [];
  for (let offset = 0; offset < rangeLength; offset += 1) {
    if ((offset & 255) === 0) checkDeadline(deadline);
    if (retained[offset]) result.push((rangeStart + offset) % points.length);
  }
  return result;
}

function canonicalClockwise(points: readonly Point2[], deadline: number): Point2[] {
  const reverse = signedArea(points, deadline) > 0;
  const oriented: Point2[] = new Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    oriented[index] = points[reverse ? points.length - 1 - index : index];
  }
  let first = 0;
  for (let index = 1; index < oriented.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    if (oriented[index][0] < oriented[first][0]
      || (oriented[index][0] === oriented[first][0] && oriented[index][1] < oriented[first][1])) first = index;
  }
  const result: Point2[] = [];
  for (let offset = 0; offset < oriented.length; offset += 1) {
    if ((offset & 255) === 0) checkDeadline(deadline);
    result.push(oriented[(first + offset) % oriented.length]);
  }
  return result;
}

function simplifyAtTolerance(points: readonly Point2[], tolerance: number, deadline: number): Point2[] {
  if (points.length <= 3) return canonicalClockwise(points, deadline);
  let split = 1, greatest = -1;
  for (let index = 1; index < points.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const distance = (points[index][0] - points[0][0]) ** 2 + (points[index][1] - points[0][1]) ** 2;
    if (distance > greatest) { greatest = distance; split = index; }
  }
  const toleranceSquared = tolerance * tolerance;
  const first = rdpOpenIndices(points, 0, split, toleranceSquared, deadline);
  const second = rdpOpenIndices(points, split, points.length, toleranceSquared, deadline);
  const combined: Point2[] = [];
  for (let index = 0; index + 1 < first.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    combined.push(points[first[index]]);
  }
  for (let index = 0; index + 1 < second.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    combined.push(points[second[index]]);
  }
  return canonicalClockwise(combined, deadline);
}

export function simplifyClosedLoop(
  points: readonly Point2[],
  tolerance: number,
  maximumPoints: number,
  deadline = Infinity,
): readonly Point2[] {
  checkDeadline(deadline);
  if (points.length < 3 || !Number.isFinite(tolerance) || tolerance < 0 || maximumPoints < 3) {
    throw new RangeError('Contour simplification requires a valid closed loop and budget');
  }
  let currentTolerance = tolerance;
  let result = simplifyAtTolerance(points, currentTolerance, deadline);
  for (let attempt = 0; result.length > maximumPoints && attempt < 32; attempt += 1) {
    checkDeadline(deadline);
    currentTolerance = currentTolerance === 0 ? Number.EPSILON : currentTolerance * 2;
    result = simplifyAtTolerance(points, currentTolerance, deadline);
  }
  if (result.length > maximumPoints || result.length < 3) {
    throw new RangeError('Contour cannot be simplified within the point budget');
  }
  return result;
}
