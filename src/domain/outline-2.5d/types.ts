import type { Axis } from '../types';

export type OutlineMode = 'exact' | 'outline-2.5d';
export type OutlineResultStatus = 'success' | 'warning' | 'failure';
export type OutlineAxisSelection = {
  readonly axis: Axis;
  readonly source: 'candidate' | 'shortest-bounds';
};
export type OutlineLayerSpec = {
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly zMid: number;
};
export type OutlineBudgets = {
  readonly minLayers: 6;
  readonly maxLayers: 24;
  readonly maxRasterWidth: 1024;
  readonly maxRasterHeight: 1024;
  readonly maxRasterCellsTotal: 16_777_216;
  readonly maxTriangleLayerTests: 12_000_000;
  readonly maxContourPointsPerLayer: 4096;
  readonly maxRuntimeMs: number;
};

export const DEFAULT_OUTLINE_BUDGETS: OutlineBudgets = Object.freeze({
  minLayers: 6,
  maxLayers: 24,
  maxRasterWidth: 1024,
  maxRasterHeight: 1024,
  maxRasterCellsTotal: 16_777_216,
  maxTriangleLayerTests: 12_000_000,
  maxContourPointsPerLayer: 4096,
  maxRuntimeMs: Number.POSITIVE_INFINITY,
});
