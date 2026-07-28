import type { Point2, Polygon2 } from '../decomposition/types';
import { MAX_POLYGON_POINTS, pointLocation, validatePolygon } from '../engraving/geometry';

type SplitSegment = {
  readonly start: Point2;
  readonly end: Point2;
  readonly sourceIndex: number;
  readonly parameters: number[];
};

type ArrangementEdge = {
  readonly start: Point2;
  readonly end: Point2;
  readonly startKey: string;
  readonly endKey: string;
  readonly sourceIndex: number;
  netTraversal: number;
};

type HalfEdge = {
  readonly start: Point2;
  readonly end: Point2;
  readonly startKey: string;
  readonly endKey: string;
  readonly sourceIndex: number;
  readonly arrangementIndex: number;
  readonly twinIndex: number;
};

type PlanarFace = {
  readonly halfEdgeIndices: readonly number[];
  readonly points: readonly Point2[];
  readonly areaMm2: number;
};

export class LauncherExteriorOffsetTopologyError extends RangeError {
  readonly name = 'LauncherExteriorOffsetTopologyError';
}

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) {
    throw new RangeError('Launcher exterior expansion exceeded the runtime budget');
  }
}

function cross(left: Point2, right: Point2): number {
  return left[0] * right[1] - left[1] * right[0];
}

function dot(left: Point2, right: Point2): number {
  return left[0] * right[0] + left[1] * right[1];
}

function subtract(left: Point2, right: Point2): Point2 {
  return [left[0] - right[0], left[1] - right[1]];
}

function interpolate(start: Point2, end: Point2, parameter: number): Point2 {
  return [
    start[0] + (end[0] - start[0]) * parameter,
    start[1] + (end[1] - start[1]) * parameter,
  ];
}

function geometryScale(
  points: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let coordinate = 1;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const [x, y] = points[index];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    coordinate = Math.max(coordinate, Math.abs(x), Math.abs(y));
  }
  return Math.max(1, coordinate, maxX - minX, maxY - minY);
}

function signedArea(
  points: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const point = points[index];
    const next = points[(index + 1) % points.length];
    area += point[0] * next[1] - next[0] * point[1];
  }
  return area / 2;
}

function addParameter(
  segment: SplitSegment,
  parameter: number,
  tolerance: number,
): boolean {
  const bounded = Math.max(0, Math.min(1, parameter));
  if (segment.parameters.some((candidate) => Math.abs(candidate - bounded) <= tolerance)) {
    return false;
  }
  segment.parameters.push(bounded);
  return true;
}

function splitAtPairIntersections(
  left: SplitSegment,
  right: SplitSegment,
  lengthTolerance: number,
): number {
  const leftDirection = subtract(left.end, left.start);
  const rightDirection = subtract(right.end, right.start);
  const leftLength = Math.hypot(...leftDirection);
  const rightLength = Math.hypot(...rightDirection);
  const betweenStarts = subtract(right.start, left.start);
  const denominator = cross(leftDirection, rightDirection);
  const crossTolerance = lengthTolerance * Math.max(1, leftLength, rightLength);
  const leftParameterTolerance = lengthTolerance / Math.max(leftLength, 1);
  const rightParameterTolerance = lengthTolerance / Math.max(rightLength, 1);
  let added = 0;

  if (Math.abs(denominator) > crossTolerance) {
    const leftParameter = cross(betweenStarts, rightDirection) / denominator;
    const rightParameter = cross(betweenStarts, leftDirection) / denominator;
    if (leftParameter >= -leftParameterTolerance
      && leftParameter <= 1 + leftParameterTolerance
      && rightParameter >= -rightParameterTolerance
      && rightParameter <= 1 + rightParameterTolerance) {
      if (addParameter(left, leftParameter, leftParameterTolerance)) added += 1;
      if (addParameter(right, rightParameter, rightParameterTolerance)) added += 1;
    }
    return added;
  }

  if (Math.abs(cross(betweenStarts, leftDirection)) > crossTolerance) return 0;
  const leftLengthSquared = dot(leftDirection, leftDirection);
  const rightLengthSquared = dot(rightDirection, rightDirection);
  const leftStart = dot(betweenStarts, leftDirection) / leftLengthSquared;
  const leftEnd = dot(subtract(right.end, left.start), leftDirection) / leftLengthSquared;
  const overlapStart = Math.max(0, Math.min(leftStart, leftEnd));
  const overlapEnd = Math.min(1, Math.max(leftStart, leftEnd));
  if (overlapStart > overlapEnd + leftParameterTolerance) return 0;

  for (const leftParameter of [overlapStart, overlapEnd]) {
    const point = interpolate(left.start, left.end, leftParameter);
    const rightParameter = dot(subtract(point, right.start), rightDirection)
      / rightLengthSquared;
    if (addParameter(left, leftParameter, leftParameterTolerance)) added += 1;
    if (addParameter(right, rightParameter, rightParameterTolerance)) added += 1;
  }
  return added;
}

function coordinateKey(point: Point2, tolerance: number): string {
  return `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
}

function compareCoordinateKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildArrangement(
  segments: readonly SplitSegment[],
  lengthTolerance: number,
  deadline: number,
  checkpoint: () => void,
): ArrangementEdge[] {
  const keyTolerance = lengthTolerance * 8;
  const canonicalPoints = new Map<string, Point2>();
  const byUndirectedKey = new Map<string, ArrangementEdge>();

  for (const segment of segments) {
    checkRuntime(deadline, checkpoint);
    segment.parameters.sort((left, right) => left - right);
    for (let index = 0; index + 1 < segment.parameters.length; index += 1) {
      checkRuntime(deadline, checkpoint);
      const start = interpolate(segment.start, segment.end, segment.parameters[index]);
      const end = interpolate(segment.start, segment.end, segment.parameters[index + 1]);
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= lengthTolerance) continue;
      const startKey = coordinateKey(start, keyTolerance);
      const endKey = coordinateKey(end, keyTolerance);
      if (startKey === endKey) continue;
      if (!canonicalPoints.has(startKey)) canonicalPoints.set(startKey, start);
      if (!canonicalPoints.has(endKey)) canonicalPoints.set(endKey, end);
      const forward = startKey < endKey;
      const canonicalStartKey = forward ? startKey : endKey;
      const canonicalEndKey = forward ? endKey : startKey;
      const undirectedKey = `${canonicalStartKey}|${canonicalEndKey}`;
      const existing = byUndirectedKey.get(undirectedKey);
      if (existing) {
        existing.netTraversal += forward ? 1 : -1;
      } else {
        byUndirectedKey.set(undirectedKey, {
          start: canonicalPoints.get(canonicalStartKey)!,
          end: canonicalPoints.get(canonicalEndKey)!,
          startKey: canonicalStartKey,
          endKey: canonicalEndKey,
          sourceIndex: segment.sourceIndex,
          netTraversal: forward ? 1 : -1,
        });
        if (byUndirectedKey.size > MAX_POLYGON_POINTS) {
          throw new RangeError('Launcher exterior offset exceeded the 4096-point arrangement bound');
        }
      }
    }
  }
  return [...byUndirectedKey.values()];
}

function polarHalf(direction: Point2, tolerance: number): 0 | 1 {
  if (direction[1] > tolerance
    || (Math.abs(direction[1]) <= tolerance && direction[0] >= 0)) return 0;
  return 1;
}

function comparePolar(
  left: HalfEdge,
  right: HalfEdge,
  lengthTolerance: number,
): number {
  const leftDirection = subtract(left.end, left.start);
  const rightDirection = subtract(right.end, right.start);
  const leftHalf = polarHalf(leftDirection, lengthTolerance);
  const rightHalf = polarHalf(rightDirection, lengthTolerance);
  if (leftHalf !== rightHalf) return leftHalf - rightHalf;
  const turn = cross(leftDirection, rightDirection);
  const turnTolerance = lengthTolerance * Math.max(
    1,
    Math.hypot(...leftDirection),
    Math.hypot(...rightDirection),
  );
  if (Math.abs(turn) > turnTolerance) return turn > 0 ? -1 : 1;
  const lengthDifference = dot(leftDirection, leftDirection) - dot(rightDirection, rightDirection);
  if (Math.abs(lengthDifference) > lengthTolerance ** 2) return lengthDifference;
  return compareCoordinateKeys(left.endKey, right.endKey)
    || left.sourceIndex - right.sourceIndex
    || left.arrangementIndex - right.arrangementIndex
    || left.twinIndex - right.twinIndex;
}

function createHalfEdges(
  arrangement: readonly ArrangementEdge[],
  deadline: number,
  checkpoint: () => void,
): HalfEdge[] {
  const halfEdges: HalfEdge[] = [];
  for (let arrangementIndex = 0; arrangementIndex < arrangement.length; arrangementIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const edge = arrangement[arrangementIndex];
    const forwardIndex = arrangementIndex * 2;
    halfEdges.push(
      {
        start: edge.start,
        end: edge.end,
        startKey: edge.startKey,
        endKey: edge.endKey,
        sourceIndex: edge.sourceIndex,
        arrangementIndex,
        twinIndex: forwardIndex + 1,
      },
      {
        start: edge.end,
        end: edge.start,
        startKey: edge.endKey,
        endKey: edge.startKey,
        sourceIndex: edge.sourceIndex,
        arrangementIndex,
        twinIndex: forwardIndex,
      },
    );
  }
  return halfEdges;
}

function tracePlanarFaces(
  halfEdges: readonly HalfEdge[],
  lengthTolerance: number,
  deadline: number,
  checkpoint: () => void,
): {
  readonly faces: readonly PlanarFace[];
  readonly faceByHalfEdge: readonly number[];
} {
  const outgoing = new Map<string, number[]>();
  for (let index = 0; index < halfEdges.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const edge = halfEdges[index];
    outgoing.set(edge.startKey, [...(outgoing.get(edge.startKey) ?? []), index]);
  }
  for (const candidates of outgoing.values()) {
    checkRuntime(deadline, checkpoint);
    candidates.sort((left, right) => comparePolar(
      halfEdges[left],
      halfEdges[right],
      lengthTolerance,
    ));
  }

  const next = new Array<number>(halfEdges.length);
  for (let index = 0; index < halfEdges.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const candidates = outgoing.get(halfEdges[index].endKey);
    const twinPosition = candidates?.indexOf(halfEdges[index].twinIndex) ?? -1;
    if (!candidates || twinPosition < 0) {
      throw new LauncherExteriorOffsetTopologyError(
        'Launcher exterior offset contains an open planar half-edge',
      );
    }
    next[index] = candidates[(twinPosition - 1 + candidates.length) % candidates.length];
  }

  const consumed = new Set<number>();
  const faceByHalfEdge = new Array<number>(halfEdges.length);
  const faces: PlanarFace[] = [];
  for (let initial = 0; initial < halfEdges.length; initial += 1) {
    if (consumed.has(initial)) continue;
    const faceIndex = faces.length;
    const indices: number[] = [];
    const points: Point2[] = [];
    let current = initial;
    for (let guard = 0; guard <= halfEdges.length; guard += 1) {
      checkRuntime(deadline, checkpoint);
      if (consumed.has(current)) {
        if (current !== initial) {
          throw new LauncherExteriorOffsetTopologyError(
            'Launcher exterior planar face walk merged into an earlier face',
          );
        }
        break;
      }
      consumed.add(current);
      faceByHalfEdge[current] = faceIndex;
      indices.push(current);
      points.push(halfEdges[current].start);
      current = next[current];
      if (current === initial) break;
      if (guard === halfEdges.length) {
        throw new LauncherExteriorOffsetTopologyError(
          'Launcher exterior planar face walk exceeded its bound',
        );
      }
    }
    faces.push({
      halfEdgeIndices: indices,
      points,
      areaMm2: signedArea(points, deadline, checkpoint),
    });
  }
  if (consumed.size !== halfEdges.length) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior planar face walk left unconsumed half-edges',
    );
  }
  return { faces, faceByHalfEdge };
}

function propagateFaceWindings(
  arrangement: readonly ArrangementEdge[],
  faces: readonly PlanarFace[],
  faceByHalfEdge: readonly number[],
  areaTolerance: number,
  deadline: number,
  checkpoint: () => void,
): readonly number[] {
  const unbounded = faces
    .map((face, index) => ({ face, index }))
    .filter(({ face }) => face.areaMm2 < -areaTolerance);
  if (unbounded.length !== 1) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset requires one deterministic unbounded face',
    );
  }
  const adjacency: { readonly face: number; readonly delta: number }[][] = faces
    .map(() => []);
  for (let arrangementIndex = 0; arrangementIndex < arrangement.length; arrangementIndex += 1) {
    if ((arrangementIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    const edge = arrangement[arrangementIndex];
    const leftFace = faceByHalfEdge[arrangementIndex * 2];
    const rightFace = faceByHalfEdge[arrangementIndex * 2 + 1];
    adjacency[rightFace].push({ face: leftFace, delta: edge.netTraversal });
    adjacency[leftFace].push({ face: rightFace, delta: -edge.netTraversal });
  }

  const windings = new Array<number | undefined>(faces.length);
  windings[unbounded[0].index] = 0;
  const queue = [unbounded[0].index];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    checkRuntime(deadline, checkpoint);
    const face = queue[cursor];
    const winding = windings[face]!;
    for (const constraint of adjacency[face]) {
      checkRuntime(deadline, checkpoint);
      const required = winding + constraint.delta;
      const existing = windings[constraint.face];
      if (existing === undefined) {
        windings[constraint.face] = required;
        queue.push(constraint.face);
      } else if (existing !== required) {
        throw new LauncherExteriorOffsetTopologyError(
          'Launcher exterior face winding constraints are inconsistent',
        );
      }
    }
  }
  if (windings.some((winding) => winding === undefined)) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset contains a disconnected face component',
    );
  }
  return windings as number[];
}

function clockwiseTurnCompare(
  reference: Point2,
  left: HalfEdge,
  right: HalfEdge,
  lengthTolerance: number,
): number {
  const leftDirection = subtract(left.end, left.start);
  const rightDirection = subtract(right.end, right.start);
  const leftRotated: Point2 = [dot(reference, leftDirection), -cross(reference, leftDirection)];
  const rightRotated: Point2 = [dot(reference, rightDirection), -cross(reference, rightDirection)];
  const scale = Math.max(
    1,
    Math.hypot(...reference),
    Math.hypot(...leftDirection),
    Math.hypot(...rightDirection),
  );
  const rotatedTolerance = lengthTolerance * scale;
  const leftHalf = polarHalf(leftRotated, rotatedTolerance);
  const rightHalf = polarHalf(rightRotated, rotatedTolerance);
  if (leftHalf !== rightHalf) return leftHalf - rightHalf;
  const turn = cross(leftRotated, rightRotated);
  const turnTolerance = rotatedTolerance * scale ** 2;
  if (Math.abs(turn) > turnTolerance) return turn > 0 ? -1 : 1;
  return compareCoordinateKeys(left.endKey, right.endKey)
    || left.sourceIndex - right.sourceIndex
    || left.arrangementIndex - right.arrangementIndex
    || left.twinIndex - right.twinIndex;
}

function traceBoundaryCycles(
  edges: readonly HalfEdge[],
  areaTolerance: number,
  lengthTolerance: number,
  deadline: number,
  checkpoint: () => void,
): readonly Polygon2[] {
  if (edges.length === 0) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset did not retain a filled boundary',
    );
  }
  if (edges.length > MAX_POLYGON_POINTS) {
    throw new RangeError('Launcher exterior offset exceeded the bounded outer-face complexity');
  }
  const outgoing = new Map<string, number[]>();
  for (let index = 0; index < edges.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const edge = edges[index];
    outgoing.set(edge.startKey, [...(outgoing.get(edge.startKey) ?? []), index]);
  }
  const next = new Array<number>(edges.length);
  const predecessorCounts = new Array<number>(edges.length).fill(0);
  for (let index = 0; index < edges.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const edge = edges[index];
    const candidates = [...(outgoing.get(edge.endKey) ?? [])];
    if (candidates.length === 0) {
      throw new LauncherExteriorOffsetTopologyError(
        'Launcher exterior offset boundary face is open',
      );
    }
    const reference = subtract(edge.start, edge.end);
    candidates.sort((left, right) => clockwiseTurnCompare(
      reference,
      edges[left],
      edges[right],
      lengthTolerance,
    ));
    next[index] = candidates[0];
    predecessorCounts[candidates[0]] += 1;
  }
  if (predecessorCounts.some((count) => count !== 1)) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset boundary turns are not deterministic',
    );
  }

  const consumed = new Set<number>();
  const cycles: Polygon2[] = [];
  for (let initial = 0; initial < edges.length; initial += 1) {
    if (consumed.has(initial)) continue;
    const points: Point2[] = [];
    let current = initial;
    for (let guard = 0; guard <= edges.length; guard += 1) {
      checkRuntime(deadline, checkpoint);
      if (consumed.has(current)) {
        if (current !== initial) {
          throw new LauncherExteriorOffsetTopologyError(
            'Launcher exterior boundary walk merged into an earlier cycle',
          );
        }
        break;
      }
      consumed.add(current);
      points.push(edges[current].start);
      current = next[current];
      if (current === initial) break;
      if (guard === edges.length) {
        throw new LauncherExteriorOffsetTopologyError(
          'Launcher exterior boundary walk exceeded its bound',
        );
      }
    }
    const simplified = simplifyCollinear(points, areaTolerance, deadline, checkpoint);
    if (simplified.length > MAX_POLYGON_POINTS) {
      throw new RangeError('Launcher exterior offset exceeded the 4096-point output bound');
    }
    const polygon = { points: simplified };
    if (!validatePolygon(polygon, () => checkRuntime(deadline, checkpoint))) {
      throw new LauncherExteriorOffsetTopologyError(
        'Launcher exterior offset produced an invalid boundary cycle',
      );
    }
    cycles.push(polygon);
  }
  return cycles;
}

function simplifyCollinear(
  input: readonly Point2[],
  areaTolerance: number,
  deadline: number,
  checkpoint: () => void,
): Point2[] {
  const points = input.map(([x, y]) => [x, y] as Point2);
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let index = 0; index < points.length; index += 1) {
      checkRuntime(deadline, checkpoint);
      const prior = points[(index - 1 + points.length) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const incoming = subtract(current, prior);
      const outgoing = subtract(next, current);
      if (Math.abs(cross(incoming, outgoing)) <= areaTolerance
        && dot(incoming, outgoing) >= 0) {
        points.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return points;
}

function pointOnSegment(
  point: Point2,
  start: Point2,
  end: Point2,
  lengthTolerance: number,
  areaTolerance: number,
): boolean {
  return Math.abs(cross(subtract(end, start), subtract(point, start))) <= areaTolerance
    && point[0] >= Math.min(start[0], end[0]) - lengthTolerance
    && point[0] <= Math.max(start[0], end[0]) + lengthTolerance
    && point[1] >= Math.min(start[1], end[1]) - lengthTolerance
    && point[1] <= Math.max(start[1], end[1]) + lengthTolerance;
}

function segmentsIntersectOrTouch(
  leftStart: Point2,
  leftEnd: Point2,
  rightStart: Point2,
  rightEnd: Point2,
  lengthTolerance: number,
  areaTolerance: number,
): boolean {
  const leftDirection = subtract(leftEnd, leftStart);
  const rightDirection = subtract(rightEnd, rightStart);
  const leftRightStart = cross(leftDirection, subtract(rightStart, leftStart));
  const leftRightEnd = cross(leftDirection, subtract(rightEnd, leftStart));
  const rightLeftStart = cross(rightDirection, subtract(leftStart, rightStart));
  const rightLeftEnd = cross(rightDirection, subtract(leftEnd, rightStart));
  if (((leftRightStart > areaTolerance && leftRightEnd < -areaTolerance)
      || (leftRightStart < -areaTolerance && leftRightEnd > areaTolerance))
    && ((rightLeftStart > areaTolerance && rightLeftEnd < -areaTolerance)
      || (rightLeftStart < -areaTolerance && rightLeftEnd > areaTolerance))) {
    return true;
  }
  return pointOnSegment(rightStart, leftStart, leftEnd, lengthTolerance, areaTolerance)
    || pointOnSegment(rightEnd, leftStart, leftEnd, lengthTolerance, areaTolerance)
    || pointOnSegment(leftStart, rightStart, rightEnd, lengthTolerance, areaTolerance)
    || pointOnSegment(leftEnd, rightStart, rightEnd, lengthTolerance, areaTolerance);
}

function containsSource(
  candidate: Polygon2,
  source: Polygon2,
  lengthTolerance: number,
  scale: number,
  deadline: number,
  checkpoint: () => void,
): boolean {
  const geometryCheckpoint = (): void => checkRuntime(deadline, checkpoint);
  for (let sourceIndex = 0; sourceIndex < source.points.length; sourceIndex += 1) {
    checkRuntime(deadline, checkpoint);
    if (pointLocation(candidate, source.points[sourceIndex], geometryCheckpoint) !== 1) {
      return false;
    }
  }
  const areaTolerance = lengthTolerance * scale;
  for (let sourceIndex = 0; sourceIndex < source.points.length; sourceIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const sourceStart = source.points[sourceIndex];
    const sourceEnd = source.points[(sourceIndex + 1) % source.points.length];
    for (let candidateIndex = 0; candidateIndex < candidate.points.length; candidateIndex += 1) {
      if ((candidateIndex & 63) === 0) checkRuntime(deadline, checkpoint);
      if (segmentsIntersectOrTouch(
        sourceStart,
        sourceEnd,
        candidate.points[candidateIndex],
        candidate.points[(candidateIndex + 1) % candidate.points.length],
        lengthTolerance,
        areaTolerance,
      )) return false;
    }
  }
  return true;
}

function isBoundedFiniteRawOffset(
  rawOffset: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): boolean {
  if (rawOffset.length < 3 || rawOffset.length > MAX_POLYGON_POINTS) return false;
  for (let index = 0; index < rawOffset.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const point = rawOffset[index];
    if (!Array.isArray(point)
      || point.length !== 2
      || !Number.isFinite(point[0])
      || !Number.isFinite(point[1])) return false;
  }
  return true;
}

/**
 * Resolves only self-overlap loops of an exact raw launcher-exterior miter path.
 * Retained edges remain subsets of shifted source edges. Planar face winding is
 * propagated as integers, so narrow connectors never depend on side sampling.
 */
export function resolveLauncherExteriorMiterOffset(
  source: Polygon2,
  rawOffset: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): Polygon2 {
  checkRuntime(deadline, checkpoint);
  if (!validatePolygon(source, () => checkRuntime(deadline, checkpoint))
    || !isBoundedFiniteRawOffset(rawOffset, deadline, checkpoint)) {
    throw new RangeError('Launcher exterior offset requires bounded finite geometry');
  }
  const scale = geometryScale(
    [...source.points, ...rawOffset],
    deadline,
    checkpoint,
  );
  const lengthTolerance = scale * 1024 * Number.EPSILON;
  const areaTolerance = lengthTolerance * scale;
  const segments: SplitSegment[] = rawOffset.map((start, index) => ({
    start,
    end: rawOffset[(index + 1) % rawOffset.length],
    sourceIndex: index,
    parameters: [0, 1],
  }));
  let splitEdgeCount = segments.length;
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    checkRuntime(deadline, checkpoint);
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      if ((rightIndex & 63) === 0) checkRuntime(deadline, checkpoint);
      splitEdgeCount += splitAtPairIntersections(
        segments[leftIndex],
        segments[rightIndex],
        lengthTolerance,
      );
      if (splitEdgeCount > MAX_POLYGON_POINTS) {
        throw new RangeError('Launcher exterior offset exceeded the 4096-point arrangement bound');
      }
    }
  }

  const arrangement = buildArrangement(
    segments,
    lengthTolerance,
    deadline,
    checkpoint,
  );
  if (arrangement.length === 0) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset produced an empty arrangement',
    );
  }
  if (arrangement.length > MAX_POLYGON_POINTS) {
    throw new RangeError('Launcher exterior offset exceeded the bounded arrangement complexity');
  }
  const halfEdges = createHalfEdges(arrangement, deadline, checkpoint);
  const { faces, faceByHalfEdge } = tracePlanarFaces(
    halfEdges,
    lengthTolerance,
    deadline,
    checkpoint,
  );
  const windings = propagateFaceWindings(
    arrangement,
    faces,
    faceByHalfEdge,
    areaTolerance,
    deadline,
    checkpoint,
  );
  const sourceOrientation = Math.sign(signedArea(source.points, deadline, checkpoint));
  const boundary: HalfEdge[] = [];
  for (let arrangementIndex = 0; arrangementIndex < arrangement.length; arrangementIndex += 1) {
    if ((arrangementIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    const leftFace = faceByHalfEdge[arrangementIndex * 2];
    const rightFace = faceByHalfEdge[arrangementIndex * 2 + 1];
    const leftFilled = windings[leftFace] * sourceOrientation > 0;
    const rightFilled = windings[rightFace] * sourceOrientation > 0;
    if (leftFilled !== rightFilled) {
      boundary.push(halfEdges[arrangementIndex * 2 + (leftFilled ? 0 : 1)]);
    }
  }
  const cycles = traceBoundaryCycles(
    boundary,
    areaTolerance,
    lengthTolerance,
    deadline,
    checkpoint,
  );
  const containing = cycles.filter((candidate) => containsSource(
    candidate,
    source,
    lengthTolerance,
    scale,
    deadline,
    checkpoint,
  ));
  if (containing.length !== 1) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset did not resolve to one outer contour containing the source',
    );
  }
  const containingArea = signedArea(containing[0].points, deadline, checkpoint);
  const clockwise = {
    points: containingArea < 0
      ? containing[0].points
      : [...containing[0].points].reverse(),
  };
  if (signedArea(clockwise.points, deadline, checkpoint) >= -areaTolerance
    || !validatePolygon(clockwise, () => checkRuntime(deadline, checkpoint))) {
    throw new LauncherExteriorOffsetTopologyError(
      'Launcher exterior offset did not resolve to one clockwise simple outer contour',
    );
  }
  return clockwise;
}
