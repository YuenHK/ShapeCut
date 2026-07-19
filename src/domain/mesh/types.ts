import type { Vec3 } from '../types';

export type TriangleMesh = {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
};

export type MeshInspection = {
  readonly triangleCount: number;
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly degenerateTriangleCount: number;
  readonly invertedVolume: boolean;
};

export type EdgeMarker = {
  readonly regionId: string;
  readonly points: readonly [Vec3, Vec3];
};

export type TriangleMarker = {
  readonly regionId: string;
  readonly points: readonly [Vec3, Vec3, Vec3];
};

export type MeshProblemCategory =
  | 'boundaryEdges'
  | 'nonManifoldEdges'
  | 'degenerateTriangles'
  | 'duplicateTriangles';

export type MeshProblemReport = {
  readonly inspection: MeshInspection;
  readonly duplicateTriangleCount: number;
  readonly boundaryEdges: readonly EdgeMarker[];
  readonly nonManifoldEdges: readonly EdgeMarker[];
  readonly degenerateTriangles: readonly TriangleMarker[];
  readonly duplicateTriangles: readonly TriangleMarker[];
  readonly markersTruncated: Readonly<Record<MeshProblemCategory, boolean>>;
};

export type MassProperties = {
  readonly volume: number;
  readonly centroid: Vec3;
};

export type MeshComparison = {
  readonly beforeSize: Vec3;
  readonly afterSize: Vec3;
  readonly axisChangePercent: Vec3;
  readonly beforeAbsoluteVolume: number;
  readonly afterAbsoluteVolume: number;
  readonly volumeChangePercent: number;
};

export type MeshRepairChanges = {
  readonly removedDegenerate: number;
  readonly removedDuplicate: number;
  readonly weldedVertices: number;
  readonly splitVertices: number;
  readonly filledHoles: number;
};

export type MeshRepairResult = {
  readonly mode: 'safe' | 'advanced';
  readonly mesh: TriangleMesh;
  readonly before: MeshProblemReport;
  readonly after: MeshProblemReport;
  readonly changes: MeshRepairChanges;
  readonly comparison: MeshComparison;
  readonly accepted: boolean;
  readonly blockingReasons: readonly string[];
};
