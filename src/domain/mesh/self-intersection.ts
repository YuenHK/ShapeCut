import type { Vec3 } from '../types';
import type { TriangleMarker, TriangleMesh } from './types';

const LEAF_TRIANGLES = 8;
const DEFAULT_MAX_NODE_VISITS = 2_000_000;
const DEFAULT_MAX_TRIANGLE_PAIR_TESTS = 1_000_000;
const RELATIVE_EPSILON = 1e-10;

export type SelfIntersectionBudget = {
  readonly maxNodeVisits?: number;
  readonly maxTrianglePairTests?: number;
};

export type SelfIntersectionAnalysis = {
  readonly count: number;
  readonly markers: readonly TriangleMarker[];
  readonly complete: boolean;
};

type TriangleBounds = {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly center: Vec3;
};

type MutableVec3 = [number, number, number];

type BvhNode = {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly triangleCount: number;
  readonly triangles?: readonly number[];
  readonly left?: BvhNode;
  readonly right?: BvhNode;
};

export function analyzeSelfIntersections(
  mesh: TriangleMesh,
  markerLimit: number,
  budget: SelfIntersectionBudget = {},
): SelfIntersectionAnalysis {
  const maxNodeVisits = boundedBudget(budget.maxNodeVisits, DEFAULT_MAX_NODE_VISITS, 'BVH node-visit');
  const maxTrianglePairTests = boundedBudget(
    budget.maxTrianglePairTests,
    DEFAULT_MAX_TRIANGLE_PAIR_TESTS,
    'triangle-pair',
  );
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (triangleCount < 2) return { count: 0, markers: [], complete: true };

  const bounds = Array.from({ length: triangleCount }, (_, triangle) => triangleBounds(mesh, triangle));
  const root = buildBvh(Array.from({ length: triangleCount }, (_, triangle) => triangle), bounds);
  const extent = Math.max(
    root.maximum[0] - root.minimum[0],
    root.maximum[1] - root.minimum[1],
    root.maximum[2] - root.minimum[2],
  );
  const linearTolerance = Math.max(Number.MIN_VALUE, extent * 128 * Number.EPSILON);
  const stack: Array<readonly [BvhNode, BvhNode]> = [[root, root]];
  const markers: TriangleMarker[] = [];
  let count = 0;
  let nodeVisits = 0;
  let trianglePairTests = 0;

  while (stack.length > 0) {
    if (nodeVisits >= maxNodeVisits) return { count, markers, complete: false };
    nodeVisits += 1;
    const [first, second] = stack.pop()!;
    if (first !== second && !boundsOverlap(first, second, linearTolerance)) continue;

    if (first === second) {
      if (first.triangles) {
        for (let left = 0; left < first.triangles.length; left += 1) {
          for (let right = left + 1; right < first.triangles.length; right += 1) {
            const result = testPair(first.triangles[left], first.triangles[right]);
            if (result === 'budget') return { count, markers, complete: false };
          }
        }
      } else {
        stack.push([first.left!, first.left!], [first.right!, first.right!], [first.left!, first.right!]);
      }
      continue;
    }

    if (first.triangles && second.triangles) {
      for (const firstTriangle of first.triangles) {
        for (const secondTriangle of second.triangles) {
          const result = testPair(firstTriangle, secondTriangle);
          if (result === 'budget') return { count, markers, complete: false };
        }
      }
      continue;
    }

    if (first.triangles || (!second.triangles && second.triangleCount > first.triangleCount)) {
      stack.push([first, second.left!], [first, second.right!]);
    } else {
      stack.push([first.left!, second], [first.right!, second]);
    }
  }

  return { count, markers, complete: true };

  function testPair(firstTriangle: number, secondTriangle: number): 'tested' | 'budget' {
    if (!boundsOverlap(bounds[firstTriangle], bounds[secondTriangle], linearTolerance)) return 'tested';
    if (sharedGeometricVertexCount(mesh, firstTriangle, secondTriangle, linearTolerance) >= 2) return 'tested';
    if (trianglePairTests >= maxTrianglePairTests) return 'budget';
    trianglePairTests += 1;
    if (!trianglesIntersect(mesh, firstTriangle, secondTriangle, linearTolerance)) return 'tested';
    if (markers.length < markerLimit) {
      markers.push({
        regionId: `mesh-self-intersection-${markers.length}`,
        points: trianglePoints(mesh, firstTriangle),
      });
    }
    count += 1;
    return 'tested';
  }
}

function boundedBudget(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`Self-intersection ${label} budget must be a non-negative safe integer.`);
  }
  return resolved;
}

function triangleBounds(mesh: TriangleMesh, triangle: number): TriangleBounds {
  const points = trianglePoints(mesh, triangle);
  const minimum: Vec3 = [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.min(...points.map((point) => point[2])),
  ];
  const maximum: Vec3 = [
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[2])),
  ];
  return {
    minimum,
    maximum,
    center: [
      (minimum[0] + maximum[0]) / 2,
      (minimum[1] + maximum[1]) / 2,
      (minimum[2] + maximum[2]) / 2,
    ],
  };
}

function buildBvh(triangles: readonly number[], bounds: readonly TriangleBounds[]): BvhNode {
  const minimum: MutableVec3 = [Infinity, Infinity, Infinity];
  const maximum: MutableVec3 = [-Infinity, -Infinity, -Infinity];
  const centerMinimum: MutableVec3 = [Infinity, Infinity, Infinity];
  const centerMaximum: MutableVec3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], bounds[triangle].minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], bounds[triangle].maximum[axis]);
      centerMinimum[axis] = Math.min(centerMinimum[axis], bounds[triangle].center[axis]);
      centerMaximum[axis] = Math.max(centerMaximum[axis], bounds[triangle].center[axis]);
    }
  }
  if (triangles.length <= LEAF_TRIANGLES) {
    return { minimum, maximum, triangleCount: triangles.length, triangles: [...triangles] };
  }
  const centerExtent = centerMaximum.map((value, axis) => value - centerMinimum[axis]);
  const axis = centerExtent.indexOf(Math.max(...centerExtent));
  const sorted = [...triangles].sort((left, right) => bounds[left].center[axis] - bounds[right].center[axis] || left - right);
  const middle = Math.floor(sorted.length / 2);
  const left = buildBvh(sorted.slice(0, middle), bounds);
  const right = buildBvh(sorted.slice(middle), bounds);
  return { minimum, maximum, triangleCount: triangles.length, left, right };
}

function boundsOverlap(
  first: Pick<TriangleBounds, 'minimum' | 'maximum'>,
  second: Pick<TriangleBounds, 'minimum' | 'maximum'>,
  tolerance: number,
): boolean {
  return [0, 1, 2].every((axis) => (
    first.maximum[axis] + tolerance >= second.minimum[axis]
    && second.maximum[axis] + tolerance >= first.minimum[axis]
  ));
}

function sharedGeometricVertexCount(
  mesh: TriangleMesh,
  firstTriangle: number,
  secondTriangle: number,
  tolerance: number,
): number {
  const firstOffset = firstTriangle * 3;
  const secondOffset = secondTriangle * 3;
  let shared = 0;
  for (let first = 0; first < 3; first += 1) {
    let matches = false;
    for (let second = 0; second < 3; second += 1) {
      const firstVertex = mesh.indices[firstOffset + first];
      const secondVertex = mesh.indices[secondOffset + second];
      if (firstVertex === secondVertex) {
        matches = true;
        break;
      }
      const firstPoint = point(mesh, firstVertex);
      const secondPoint = point(mesh, secondVertex);
      if (Math.hypot(
        firstPoint[0] - secondPoint[0],
        firstPoint[1] - secondPoint[1],
        firstPoint[2] - secondPoint[2],
      ) <= tolerance) {
        matches = true;
        break;
      }
    }
    if (matches) shared += 1;
  }
  return shared;
}

function trianglesIntersect(mesh: TriangleMesh, firstTriangle: number, secondTriangle: number, tolerance: number): boolean {
  const first = trianglePoints(mesh, firstTriangle);
  const second = trianglePoints(mesh, secondTriangle);
  const firstNormal = cross(subtract(first[1], first[0]), subtract(first[2], first[0]));
  const secondNormal = cross(subtract(second[1], second[0]), subtract(second[2], second[0]));
  const firstNormalLength = length(firstNormal);
  const secondNormalLength = length(secondNormal);
  if (!(firstNormalLength > 0) || !(secondNormalLength > 0)) return false;

  const normalsCross = length(cross(firstNormal, secondNormal));
  const planeDistance = Math.abs(dot(firstNormal, subtract(second[0], first[0]))) / firstNormalLength;
  if (
    normalsCross <= RELATIVE_EPSILON * firstNormalLength * secondNormalLength
    && planeDistance <= tolerance
  ) {
    return coplanarTrianglesOverlap(first, second, firstNormal, tolerance);
  }

  return triangleEdges(first).some(([start, end]) => segmentIntersectsTriangle(start, end, second))
    || triangleEdges(second).some(([start, end]) => segmentIntersectsTriangle(start, end, first));
}

function segmentIntersectsTriangle(start: Vec3, end: Vec3, triangle: readonly [Vec3, Vec3, Vec3]): boolean {
  const direction = subtract(end, start);
  const firstEdge = subtract(triangle[1], triangle[0]);
  const secondEdge = subtract(triangle[2], triangle[0]);
  const h = cross(direction, secondEdge);
  const determinant = dot(firstEdge, h);
  const determinantScale = length(firstEdge) * length(direction) * length(secondEdge);
  if (!(determinantScale > 0) || Math.abs(determinant) <= RELATIVE_EPSILON * determinantScale) return false;
  const inverse = 1 / determinant;
  const fromOrigin = subtract(start, triangle[0]);
  const u = inverse * dot(fromOrigin, h);
  if (u < -RELATIVE_EPSILON || u > 1 + RELATIVE_EPSILON) return false;
  const q = cross(fromOrigin, firstEdge);
  const v = inverse * dot(direction, q);
  if (v < -RELATIVE_EPSILON || u + v > 1 + RELATIVE_EPSILON) return false;
  const t = inverse * dot(secondEdge, q);
  return t > RELATIVE_EPSILON && t < 1 - RELATIVE_EPSILON;
}

function coplanarTrianglesOverlap(
  first: readonly [Vec3, Vec3, Vec3],
  second: readonly [Vec3, Vec3, Vec3],
  normal: Vec3,
  tolerance: number,
): boolean {
  const dropAxis = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])]
    .indexOf(Math.max(Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])));
  const project = (point: Vec3): readonly [number, number] => dropAxis === 0
    ? [point[1], point[2]]
    : dropAxis === 1
      ? [point[0], point[2]]
      : [point[0], point[1]];
  const first2 = first.map(project) as unknown as readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
  const second2 = second.map(project) as unknown as readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
  for (const [a, b] of edges2(first2)) {
    for (const [c, d] of edges2(second2)) {
      if (segmentsProperlyIntersect2(a, b, c, d, tolerance)) return true;
    }
  }
  return pointStrictlyInsideTriangle2(centroid2(first2), second2, tolerance)
    || pointStrictlyInsideTriangle2(centroid2(second2), first2, tolerance);
}

function triangleEdges(points: readonly [Vec3, Vec3, Vec3]): readonly (readonly [Vec3, Vec3])[] {
  return [[points[0], points[1]], [points[1], points[2]], [points[2], points[0]]];
}

function edges2(points: readonly (readonly [number, number])[]): readonly (readonly [readonly [number, number], readonly [number, number]])[] {
  return [[points[0], points[1]], [points[1], points[2]], [points[2], points[0]]];
}

function segmentsProperlyIntersect2(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
  tolerance: number,
): boolean {
  const first = cross2(a, b, c);
  const second = cross2(a, b, d);
  const third = cross2(c, d, a);
  const fourth = cross2(c, d, b);
  const areaTolerance = tolerance * Math.max(distance2(a, b), distance2(c, d), 1);
  const squaredTolerance = areaTolerance ** 2;
  return first * second < -squaredTolerance && third * fourth < -squaredTolerance;
}

function pointStrictlyInsideTriangle2(
  point: readonly [number, number],
  triangle: readonly [readonly [number, number], readonly [number, number], readonly [number, number]],
  tolerance: number,
): boolean {
  const signs = [
    cross2(triangle[0], triangle[1], point),
    cross2(triangle[1], triangle[2], point),
    cross2(triangle[2], triangle[0], point),
  ];
  const areaTolerance = tolerance * Math.max(
    distance2(triangle[0], triangle[1]),
    distance2(triangle[1], triangle[2]),
    distance2(triangle[2], triangle[0]),
    1,
  );
  return signs.every((value) => value > areaTolerance) || signs.every((value) => value < -areaTolerance);
}

function centroid2(points: readonly (readonly [number, number])[]): readonly [number, number] {
  return [
    (points[0][0] + points[1][0] + points[2][0]) / 3,
    (points[0][1] + points[1][1] + points[2][1]) / 3,
  ];
}

function cross2(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function distance2(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function trianglePoints(mesh: TriangleMesh, triangle: number): readonly [Vec3, Vec3, Vec3] {
  const offset = triangle * 3;
  return [
    point(mesh, mesh.indices[offset]),
    point(mesh, mesh.indices[offset + 1]),
    point(mesh, mesh.indices[offset + 2]),
  ];
}

function point(mesh: TriangleMesh, index: number): Vec3 {
  const offset = index * 3;
  return [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]];
}

function subtract(first: Vec3, second: Vec3): Vec3 {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function cross(first: Vec3, second: Vec3): Vec3 {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function dot(first: Vec3, second: Vec3): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
