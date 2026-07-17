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

export type MassProperties = {
  readonly volume: number;
  readonly centroid: Vec3;
};
