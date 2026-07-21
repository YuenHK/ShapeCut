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

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  checkDeadline(deadline);
}

const SIMPLIFICATION_FIXED_WORKSPACE_BYTES = 4096;
const ESTIMATED_JS_ARRAY_ENTRY_BYTES = 16;
const RDP_RETAINED_MASK_BYTES_PER_POINT = 2;
const RDP_STACK_ENTRIES_PER_POINT = 2;
const RDP_INDEX_ENTRIES_PER_POINT = 1;
const COMBINED_POINT_REFERENCES_PER_POINT = 1;
const CANONICAL_POINT_REFERENCES_PER_POINT = 2;
const PREVIOUS_RESULT_REFERENCES_PER_POINT = 1;
const SIMPLIFICATION_BYTES_PER_SOURCE_POINT = Math.ceil((
  RDP_RETAINED_MASK_BYTES_PER_POINT
  + ESTIMATED_JS_ARRAY_ENTRY_BYTES * (
    RDP_STACK_ENTRIES_PER_POINT
    + RDP_INDEX_ENTRIES_PER_POINT
    + COMBINED_POINT_REFERENCES_PER_POINT
    + CANONICAL_POINT_REFERENCES_PER_POINT
    + PREVIOUS_RESULT_REFERENCES_PER_POINT
  )
) / 16) * 16;

/** Conservative peak workspace for RDP state, index arrays, point references, and canonical copies. */
export function estimateSimplifyClosedLoopWorkspaceBytes(pointCount: number): number {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError('Contour simplification workspace requires a safe point count');
  }
  const maximumCount = Math.floor(
    (Number.MAX_SAFE_INTEGER - SIMPLIFICATION_FIXED_WORKSPACE_BYTES)
      / SIMPLIFICATION_BYTES_PER_SOURCE_POINT,
  );
  if (pointCount > maximumCount) return Infinity;
  return SIMPLIFICATION_FIXED_WORKSPACE_BYTES + pointCount * SIMPLIFICATION_BYTES_PER_SOURCE_POINT;
}

export function signedArea(points: readonly Point2[], deadline = Infinity, checkpoint: () => void = () => undefined): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const point = points[index], next = points[(index + 1) % points.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return twiceArea / 2;
}

export function contourBounds(points: readonly Point2[], deadline = Infinity, checkpoint: () => void = () => undefined): Bounds2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
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
  checkpoint: () => void,
): number[] {
  checkRuntime(deadline, checkpoint);
  const rangeLength = rangeEnd - rangeStart + 1;
  if (rangeLength <= 2) return [rangeStart % points.length, rangeEnd % points.length];
  const retained = new Uint8Array(rangeLength);
  retained[0] = 1; retained[rangeLength - 1] = 1;
  const stack: number[] = [0, rangeLength - 1];
  while (stack.length > 0) {
    checkRuntime(deadline, checkpoint);
    const endOffset = stack.pop()!, startOffset = stack.pop()!;
    const start = points[(rangeStart + startOffset) % points.length];
    const end = points[(rangeStart + endOffset) % points.length];
    let greatestDistance = -1, greatestOffset = -1;
    for (let offset = startOffset + 1; offset < endOffset; offset += 1) {
      if ((offset & 255) === 0) checkRuntime(deadline, checkpoint);
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
    if ((offset & 255) === 0) checkRuntime(deadline, checkpoint);
    if (retained[offset]) result.push((rangeStart + offset) % points.length);
  }
  return result;
}

function canonicalClockwise(points: readonly Point2[], deadline: number, checkpoint: () => void): Point2[] {
  checkRuntime(deadline, checkpoint);
  const reverse = signedArea(points, deadline, checkpoint) > 0;
  const oriented: Point2[] = new Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    oriented[index] = points[reverse ? points.length - 1 - index : index];
  }
  let first = 0;
  for (let index = 1; index < oriented.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    if (oriented[index][0] < oriented[first][0]
      || (oriented[index][0] === oriented[first][0] && oriented[index][1] < oriented[first][1])) first = index;
  }
  checkRuntime(deadline, checkpoint);
  const result: Point2[] = new Array(oriented.length);
  for (let offset = 0; offset < oriented.length; offset += 1) {
    if ((offset & 255) === 0) checkRuntime(deadline, checkpoint);
    result[offset] = oriented[(first + offset) % oriented.length];
  }
  return result;
}

function simplifyAtTolerance(
  points: readonly Point2[],
  tolerance: number,
  deadline: number,
  checkpoint: () => void,
): Point2[] {
  checkRuntime(deadline, checkpoint);
  if (points.length <= 3) return canonicalClockwise(points, deadline, checkpoint);
  let split = 1, greatest = -1;
  for (let index = 1; index < points.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    const distance = (points[index][0] - points[0][0]) ** 2 + (points[index][1] - points[0][1]) ** 2;
    if (distance > greatest) { greatest = distance; split = index; }
  }
  const toleranceSquared = tolerance * tolerance;
  const first = rdpOpenIndices(points, 0, split, toleranceSquared, deadline, checkpoint);
  const second = rdpOpenIndices(points, split, points.length, toleranceSquared, deadline, checkpoint);
  checkRuntime(deadline, checkpoint);
  const combined: Point2[] = [];
  for (let index = 0; index + 1 < first.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    combined.push(points[first[index]]);
  }
  for (let index = 0; index + 1 < second.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    combined.push(points[second[index]]);
  }
  return canonicalClockwise(combined, deadline, checkpoint);
}

export function simplifyClosedLoop(
  points: readonly Point2[],
  tolerance: number,
  maximumPoints: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): readonly Point2[] {
  checkRuntime(deadline, checkpoint);
  if (points.length < 3 || !Number.isFinite(tolerance) || tolerance < 0 || maximumPoints < 3) {
    throw new RangeError('Contour simplification requires a valid closed loop and budget');
  }
  let currentTolerance = tolerance;
  let result = simplifyAtTolerance(points, currentTolerance, deadline, checkpoint);
  for (let attempt = 0; result.length > maximumPoints && attempt < 32; attempt += 1) {
    checkRuntime(deadline, checkpoint);
    currentTolerance = currentTolerance === 0 ? Number.EPSILON : currentTolerance * 2;
    result = simplifyAtTolerance(points, currentTolerance, deadline, checkpoint);
  }
  if (result.length > maximumPoints || result.length < 3) {
    throw new RangeError('Contour cannot be simplified within the point budget');
  }
  return result;
}
