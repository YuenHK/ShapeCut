import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { ProjectedMesh } from '../outline-2.5d/raster';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineBudgets } from '../outline-2.5d/types';
import {
  DEPTH_CONTRAST_OMISSION_WARNING,
  DEPTH_DATA_OMISSION_WARNING,
  ProtectedCutWorkBudgetError,
  buildDepthField,
  closeDepthBandMask,
  extractAdaptiveDepthFeatures,
  simplifyDepthFeatureLoop,
  type DepthFeatureRequest,
} from './depth-field';

type Patch = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  depth: number;
  baseZ?: number;
}>;

function patchedSurface(patches: readonly Patch[], closeSides = true): ProjectedMesh {
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const quad = (patch: Patch, z: number, reverse: boolean): number => {
    const first = vertices.length;
    vertices.push(
      [patch.minX, patch.minY, z], [patch.maxX, patch.minY, z],
      [patch.maxX, patch.maxY, z], [patch.minX, patch.maxY, z],
    );
    if (reverse) triangles.push([first, first + 2, first + 1], [first, first + 3, first + 2]);
    else triangles.push([first, first + 1, first + 2], [first, first + 2, first + 3]);
    return first;
  };
  for (const patch of patches) {
    const baseZ = patch.baseZ ?? 0;
    const bottom = quad(patch, baseZ, true);
    const top = quad(patch, baseZ + patch.depth, false);
    if (closeSides) {
      triangles.push(
        [bottom, bottom + 1, top + 1], [bottom, top + 1, top],
        [bottom + 1, bottom + 2, top + 2], [bottom + 1, top + 2, top + 1],
        [bottom + 2, bottom + 3, top + 3], [bottom + 2, top + 3, top + 2],
        [bottom + 3, bottom, top], [bottom + 3, top, top + 3],
      );
    }
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
    layer: { index: 0, zStart: 0, zMid: 4, zEnd: 8 },
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
  it('uses a dedicated typed error only for protected-cut work-product exhaustion', () => {
    const protectedCut = Array.from({ length: 2_000 }, (_, index) => {
      const angle = index * Math.PI * 2 / 2_000;
      return [Math.cos(angle), Math.sin(angle)] as const;
    });

    expect(() => buildDepthField(steppedSurface(), request({
      cellSizeMm: 0.05,
      protectedCuts: [protectedCut],
    }))).toThrow(ProtectedCutWorkBudgetError);
  });

  it('fails invalid protected topology before classifying the same request as work-budget exhaustion', () => {
    const bowTie = [[-1, -1], [1, 1], [-1, 1], [1, -1]] as const;
    const invalidOverBudgetCut = Array.from(
      { length: 2_000 },
      (_, index) => bowTie[index % bowTie.length],
    );
    let thrown: unknown;

    try {
      buildDepthField(steppedSurface(), request({
        cellSizeMm: 0.05,
        protectedCuts: [invalidOverBudgetCut],
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RangeError);
    expect(thrown).not.toBeInstanceOf(ProtectedCutWorkBudgetError);
    expect((thrown as Error).message).toMatch(/valid protected cut geometry/i);
  });

  it('does not type unrelated raster, hit, component, topology, deadline, or cancellation errors as protected-cut work exhaustion', () => {
    const thrown = (action: () => unknown): unknown => {
      try {
        action();
      } catch (error) {
        return error;
      }
      throw new Error('Expected action to throw');
    };
    const invalidTopology = {
      ...steppedSurface(),
      triangles: [[Number.MAX_SAFE_INTEGER, 1, 2] as const],
    };
    const cancellation = new Error('cancelled exactly');
    const errors = [
      thrown(() => buildDepthField(steppedSurface(), request({
        budgets: {
          ...DEFAULT_OUTLINE_BUDGETS,
          maxRasterWidth: 1,
        } as unknown as OutlineBudgets,
      }))),
      thrown(() => buildDepthField(steppedSurface(), request({ maximumSurfaceHits: 1 }))),
      thrown(() => buildDepthField(steppedSurface(), request({
        maximumComponentBytes: 64 * 1024 * 1024 + 1,
      }))),
      thrown(() => buildDepthField(invalidTopology, request())),
      thrown(() => buildDepthField(steppedSurface(), request({
        deadline: 0,
        checkpoint: () => undefined,
      }))),
      thrown(() => buildDepthField(steppedSurface(), request({
        checkpoint: () => { throw cancellation; },
      }))),
    ];

    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(errors.every((error) => !(error instanceof ProtectedCutWorkBudgetError))).toBe(true);
    expect(errors.at(-1)).toBe(cancellation);
  });

  it('omits decoration only for the layer whose protected-cut work product exceeds the bound', () => {
    const protectedCut = Array.from({ length: 2_000 }, (_, index) => {
      const angle = index * Math.PI * 2 / 2_000;
      return [Math.cos(angle), Math.sin(angle)] as const;
    });

    const affected = extractAdaptiveDepthFeatures(steppedSurface(), request({
      layerId: 'outline-layer-0',
      cellSizeMm: 0.05,
      protectedCuts: [protectedCut],
    }));
    const unaffected = extractAdaptiveDepthFeatures(steppedSurface(), request({
      layerId: 'outline-layer-1',
    }));

    expect(affected.red).toEqual([]);
    expect(affected.blue).toEqual([]);
    expect(affected.omissionCode).toBe('PROTECTED_CUT_WORK_BUDGET');
    expect(affected.diagnostics.omissionCode).toBe('PROTECTED_CUT_WORK_BUDGET');
    expect(unaffected.red.length + unaffected.blue.length).toBeGreaterThan(0);
  });

  it('identity-propagates exact deadline, cancellation, topology, and resource failures around field construction', () => {
    const deadline = new Error('deadline identity');
    let deadlinePolls = 0;
    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({
      checkpoint: () => {
        deadlinePolls += 1;
        if (deadlinePolls === 2) throw deadline;
      },
    }))).toThrow(deadline);

    const cancellation = new Error('cancellation identity');
    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({
      checkpoint: () => { throw cancellation; },
    }))).toThrow(cancellation);

    const topology = new Error('topology identity');
    const invalidTopology = { ...steppedSurface() };
    Object.defineProperty(invalidTopology, 'triangles', {
      get: () => { throw topology; },
    });
    expect(() => extractAdaptiveDepthFeatures(invalidTopology, request())).toThrow(topology);

    const resource = new Error('resource identity');
    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({
      resourceObserver: () => { throw resource; },
    }))).toThrow(resource);
  });

  it('closes a one-cell crack while respecting valid-domain and competing-role masks', () => {
    const width = 7, height = 7;
    const source = new Uint8Array(width * height);
    const legal = new Uint8Array(width * height).fill(1);
    const competing = new Uint8Array(width * height);
    for (let y = 1; y <= 5; y += 1) for (let x = 1; x <= 5; x += 1) source[y * width + x] = 1;
    const crack = 3 * width + 3;
    const prohibited = 3 * width + 4;
    source[crack] = 0;
    legal[prohibited] = 0;
    competing[2 * width + 3] = 1;

    const closed = closeDepthBandMask(source, legal, competing, width, height);

    expect(closed[crack]).toBe(1);
    expect(closed[prohibited]).toBe(0);
    expect(closed[2 * width + 3]).toBe(0);
  });

  it('locally rejects a forced point-cap fallback when its final contour exceeds the 3% drift gate', () => {
    const source = Array.from({ length: 5000 }, (_, index) => {
      const angle = index / 5000 * Math.PI * 2;
      return [Math.cos(angle) * 10, Math.sin(angle) * 10] as const;
    });

    expect(simplifyDepthFeatureLoop(source, 0.1, 20, 3, Infinity, () => undefined, 100))
      .toBeUndefined();
  });

  it('honors the caller checkpoint from inside RDP simplification traversal', () => {
    const source = Array.from({ length: 2048 }, (_, index) => {
      const angle = index / 2048 * Math.PI * 2;
      const radius = index % 2 === 0 ? 10 : 9;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius] as const;
    });
    const checkpoint = (): void => {
      if (new Error().stack?.includes('rdpOpenIndices')) {
        throw new Error('cancelled during RDP simplification');
      }
    };

    expect(() => simplifyDepthFeatureLoop(source, 0.001, 20, 4096, Infinity, checkpoint, 0.001))
      .toThrow('cancelled during RDP simplification');
  });

  it('clips paired surface intervals to the requested layer and ignores remote slabs', () => {
    const surface = patchedSurface([
      { minX: -5, maxX: -1, minY: -5, maxY: 5, depth: 4 },
      { minX: -1, maxX: 5, minY: -5, maxY: 5, depth: 1 },
      { minX: -5, maxX: 5, minY: -5, maxY: 5, baseZ: 10, depth: 2 },
    ]);
    const lowerRequest = request({ layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 } });
    const upperRequest = request({ layerId: 'outline-layer-1', layer: { index: 1, zStart: 10, zMid: 11, zEnd: 12 } });

    const lowerField = buildDepthField(surface, lowerRequest);
    const upperField = buildDepthField(surface, upperRequest);
    const lowerDepths = [...lowerField.depthMm].filter((depth, index) => lowerField.valid[index] && depth > 0);
    const upperDepths = [...upperField.depthMm].filter((depth, index) => upperField.valid[index] && depth > 0);

    expect(new Set(lowerDepths)).toEqual(new Set([1, 4]));
    expect(new Set(upperDepths)).toEqual(new Set([2]));
    expect(extractAdaptiveDepthFeatures(surface, lowerRequest).diagnostics.contrastMm).toBeGreaterThan(0);
    expect(extractAdaptiveDepthFeatures(surface, upperRequest)).toMatchObject({
      red: [],
      blue: [],
      omissionCode: 'INSUFFICIENT_CONTRAST',
    });
  });

  it('fails closed before hit-array allocation when the configured or derived crossing budget is exceeded', () => {
    const surface = steppedSurface();

    expect(() => buildDepthField(surface, request({
      maximumSurfaceHits: 1,
    } as unknown as Partial<DepthFeatureRequest>))).toThrow(/surface-hit resource budget/i);
    expect(() => buildDepthField(surface, request({
      maximumSurfaceHits: Number.MAX_SAFE_INTEGER,
    } as unknown as Partial<DepthFeatureRequest>))).toThrow(/surface-hit resource budget/i);
  });

  it('keeps multi-component workspaces linear in raster cells instead of components times cells', () => {
    const patches: Patch[] = [];
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
      patches.push({
        minX: -4.5 + x * 2.25,
        maxX: -3 + x * 2.25,
        minY: -4.5 + y * 2.25,
        maxY: -3 + y * 2.25,
        depth: (x + y) % 2 === 0 ? 4 : 1,
      });
    }
    const allocations: { phase: string; liveBytes: number; rasterCells: number }[] = [];

    extractAdaptiveDepthFeatures(patchedSurface(patches), request({
      cellSizeMm: 0.25,
      layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 },
      resourceObserver: (event: { phase: string; liveBytes: number; rasterCells: number }) => allocations.push(event),
    } as unknown as Partial<DepthFeatureRequest>));

    const componentEvents = allocations.filter((event) => (
      event.phase === 'component-labels' || event.phase === 'component-candidate'
    ));
    const hitStorage = allocations.find((event) => event.phase === 'surface-hit-storage');
    expect(componentEvents.length).toBeGreaterThan(0);
    expect(Math.max(...componentEvents.map((event) => event.liveBytes / event.rasterCells)))
      .toBeLessThanOrEqual(24);
    expect(hitStorage?.liveBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('rejects a sawtooth boundary before typed edge allocation when remaining component bytes are exhausted', () => {
    const patches: Patch[] = [
      { minX: -5, maxX: -1, minY: -4, maxY: -3, depth: 4 },
      { minX: 0, maxX: 5, minY: -4, maxY: 4, depth: 1 },
    ];
    for (let tooth = 0; tooth < 8; tooth += 1) patches.push({
      minX: -5 + tooth * 0.5,
      maxX: -4.75 + tooth * 0.5,
      minY: -3,
      maxY: 4,
      depth: 4,
    });
    const firstEvents: { phase: string; liveBytes: number; rasterCells: number; minimumX?: number }[] = [];
    const surface = patchedSurface(patches);
    const normal = extractAdaptiveDepthFeatures(surface, request({
      cellSizeMm: 0.25,
      layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 },
      resourceObserver: (event) => firstEvents.push(event),
    }));
    const boundaryLimit = Math.min(...firstEvents
      .filter((event) => event.phase === 'component-boundary')
      .map((event) => event.liveBytes)) - 1;
    const limitedEvents: { phase: string; liveBytes: number; rasterCells: number; minimumX?: number }[] = [];

    const limited = extractAdaptiveDepthFeatures(surface, request({
      cellSizeMm: 0.25,
      layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 },
      maximumComponentBytes: boundaryLimit,
      resourceObserver: (event) => limitedEvents.push(event),
    }));

    expect(normal.red).toBeDefined();
    expect(Number.isSafeInteger(boundaryLimit)).toBe(true);
    const rejected = limitedEvents.find((event) => event.phase === 'component-boundary-rejected');
    expect(rejected).toBeDefined();
    expect(limitedEvents.some((event) => (
      event.phase === 'component-boundary' && event.minimumX === rejected!.minimumX
    ))).toBe(false);
    expect(limited.red).toEqual([]);
  });

  it('rejects before boundary allocation when tracing fits but RDP workspace does not', () => {
    const patches: Patch[] = [
      { minX: -5, maxX: -1, minY: -4, maxY: -3, depth: 4 },
      { minX: 0, maxX: 5, minY: -4, maxY: 4, depth: 1 },
    ];
    for (let tooth = 0; tooth < 8; tooth += 1) patches.push({
      minX: -5 + tooth * 0.5,
      maxX: -4.75 + tooth * 0.5,
      minY: -3,
      maxY: 4,
      depth: 4,
    });
    const surface = patchedSurface(patches);
    const normalEvents: {
      phase: string;
      liveBytes: number;
      rasterCells: number;
      minimumX?: number;
    }[] = [];

    const normal = extractAdaptiveDepthFeatures(surface, request({
      cellSizeMm: 0.25,
      layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 },
      resourceObserver: (event) => normalEvents.push(event),
    }));
    const simplification = normalEvents.find((event) => event.phase === 'component-simplify');
    const tracing = normalEvents.find((event) => (
      event.phase === 'component-boundary' && event.minimumX === simplification?.minimumX
    ));
    expect(normal.red).toBeDefined();
    expect(simplification).toBeDefined();
    expect(tracing).toBeDefined();
    expect(simplification!.liveBytes).toBeGreaterThan(tracing!.liveBytes);

    const componentLimit = simplification!.liveBytes - 1;
    expect(componentLimit).toBeGreaterThanOrEqual(tracing!.liveBytes);
    const limitedEvents: typeof normalEvents = [];
    const limited = extractAdaptiveDepthFeatures(surface, request({
      cellSizeMm: 0.25,
      layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 },
      maximumComponentBytes: componentLimit,
      resourceObserver: (event) => limitedEvents.push(event),
    }));

    const rejected = limitedEvents.find((event) => (
      event.phase === 'component-simplify-rejected' && event.minimumX === simplification!.minimumX
    ));
    expect(rejected?.liveBytes).toBe(simplification!.liveBytes);
    expect(limitedEvents.some((event) => (
      event.phase === 'component-boundary' && event.minimumX === simplification!.minimumX
    ))).toBe(false);
    expect(limited.red).toEqual([]);
  });

  it('selects the greatest final traced area even when a pre-seam component has more cells', () => {
    const largerPreSeamRing: Patch[] = [
      { minX: -9, maxX: -1, minY: 3.5, maxY: 4, depth: 4 },
      { minX: -9, maxX: -1, minY: -4, maxY: -3.5, depth: 4 },
      { minX: -9, maxX: -3, minY: -3.5, maxY: 3.5, depth: 4 },
      { minX: -1.5, maxX: -1, minY: -3.5, maxY: 3.5, depth: 4 },
    ];
    const laterRectangle: Patch = { minX: 1, maxX: 7.25, minY: -4, maxY: 4, depth: 4 };
    const blueBalance: Patch = { minX: -15, maxX: 15, minY: 6, maxY: 10, depth: 1 };
    const largeExterior = [[-16, -11], [-16, 11], [16, 11], [16, -11]] as const;
    const candidates: {
      phase: string;
      sourceCellCount?: number;
      finalAreaMm2?: number;
      minimumX?: number;
    }[] = [];

    const features = extractAdaptiveDepthFeatures(
      patchedSurface([...largerPreSeamRing, laterRectangle, blueBalance]),
      request({
        exterior: largeExterior,
        exteriorAreaMm2: 704,
        planarDiameterMm: Math.hypot(32, 22),
        layer: { index: 0, zStart: 0, zMid: 2, zEnd: 4 },
        resourceObserver: (event) => candidates.push(event),
      }),
    );
    const finalCandidates = candidates.filter((event) => event.phase === 'component-final');
    const [ring, rectangle] = finalCandidates
      .filter((event) => (event.finalAreaMm2 ?? Infinity) < 100)
      .sort((left, right) => left.minimumX! - right.minimumX!);

    expect(features.red).toBeDefined();
    expect(ring?.sourceCellCount).toBeGreaterThan(rectangle!.sourceCellCount!);
    expect(ring?.finalAreaMm2).toBeLessThan(rectangle!.finalAreaMm2!);
    expect(features.red[0]?.boundsMm.minX).toBeGreaterThan(0);
  });

  it('honors cancellation from inside topology and per-cell hit sorting', () => {
    for (const cancellationPhase of ['topology-sort', 'surface-hit-sort']) {
      let activePhase = '';
      const checkpoint = (): void => {
        if (activePhase === cancellationPhase) throw new Error(`cancelled during ${cancellationPhase}`);
      };

      expect(() => buildDepthField(steppedSurface(), request({
        checkpoint,
        resourceObserver: (event: { phase: string }) => { activePhase = event.phase; },
      } as unknown as Partial<DepthFeatureRequest>))).toThrow(`cancelled during ${cancellationPhase}`);
    }
  });

  it('rejects disconnected open planes as insufficient paired depth evidence', () => {
    const openPlanes = patchedSurface([
      { minX: -5, maxX: -2, minY: -5, maxY: 5, depth: 5 },
      { minX: -2, maxX: 5, minY: -5, maxY: 5, depth: 1 },
    ], false);

    expect(extractAdaptiveDepthFeatures(openPlanes, request())).toMatchObject({
      red: [],
      blue: [],
      omissionCode: 'INSUFFICIENT_DEPTH_DATA',
      warning: DEPTH_DATA_OMISSION_WARNING,
    });
  });

  it('assigns the smaller deeper band to red and the larger shallower band to blue', () => {
    const features = extractAdaptiveDepthFeatures(steppedSurface(), request());

    expect(features.red[0]?.role).toBe('DEEP_RED');
    expect(features.blue[0]?.role).toBe('LIGHT_BLUE');
    expect(features.diagnostics.redThresholdMm).toBe(5);
    expect(features.diagnostics.blueThresholdMm).toBe(1);
    expect(features.diagnostics.redThresholdMm).toBeGreaterThan(features.diagnostics.blueThresholdMm);
    expect(features.red[0]!.areaMm2).toBeLessThan(features.blue[0]!.areaMm2);
    expect(features.evidence.red[0]?.minimumDepthMm).toBeGreaterThanOrEqual(features.diagnostics.redThresholdMm);
    expect(features.evidence.blue[0]?.maximumDepthMm).toBeLessThan(features.diagnostics.redThresholdMm);
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
    expect(features.red[0]!.boundsMm.maxX).toBeLessThan(0);
    expect(features.evidence.red[0]?.componentCount).toBe(2);
    expect(features.blue).toBeDefined();
  });

  it('keeps multiple launcher/fastener-safe candidates when the caller raises the per-role cap', () => {
    const patches: Patch[] = [];
    for (let index = 0; index < 14; index += 1) {
      const minX = -14 + index * 2;
      patches.push({ minX, maxX: minX + 1, minY: -2, maxY: -1, depth: 5 });
      patches.push({ minX, maxX: minX + 1, minY: 1, maxY: 2, depth: 2 });
    }
    const launcherCut = [[-0.25, -2.5], [-0.25, -0.5], [0.25, -0.5], [0.25, -2.5]] as const;
    const fastenerCut = [[5.75, 0.5], [5.75, 2.5], [6.25, 2.5], [6.25, 0.5]] as const;
    const features = extractAdaptiveDepthFeatures(patchedSurface(patches), request({
      exterior: [[-14, -3], [-14, 3], [14, 3], [14, -3]],
      exteriorAreaMm2: 168,
      maximumFeaturesPerRole: 12,
      protectedCuts: [launcherCut, fastenerCut],
    }));

    expect(features.red).toHaveLength(12);
    expect(features.blue).toHaveLength(12);
    expect(features.red.map(({ id }) => id)).toEqual([
      'outline-layer-0-deep-0', 'outline-layer-0-deep-1', 'outline-layer-0-deep-2',
      'outline-layer-0-deep-3', 'outline-layer-0-deep-4', 'outline-layer-0-deep-5',
      'outline-layer-0-deep-6', 'outline-layer-0-deep-7', 'outline-layer-0-deep-8',
      'outline-layer-0-deep-9', 'outline-layer-0-deep-10', 'outline-layer-0-deep-11',
    ]);
    for (const feature of [...features.red, ...features.blue]) for (const blackCut of [
      { minX: -0.75, minY: -3, maxX: 0.75, maxY: 0 },
      { minX: 5.25, minY: 0, maxX: 6.75, maxY: 3 },
    ]) {
      expect(boundsOverlap(feature.boundsMm, blackCut)).toBe(false);
    }
    expect(features.diagnostics.retained).toEqual({ red: 12, blue: 12 });
    expect(features.diagnostics.omitted).toEqual({ red: 0, blue: 0 });
  });

  it('uses adaptive textured-surface quantiles instead of fixed millimeter levels', () => {
    const textured = patchedSurface([
      { minX: -5, maxX: -2, minY: -5, maxY: 5, depth: 7 },
      { minX: -2, maxX: 1, minY: -5, maxY: 5, depth: 3 },
      { minX: 1, maxX: 5, minY: -5, maxY: 5, depth: 1 },
    ]);

    const features = extractAdaptiveDepthFeatures(textured, request());

    expect(features.diagnostics).toMatchObject({ redThresholdMm: 7, blueThresholdMm: 3 });
    expect(features.red[0]?.role).toBe('DEEP_RED');
    expect(features.blue[0]?.role).toBe('LIGHT_BLUE');
  });

  it('removes isolated noisy cells below the bounded minimum component area', () => {
    const noisy = patchedSurface([
      { minX: -5, maxX: -1.5, minY: -5, maxY: 5, depth: 5 },
      { minX: -1.5, maxX: 5, minY: -5, maxY: 5, depth: 1 },
      { minX: 3, maxX: 3.5, minY: 3, maxY: 3.5, depth: 6 },
    ]);

    const features = extractAdaptiveDepthFeatures(noisy, request());

    expect(features.red).toBeDefined();
    expect(features.red[0]!.boundsMm.maxX).toBeLessThan(0);
    expect(features.evidence.red[0]?.componentCount).toBe(1);
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
    expect(boundsOverlap(features.red[0]!.boundsMm, holeBounds)).toBe(false);
    expect(features.blue[0]!.boundsMm.minX).toBeGreaterThan(holeBounds.maxX);
  });

  it('retains a surviving role without an unreliable-geometry warning', () => {
    const redCut = [[-5.5, -5.5], [-1.5, -5.5], [-1.5, 5.5], [-5.5, 5.5]] as const;
    const blueCut = [[1.5, -5.5], [5.5, -5.5], [5.5, 5.5], [1.5, 5.5]] as const;
    const surface = patchedSurface([
      { minX: -5, maxX: -2, minY: -5, maxY: 5, depth: 5 },
      { minX: 2, maxX: 5, minY: -5, maxY: 5, depth: 1 },
    ]);

    const redOnly = extractAdaptiveDepthFeatures(surface, request({ protectedCuts: [blueCut] }));
    const blueOnly = extractAdaptiveDepthFeatures(surface, request({ protectedCuts: [redCut] }));
    const none = extractAdaptiveDepthFeatures(surface, request({ protectedCuts: [redCut, blueCut] }));

    expect(redOnly).toMatchObject({ warning: undefined, omissionCode: undefined });
    expect(redOnly.red).not.toEqual([]);
    expect(redOnly.blue).toEqual([]);
    expect(blueOnly).toMatchObject({ warning: undefined, omissionCode: undefined });
    expect(blueOnly.red).toEqual([]);
    expect(blueOnly.blue).not.toEqual([]);
    expect(none).toMatchObject({
      red: [], blue: [], warning: '雕刻特徵不可靠，已局部省略', omissionCode: 'UNRELIABLE_DEPTH_GEOMETRY',
    });
  });

  it('fails closed before raster work when protected cuts exceed their bounded aggregate', () => {
    const cut = [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const;

    expect(() => extractAdaptiveDepthFeatures(steppedSurface(), request({
      protectedCuts: Array.from({ length: 9 }, () => cut),
    }))).toThrow(/protected cut.*budget/i);
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
      red: [],
      blue: [],
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
