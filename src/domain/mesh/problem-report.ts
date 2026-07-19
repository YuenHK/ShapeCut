import type { Vec3 } from '../types';
import { inspectMesh } from './inspect-mesh';
import { meshNumerics } from './numerics';
import { analyzeSelfIntersections, type SelfIntersectionBudget } from './self-intersection';
import type { EdgeMarker, MeshProblemReport, TriangleMarker, TriangleMesh } from './types';

type EdgeIncidence = {
  readonly a: number;
  readonly b: number;
  count: number;
  forwardCount: number;
  reverseCount: number;
};

export function analyzeMeshProblems(
  mesh: TriangleMesh,
  markerLimit = 2_000,
  selfIntersectionBudget: SelfIntersectionBudget = {},
): MeshProblemReport {
  if (!Number.isInteger(markerLimit) || markerLimit < 0) {
    throw new RangeError('Marker limit must be a non-negative integer.');
  }

  const { areaToleranceSquared } = meshNumerics(mesh);
  const edgeIncidences = new Map<string, EdgeIncidence>();
  const triangleCounts = new Map<string, number>();
  const degenerateTriangles: TriangleMarker[] = [];
  const duplicateTriangles: TriangleMarker[] = [];
  let degenerateTriangleCount = 0;
  let duplicateTriangleCount = 0;

  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    addEdgeIncidence(edgeIncidences, a, b);
    addEdgeIncidence(edgeIncidences, b, c);
    addEdgeIncidence(edgeIncidences, c, a);

    const sortedIndices = [a, b, c].sort((left, right) => left - right) as [number, number, number];
    const triangleKey = sortedIndices.join(':');
    const previousTriangleCount = triangleCounts.get(triangleKey) ?? 0;
    triangleCounts.set(triangleKey, previousTriangleCount + 1);
    if (previousTriangleCount > 0) {
      if (duplicateTriangles.length < markerLimit) {
        duplicateTriangles.push({
          regionId: `mesh-duplicate-triangle-${duplicateTriangles.length}`,
          points: trianglePoints(mesh, sortedIndices[0], sortedIndices[1], sortedIndices[2]),
        });
      }
      duplicateTriangleCount += 1;
    }

    if (isDegenerate(mesh, a, b, c, areaToleranceSquared)) {
      if (degenerateTriangles.length < markerLimit) {
        degenerateTriangles.push({
          regionId: `mesh-degenerate-triangle-${degenerateTriangles.length}`,
          points: trianglePoints(mesh, a, b, c),
        });
      }
      degenerateTriangleCount += 1;
    }
  }

  const boundaryEdges: EdgeMarker[] = [];
  const nonManifoldEdges: EdgeMarker[] = [];
  const inconsistentWindingEdges: EdgeMarker[] = [];
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let inconsistentWindingEdgeCount = 0;
  for (const edge of edgeIncidences.values()) {
    if (edge.count === 1) {
      if (boundaryEdges.length < markerLimit) {
        boundaryEdges.push(edgeMarker(mesh, edge, `mesh-boundary-edge-${boundaryEdges.length}`));
      }
      boundaryEdgeCount += 1;
    } else if (edge.count > 2) {
      if (nonManifoldEdges.length < markerLimit) {
        nonManifoldEdges.push(edgeMarker(mesh, edge, `mesh-non-manifold-edge-${nonManifoldEdges.length}`));
      }
      nonManifoldEdgeCount += 1;
    } else if (edge.forwardCount !== 1 || edge.reverseCount !== 1) {
      if (inconsistentWindingEdges.length < markerLimit) {
        inconsistentWindingEdges.push(edgeMarker(mesh, edge, `mesh-winding-edge-${inconsistentWindingEdges.length}`));
      }
      inconsistentWindingEdgeCount += 1;
    }
  }
  const selfIntersections = analyzeSelfIntersections(mesh, markerLimit, selfIntersectionBudget);

  return {
    inspection: inspectMesh(mesh),
    duplicateTriangleCount,
    inconsistentWindingEdgeCount,
    selfIntersectionCount: selfIntersections.count,
    selfIntersectionAnalysisComplete: selfIntersections.complete,
    boundaryEdges,
    nonManifoldEdges,
    degenerateTriangles,
    duplicateTriangles,
    inconsistentWindingEdges,
    selfIntersections: selfIntersections.markers,
    markersTruncated: {
      boundaryEdges: boundaryEdgeCount > boundaryEdges.length,
      nonManifoldEdges: nonManifoldEdgeCount > nonManifoldEdges.length,
      degenerateTriangles: degenerateTriangleCount > degenerateTriangles.length,
      duplicateTriangles: duplicateTriangleCount > duplicateTriangles.length,
      inconsistentWindingEdges: inconsistentWindingEdgeCount > inconsistentWindingEdges.length,
      selfIntersections: selfIntersections.count > selfIntersections.markers.length,
    },
  };
}

function addEdgeIncidence(edges: Map<string, EdgeIncidence>, first: number, second: number): void {
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = `${a}:${b}`;
  const existing = edges.get(key);
  const forward = first === a && second === b;
  if (existing) {
    existing.count += 1;
    if (forward) existing.forwardCount += 1;
    else existing.reverseCount += 1;
  } else {
    edges.set(key, { a, b, count: 1, forwardCount: forward ? 1 : 0, reverseCount: forward ? 0 : 1 });
  }
}

function isDegenerate(
  mesh: TriangleMesh,
  a: number,
  b: number,
  c: number,
  areaToleranceSquared: number,
): boolean {
  if (a === b || b === c || c === a) return true;
  const pointA = point(mesh, a);
  const pointB = point(mesh, b);
  const pointC = point(mesh, c);
  const abx = pointB[0] - pointA[0];
  const aby = pointB[1] - pointA[1];
  const abz = pointB[2] - pointA[2];
  const acx = pointC[0] - pointA[0];
  const acy = pointC[1] - pointA[1];
  const acz = pointC[2] - pointA[2];
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  return crossX ** 2 + crossY ** 2 + crossZ ** 2 <= areaToleranceSquared;
}

function edgeMarker(mesh: TriangleMesh, edge: EdgeIncidence, regionId: string): EdgeMarker {
  return { regionId, points: [point(mesh, edge.a), point(mesh, edge.b)] };
}

function trianglePoints(mesh: TriangleMesh, a: number, b: number, c: number): readonly [Vec3, Vec3, Vec3] {
  return [point(mesh, a), point(mesh, b), point(mesh, c)];
}

function point(mesh: TriangleMesh, index: number): Vec3 {
  const offset = index * 3;
  return [mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]];
}
