import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { ProjectedMesh } from '../outline-2.5d/raster';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineBudgets } from '../outline-2.5d/types';
import {
  DEPTH_CONTRAST_OMISSION_WARNING,
  extractAdaptiveDepthFeatures,
  type DepthFeatureRequest,
} from './depth-field';

type Patch = Readonly<{ minX: number; maxX: number; minY: number; maxY: number; depth: number }>;

function patchedSurface(patches: readonly Patch[]): ProjectedMesh {
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const quad = (patch: Patch, z: number, reverse: boolean): void => {
    const first = vertices.length;
    vertices.push(
      [patch.minX, patch.minY, z], [patch.maxX, patch.minY, z],
      [patch.maxX, patch.maxY, z], [patch.minX, patch.maxY, z],
    );
    if (reverse) triangles.push([first, first + 2, first + 1], [first, first + 3, first + 2]);
    else triangles.push([first, first + 1, first + 2], [first, first + 2, first + 3]);
  };
  for (const patch of patches) {
    quad(patch, 0, true);
    quad(patch, patch.depth, false);
  }
  const minX = Math.min(...patches.map((patch) => patch.minX));
  const minY = Math.min(...patches.map((patch) => patch.minY));
  const maxX = Math.max(...patches.map((patch) => patch.maxX));
  const maxY = Math.max(...patches.map((patch) => patch.maxY));
  return {
    vertices,
    triangles,
    minX,
    minY,
    maxX,
    maxY,
    planarDiameter: Math.hypot(maxX - minX, maxY - minY),
  };
}

function steppedSurface(): ProjectedMesh {
  return patchedSurface([
    { minX: -5, maxX: -2, minY: -5, maxY: 5, depth: 5 },
    { minX: -2, maxX: 5, minY: -5, maxY: 5, depth: 1 },
  ]);
}

const exterior: readonly Point2[] = [[-5, -5], [-5, 5], [5, 5], [5, -5]];

function request(overrides: Partial<DepthFeatureRequest> = {}): DepthFeatureRequest {
  return {
    layerId: 'outline-layer-0',
    layer: { index: 0, zStart: 0, zMid: 0.5, zEnd: 1 },
    exterior,
    exteriorAreaMm2: 100,
    cellSizeMm: 0.5,
    planarDiameterMm: Math.hypot(10, 10),
    budgets: DEFAULT_OUTLINE_BUDGETS,
    deadline: Date.now() + 30_000,
    ...overrides,
  };
}

function shuffled(projected: ProjectedMesh): ProjectedMesh {
  return { ...projected, triangles: [...projected.triangles].reverse() };
}

function boundsOverlap(
  left: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
  right: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
): boolean {
  return left.minX < right.maxX && left.maxX > right.minX
    && left.minY < right.maxY && left.maxY > right.minY;
}

describe('adaptive source-triangle depth features', () => {
  it('assigns the smaller deeper band to red and the larger shallower band to blue', () => {
    const features = extractAdaptiveDepthFeatures(steppedSurface(), request());

    expect(features.red?.role).toBe('DEEP_RED');
    expect(features.blue?.role).toBe('LIGHT_BLUE');
    expect(features.diagnostics.redThresholdMm).toBe(5);
    expect(features.diagnostics.blueThresholdMm).toBe(1);
    expect(features.diagnostics.redThresholdMm).toBeGreaterThan(features.diagnostics.blueThresholdMm);
    expect(features.red!.areaMm2).toBeLessThan(features.blue!.areaMm2);
    expect(features.evidence.red?.minimumDepthMm).toBeGreaterThanOrEqual(features.diagnostics.redThresholdMm);
    expect(features.evidence.blue?.maximumDepthMm).toBeLessThan(features.diagnostics.redThresholdMm);
  });

  it('keeps one greatest connected region per role with a deterministic min-X/Y tie break', () => {
    const surface = patchedSurface([
      { minX: -5, maxX: -3, minY: -5, maxY: 5, depth: 5 },
      { minX: -1, maxX: 1, minY: -5, maxY: 5, depth: 1 },
      { minX: 3, maxX: 5, minY: -5, maxY: 5, depth: 5 },
      { minX: -3, maxX: -1, minY: -5, maxY: 5, depth: 2 },
      { minX: 1, maxX: 3, minY: -5, maxY: 5, depth: 2 },
    ]);

    const features = extractAdaptiveDepthFeatures(surface, request());

    expect(features.red).toBeDefined();
    expect(features.red!.boundsMm.maxX).toBeLessThan(0);
    expect(features.evidence.red?.componentCount).toBe(2);
    expect(features.blue).toBeDefined();
  });

  it('uses adaptive textured-surface quantiles instead of fixed millimeter levels', () => {
    const textured = patchedSurface([
      { minX: -5, maxX: -2, minY: -5, maxY: 5, depth: 7 },
      { minX: -2, maxX: 1, minY: -5, maxY: 5, depth: 3 },
      { minX: 1, maxX: 5, minY: -5, maxY: 5, depth: 1 },
    ]);

    const features = extractAdaptiveDepthFeatures(textured, request());

    expect(features.diagnostics).toMatchObject({ redThresholdMm: 7, blueThresholdMm: 3 });
    expect(features.red?.role).toBe('DEEP_RED');
    expect(features.blue?.role).toBe('LIGHT_BLUE');
  });

  it('removes isolated noisy cells below the bounded minimum component area', () => {
    const noisy = patchedSurface([
      { minX: -5, maxX: -1.5, minY: -5, maxY: 5, depth: 5 },
      { minX: -1.5, maxX: 5, minY: -5, maxY: 5, depth: 1 },
      { minX: 3, maxX: 3.5, minY: 3, maxY: 3.5, depth: 6 },
    ]);

    const features = extractAdaptiveDepthFeatures(noisy, request());

    expect(features.red).toBeDefined();
    expect(features.red!.boundsMm.maxX).toBeLessThan(0);
    expect(features.evidence.red?.componentCount).toBe(1);
  });

  it('masks the central hole plus cut clearance before tracing feature contours', () => {
    const hole = [[-0.75, -0.75], [-0.75, 0.75], [0.75, 0.75], [0.75, -0.75]] as const;
    const surface = patchedSurface([
      { minX: -5, maxX: -1.5, minY: -5, maxY: 5, depth: 5 },
      { minX: 1.5, maxX: 5, minY: -5, maxY: 5, depth: 1 },
    ]);

    const features = extractAdaptiveDepthFeatures(surface, request({ centralHole: hole }));
    const holeBounds = { minX: -0.75, minY: -0.75, maxX: 0.75, maxY: 0.75 };

    expect(features.red).toBeDefined();
    expect(features.blue).toBeDefined();
    expect(boundsOverlap(features.red!.boundsMm, holeBounds)).toBe(false);
    expect(features.blue!.boundsMm.minX).toBeGreaterThan(holeBounds.maxX);
  });

  it('is deterministic under source-triangle shuffling', () => {
    const surface = steppedSurface();

    expect(extractAdaptiveDepthFeatures(shuffled(surface), request()))
      .toEqual(extractAdaptiveDepthFeatures(surface, request()));
  });

  it('omits both bands with the exact sanitized warning when surface contrast is insufficient', () => {
    const flat = patchedSurface([{ minX: -5, maxX: 5, minY: -5, maxY: 5, depth: 2 }]);

    const features = extractAdaptiveDepthFeatures(flat, request());

    expect(features).toMatchObject({
      red: undefined,
      blue: undefined,
      omissionCode: 'INSUFFICIENT_CONTRAST',
      warning: DEPTH_CONTRAST_OMISSION_WARNING,
      diagnostics: { contrastMm: 0, redThresholdMm: 2, blueThresholdMm: 2 },
    });
    expect(features.warning).toBe('表面深度差不足，已省略雕刻特徵');
    expect(features.warning).not.toMatch(/[\\/@]|[\w.+-]+@[\w.-]+/);
  });

  it('fails closed before raster work when the shared absolute deadline has expired', () => {
    const checkpoint = (): void => { throw new Error('checkpoint reached'); };

    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({ deadline: 0, checkpoint })))
      .toThrow('checkpoint reached');
  });

  it('fails closed on total raster-cell and triangle-layer budget exhaustion', () => {
    const tinyCellBudget = {
      ...DEFAULT_OUTLINE_BUDGETS,
      maxRasterCellsTotal: 100,
    } as unknown as OutlineBudgets;
    const tinyTriangleBudget = {
      ...DEFAULT_OUTLINE_BUDGETS,
      maxTriangleLayerTests: 1,
    } as unknown as OutlineBudgets;

    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({ budgets: tinyCellBudget })))
      .toThrow(/raster cell budget/i);
    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({ budgets: tinyTriangleBudget })))
      .toThrow(/triangle-layer test budget/i);
  });
});
