import { describe, expect, test } from 'vitest';
import { analyzeMeshProblems } from './problem-report';
import type { TriangleMesh } from './types';
import {
  interpenetratingTetrahedra,
  tetrahedron,
  tetrahedronWithOneReversedFace,
} from '../../test/mesh-builders';

describe('mesh problem reports', () => {
  test('reports duplicate faces independent of winding and bounds marker payloads', () => {
    const report = analyzeMeshProblems(meshWithRepeatedFace(2), 1);

    expect(report.duplicateTriangleCount).toBe(2);
    expect(report.duplicateTriangles).toHaveLength(1);
    expect(report.duplicateTriangles[0]).toEqual({
      regionId: 'mesh-duplicate-triangle-0',
      points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    });
    expect(report.markersTruncated.duplicateTriangles).toBe(true);
  });

  test('returns stable coordinates and region ids for non-manifold edges', () => {
    const report = analyzeMeshProblems(threeFacesSharingOneEdge());

    expect(report.inspection.nonManifoldEdgeCount).toBe(1);
    expect(report.nonManifoldEdges[0]).toMatchObject({ regionId: 'mesh-non-manifold-edge-0' });
    expect(report.nonManifoldEdges[0].points).toEqual([[0, 0, 0], [1, 0, 0]]);
  });

  test('reports boundary and degenerate marker coordinates', () => {
    const mesh: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };

    const report = analyzeMeshProblems(mesh);

    expect(report.inspection.boundaryEdgeCount).toBe(3);
    expect(report.boundaryEdges).toEqual([
      { regionId: 'mesh-boundary-edge-0', points: [[0, 0, 0], [1, 0, 0]] },
      { regionId: 'mesh-boundary-edge-1', points: [[1, 0, 0], [2, 0, 0]] },
      { regionId: 'mesh-boundary-edge-2', points: [[0, 0, 0], [2, 0, 0]] },
    ]);
    expect(report.inspection.degenerateTriangleCount).toBe(1);
    expect(report.degenerateTriangles).toEqual([
      {
        regionId: 'mesh-degenerate-triangle-0',
        points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
      },
    ]);
  });

  test('continues counting topology entries after marker payloads are truncated', () => {
    const report = analyzeMeshProblems(meshWithRepeatedFace(2), 0);

    expect(report.inspection.boundaryEdgeCount).toBe(0);
    expect(report.duplicateTriangleCount).toBe(2);
    expect(report.boundaryEdges).toEqual([]);
    expect(report.duplicateTriangles).toEqual([]);
    expect(report.markersTruncated).toEqual({
      boundaryEdges: false,
      nonManifoldEdges: true,
      degenerateTriangles: false,
      duplicateTriangles: true,
      inconsistentWindingEdges: false,
      selfIntersections: false,
    });
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid marker limit %s',
    (markerLimit) => {
      expect(() => analyzeMeshProblems(meshWithRepeatedFace(0), markerLimit)).toThrow(/marker limit/i);
    },
  );

  test.each([1e-6, 1e6])('uses scale-aware degeneracy diagnostics at scale %s', (scale) => {
    const valid: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, scale, 0, 0, 0, scale, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const collinear: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, scale, 0, 0, 2 * scale, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };

    expect(analyzeMeshProblems(valid).degenerateTriangles).toHaveLength(0);
    expect(analyzeMeshProblems(collinear).degenerateTriangles).toHaveLength(1);
  });

  test('reports closed topology whose incident faces use a shared edge in the same direction', () => {
    const report = analyzeMeshProblems(tetrahedronWithOneReversedFace());

    expect(report.inspection).toMatchObject({ boundaryEdgeCount: 0, nonManifoldEdgeCount: 0 });
    expect(report.inconsistentWindingEdgeCount).toBe(3);
    expect(report.inconsistentWindingEdges).toHaveLength(3);
  });

  test('detects intersections between disconnected closed shells without flagging adjacent tetrahedron faces', () => {
    const valid = analyzeMeshProblems(tetrahedron());
    const intersecting = analyzeMeshProblems(interpenetratingTetrahedra());

    expect(valid.selfIntersectionAnalysisComplete).toBe(true);
    expect(valid.selfIntersectionCount).toBe(0);
    expect(intersecting.inspection).toMatchObject({ boundaryEdgeCount: 0, nonManifoldEdgeCount: 0 });
    expect(intersecting.selfIntersectionAnalysisComplete).toBe(true);
    expect(intersecting.selfIntersectionCount).toBeGreaterThan(0);
    expect(intersecting.selfIntersections.length).toBeGreaterThan(0);
  });

  test('reports an incomplete self-intersection analysis when the triangle-pair budget is exhausted', () => {
    const report = analyzeMeshProblems(interpenetratingTetrahedra(), 2_000, { maxTrianglePairTests: 0 });

    expect(report.selfIntersectionAnalysisComplete).toBe(false);
  });
});

function meshWithRepeatedFace(repeatedCopies: number): TriangleMesh {
  const faces = [0, 1, 2];
  if (repeatedCopies >= 1) faces.push(2, 1, 0);
  if (repeatedCopies >= 2) faces.push(1, 2, 0);
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array(faces),
  };
}

function threeFacesSharingOneEdge(): TriangleMesh {
  return {
    positions: new Float64Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, -1, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 1, 2,
      1, 0, 3,
      0, 1, 4,
    ]),
  };
}
