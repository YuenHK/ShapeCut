import { describe, expect, it, vi } from 'vitest';
import { writeBinarySTL } from '../mesh/write-stl';
import type { TriangleMesh } from '../mesh/types';
import {
  interpenetratingTetrahedra,
  openTetrahedron,
  separatedClosedCylinders,
  tetrahedron,
} from '../../test/mesh-builders';
import {
  AutomaticOutlineError,
  convertAutomatically as convertAutomaticOutline,
  removalEvidenceFingerprint,
  type AutomaticOutlineProgressEvent,
  type AutomaticOutlineProgressStage,
} from './automatic-outline-pipeline';
import * as extraction from '../outline-2.5d/extract';
import { createOutlineAxisBasis } from '../outline-2.5d/raster';
import * as simplification from '../outline-2.5d/simplify';
import { MAX_STL_BYTES } from '../mesh/parse-stl';
import type { OutlinePreviewPayload } from '../outline-features/types';

const testMaterial = { id: 'test-material', name: 'Test material', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
function convertAutomatically(request: { readonly bytes: ArrayBuffer }, onProgress?: Parameters<typeof convertAutomaticOutline>[1]) {
  return convertAutomaticOutline({ ...request, material: testMaterial }, onProgress);
}

function cylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -1, 0, 0, 1];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(5 * Math.cos(angle), 5 * Math.sin(angle), -1);
    positions.push(5 * Math.cos(angle), 5 * Math.sin(angle), 1);
  }
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = 2 + index * 2, top = bottom + 1;
    const nextBottom = 2 + next * 2, nextTop = nextBottom + 1;
    indices.push(0, bottom, nextBottom, 1, nextTop, top);
    indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function steppedCylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -3, 0, 0, 3];
  const rings = [
    { radius: 5, z: -3 },
    { radius: 5, z: 0.5 },
    { radius: 3, z: 0.5 },
    { radius: 3, z: 3 },
  ];
  for (const ring of rings) for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(ring.radius * Math.cos(angle), ring.radius * Math.sin(angle), ring.z);
  }
  const ringIndex = (ring: number, index: number) => 2 + ring * segments + index;
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = ringIndex(0, index), nextBottom = ringIndex(0, next);
    const outer = ringIndex(1, index), nextOuter = ringIndex(1, next);
    const inner = ringIndex(2, index), nextInner = ringIndex(2, next);
    const top = ringIndex(3, index), nextTop = ringIndex(3, next);
    indices.push(0, bottom, nextBottom);
    indices.push(bottom, outer, nextOuter, bottom, nextOuter, nextBottom);
    indices.push(outer, inner, nextOuter, nextOuter, inner, nextInner);
    indices.push(inner, top, nextTop, inner, nextTop, nextInner);
    indices.push(1, nextTop, top);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function layerLocalSteppedPrism(): TriangleMesh {
  const profile = [
    [-5, -3], [5, -3], [5, 0.55], [0, 0.55], [0, 0.8], [-5, 0.8],
  ] as const;
  const positions: number[] = [];
  for (const y of [-5, 5]) for (const [x, z] of profile) positions.push(x, y, z);
  const indices: number[] = [];
  const frontFaces = [[0, 1, 2], [0, 2, 3], [0, 3, 5], [3, 4, 5]] as const;
  for (const [a, b, c] of frontFaces) {
    indices.push(a, b, c);
    indices.push(6 + a, 6 + c, 6 + b);
  }
  for (let edge = 0; edge < profile.length; edge += 1) {
    const next = (edge + 1) % profile.length;
    indices.push(edge, 6 + edge, 6 + next, edge, 6 + next, next);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function squareTube(outerSize = 20, innerSize = 4, depth = 2): TriangleMesh {
  const positions: number[] = [];
  for (const [size, z] of [[outerSize, -depth / 2], [outerSize, depth / 2], [innerSize, -depth / 2], [innerSize, depth / 2]]) {
    const half = size / 2;
    positions.push(-half, -half, z, half, -half, z, half, half, z, -half, half, z);
  }
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
  for (let edge = 0; edge < 4; edge += 1) {
    const next = (edge + 1) % 4;
    quad(edge, next, 4 + next, 4 + edge);
    quad(8 + next, 8 + edge, 12 + edge, 12 + next);
    quad(4 + edge, 4 + next, 12 + next, 12 + edge);
    quad(8 + edge, 8 + next, next, edge);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function nonManifoldTetrahedron(): TriangleMesh {
  const base = tetrahedron();
  return {
    positions: new Float64Array([...base.positions, 0.5, 0, 0.5]),
    indices: new Uint32Array([...base.indices, 0, 1, 4]),
  };
}

function scaled(mesh: TriangleMesh, x: number, y: number, z: number): TriangleMesh {
  return {
    positions: new Float64Array(Array.from(mesh.positions, (value, index) => (
      value * (index % 3 === 0 ? x : index % 3 === 1 ? y : z)
    ))),
    indices: mesh.indices.slice(),
  };
}

function translated(mesh: TriangleMesh, x: number, y: number, z: number): TriangleMesh {
  return {
    positions: new Float64Array(Array.from(mesh.positions, (value, index) => (
      value + (index % 3 === 0 ? x : index % 3 === 1 ? y : z)
    ))),
    indices: mesh.indices.slice(),
  };
}

describe('automatic outline pipeline', () => {
  it('publishes both layer-local depth roles through preview and fingerprint evidence', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(layerLocalSteppedPrism(), 'safe') });
    const featured = result.coloredLayers.filter((layer) => layer.deepFeature && layer.lightFeature);

    expect(featured.length).toBeGreaterThan(0);
    expect(featured.every((layer) => layer.deepFeature?.role === 'DEEP_RED')).toBe(true);
    expect(featured.every((layer) => layer.lightFeature?.role === 'LIGHT_BLUE')).toBe(true);
    expect(featured.every((layer) => (
      layer.diagnostics.depth.redThresholdMm > layer.diagnostics.depth.blueThresholdMm
      && layer.diagnostics.depth.redThresholdMm <= layer.zEnd - layer.zStart + 1e-9
    ))).toBe(true);
    expect(result.preview.layers).toEqual(result.coloredLayers);
    const expectedBasis = createOutlineAxisBasis(result.axis.axis);
    expect(result.preview.axis).toEqual({
      origin: result.axis.axis.origin,
      direction: result.axis.axis.direction,
      planeX: expectedBasis.planeX,
      planeY: expectedBasis.planeY,
    });
    expect(result.featureEvidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('bounds every stepped-mesh depth sample to its own layer slab', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(steppedCylinder(), 'safe') });

    expect(result.coloredLayers.every((layer) => (
      layer.diagnostics.depth.redThresholdMm <= layer.zEnd - layer.zStart + 1e-9
      && layer.diagnostics.depth.blueThresholdMm <= layer.zEnd - layer.zStart + 1e-9
    ))).toBe(true);
    expect(result.coloredLayers.every((layer) => (
      !layer.deepFeature || layer.deepFeature.role === 'DEEP_RED'
    ))).toBe(true);
    expect(result.coloredLayers.every((layer) => (
      !layer.lightFeature || layer.lightFeature.role === 'LIGHT_BLUE'
    ))).toBe(true);
    expect(result.featureEvidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('locally omits flat depth bands with a sanitized contrast warning and fingerprinted omission code', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });

    expect(result.coloredLayers.every((layer) => !layer.deepFeature && !layer.lightFeature)).toBe(true);
    expect(result.coloredLayers.every((layer) => (
      layer.diagnostics.depth.omissionCode === 'INSUFFICIENT_CONTRAST'
    ))).toBe(true);
    expect(result.featureWarnings).toContain('表面深度差不足，已省略雕刻特徵');
    expect(result.featureWarnings.join('\n')).not.toMatch(/[\\/@]|[\w.+-]+@[\w.-]+/);
  });

  it('publishes a retained exact hole through colored layers, preview, diagnostics, and fingerprint evidence', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(squareTube(), 'safe') });

    expect(result.mode).toBe('exact');
    expect(result.featureWarnings).toEqual(['表面深度差不足，已省略雕刻特徵']);
    expect(result.coloredLayers).toHaveLength(result.layers.length);
    expect(result.coloredLayers.every((layer) => layer.centralHole?.role === 'CUT_BLACK')).toBe(true);
    expect(result.coloredLayers.every((layer) => layer.diagnostics.hole.status === 'retained')).toBe(true);
    const holes = result.coloredLayers.map((layer) => layer.centralHole?.outer);
    expect(holes.every((hole) => hole !== undefined)).toBe(true);
    for (const hole of holes.slice(1)) expect(hole).toEqual(holes[0]);
    expect(result.preview.layers).toEqual(result.coloredLayers);
    expect(result.featureEvidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('publishes one sanitized feature warning when otherwise-valid layers have no reliable hole', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });

    expect(result.status).toBe('warning');
    expect(result.coloredLayers.every((layer) => layer.centralHole === undefined)).toBe(true);
    expect(result.featureWarnings).toEqual([
      'No reliable central axle hole was found; the hole was omitted.',
      '表面深度差不足，已省略雕刻特徵',
    ]);
    expect(result.featureWarnings[0]).not.toMatch(/[\\/@]|[\w.+-]+@[\w.-]+/);
  });

  it('returns an exact outline for a safe symmetric mesh and preserves complete layer metadata', async () => {
    const progress: AutomaticOutlineProgressEvent[] = [];

    const result = await convertAutomatically(
      { bytes: writeBinarySTL(cylinder(), 'safe') },
      (event) => { progress.push(event); },
    );

    expect(result).toMatchObject({
      mode: 'exact',
      status: 'warning',
      repairAccepted: true,
      axis: { source: 'candidate' },
      warnings: [],
    });
    expect(result.layers).toHaveLength(6);
    expect(result.removedComponentCount).toBe(0);
    expect(result.layers.every((layer) => layer.removedComponentCount === 0)).toBe(true);
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.diagnostics).toMatchObject({ repairDecision: 'accepted', rasterCellSizeMm: null, topology: { triangleCount: 128 } });
    expect(result.diagnostics.layers).toHaveLength(result.layers.length);
    expect(progress.map(({ stage }) => stage)).toEqual([
      'reading', 'analyzing', 'simplifying', 'slicing', 'slicing', 'packaging',
    ]);
    const analyzing = progress.find((event) => event.stage === 'analyzing' && 'preview' in event);
    const slicing = progress.find((event) => event.stage === 'slicing' && 'preview' in event);
    expect(analyzing).toMatchObject({ stage: 'analyzing', preview: { layers: [] } });
    expect(slicing).toMatchObject({ stage: 'slicing', preview: { layers: result.coloredLayers } });
    if (analyzing && 'preview' in analyzing) {
      expect(analyzing.preview.mesh.indices.length).toBeLessThanOrEqual(6_000);
      expect(analyzing.preview.mesh.positions.buffer).not.toBe(result.preview.mesh.positions.buffer);
    }
    if (slicing && 'preview' in slicing) {
      expect(slicing.preview.mesh.positions.buffer).not.toBe(result.preview.mesh.positions.buffer);
      expect(slicing.preview.mesh.indices.buffer).not.toBe(result.preview.mesh.indices.buffer);
    }
  });

  it('samples a bounded analyzing preview across the whole mesh and centers its provisional axis', async () => {
    const stop = new Error('preview captured');
    let analyzing: OutlinePreviewPayload | undefined;
    const mesh = translated(cylinder(2_001), 10_000, -20_000, 30_000);

    await expect(convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') }, (event) => {
      if (event.stage === 'analyzing' && 'preview' in event) {
        analyzing = event.preview;
        throw stop;
      }
    })).rejects.toBe(stop);

    expect(analyzing).toBeDefined();
    if (!analyzing) return;
    const xs = Array.from(analyzing.mesh.positions).filter((_, index) => index % 3 === 0);
    expect(analyzing.mesh.indices).toHaveLength(6_000);
    expect(Math.min(...xs)).toBeLessThan(9_996);
    expect(Math.max(...xs)).toBeGreaterThan(10_004);
    expect(analyzing.axis.origin[0]).toBeCloseTo(10_000, 2);
    expect(analyzing.axis.origin[1]).toBeCloseTo(-20_000, 2);
    expect(analyzing.axis.origin[2]).toBeCloseTo(30_000, 2);
  });

  it.each([
    ['open', scaled(openTetrahedron(), 20, 20, 20)],
    ['non-manifold', scaled(nonManifoldTetrahedron(), 20, 20, 20)],
    ['self-intersecting', scaled(interpenetratingTetrahedra(), 20, 20, 20)],
  ])('returns a warning 2.5D outline for a parseable %s mesh', async (_label, mesh) => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') });

    expect(result.mode).toBe('outline-2.5d');
    expect(result.status).toBe('warning');
    expect(result.repairAccepted).toBe(false);
    expect(result.layers.length).toBeGreaterThan(0);
    expect(result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(result.removedComponentCount);
    expect(result.warnings).toContain('已簡化模型');
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
  });

  it('falls back to projection when a safe mesh has an ambiguous exact slice', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(steppedCylinder(), 'safe') });

    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
    expect(result.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
    expect(result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(result.removedComponentCount);
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
  });

  it('falls back to projection with authentic removal evidence for disconnected closed slices', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(), 'safe') });

    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
    expect(result.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
    expect(result.removedComponentCount).toBeGreaterThan(0);
    expect(result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(result.removedComponentCount);
    expect(result.removalEvidenceFingerprint).toBe(removalEvidenceFingerprint(result));
    expect(result.diagnostics.rasterCellSizeMm).toBeGreaterThan(0);
    expect(result.diagnostics.layers.every((item) => item.boundsDriftRatio <= 0.03 && item.areaDriftRatio <= 0.03)).toBe(true);
  });

  it('uses a deterministic shortest-bounds axis with a warning when no candidate is trusted', async () => {
    const input = writeBinarySTL(scaled(openTetrahedron(), 20, 20, 20), 'safe');
    const first = await convertAutomatically({ bytes: input });
    const second = await convertAutomatically({ bytes: input.slice(0) });

    expect(first.axis).toEqual(second.axis);
    expect(first.axis.source).toBe('shortest-bounds');
    expect(first.warnings).toContain('未找到可信旋轉軸，已使用模型最短包圍盒軸');
  });

  it('fails closed with a typed error when no valid projected outline exists', async () => {
    const emptyProjection: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]),
      indices: new Uint32Array([0, 1, 2]),
    };

    await expect(convertAutomatically({ bytes: writeBinarySTL(emptyProjection, 'safe') }))
      .rejects.toMatchObject({ code: 'NO_OUTLINE' } satisfies Partial<AutomaticOutlineError>);
  });

  it('maps unreadable bytes to a typed invalid STL error', async () => {
    await expect(convertAutomatically({ bytes: new ArrayBuffer(1) }))
      .rejects.toMatchObject({ code: 'INVALID_STL' } satisfies Partial<AutomaticOutlineError>);
  });

  it('fails closed before publishing a preview when finite ASCII coordinates overflow Float32', async () => {
    const source = `solid overflow
facet normal 0 0 1
outer loop
vertex 1e39 0 0
vertex 1e39 1 0
vertex 1e39 0 1
endloop
endfacet
endsolid overflow`;
    const events: AutomaticOutlineProgressEvent[] = [];

    await expect(convertAutomatically(
      { bytes: new TextEncoder().encode(source).buffer as ArrayBuffer },
      (event) => { events.push(event); },
    )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);

    expect(events).toEqual([{ stage: 'reading' }]);
    expect(events.some((event) => 'preview' in event)).toBe(false);
  });

  it('rejects oversized bytes before progress, hashing, or parsing work', async () => {
    const onProgress = vi.fn();
    const forged = { byteLength: MAX_STL_BYTES + 1 } as ArrayBuffer;
    await expect(convertAutomatically({ bytes: forged }, onProgress))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('maps raster budget exhaustion to a typed resource limit error', async () => {
    const oversized = scaled(openTetrahedron(), 2_000, 40, 2);

    await expect(convertAutomatically({ bytes: writeBinarySTL(oversized, 'safe') }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);
  });

  it('does not reset the overall deadline when exact extraction times out', async () => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => calls++ === 0 ? 0 : 30_001;
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'TIME_LIMIT' } satisfies Partial<AutomaticOutlineError>);
    } finally {
      Date.now = originalNow;
    }
  });

  it('maps deadline expiry during the first bounded preview copy to a typed time limit', async () => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => calls++ < 2 ? 0 : 30_001;
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'TIME_LIMIT' } satisfies Partial<AutomaticOutlineError>);
    } finally {
      Date.now = originalNow;
    }
  });

  it('rejects when the shared deadline expires before preview preparation', async () => {
    const originalNow = Date.now;
    const contourBounds = vi.spyOn(simplification, 'contourBounds');
    let now = 0;
    let callsAtPackaging = -1;
    Date.now = () => now;
    try {
      await expect(convertAutomatically(
        { bytes: writeBinarySTL(cylinder(), 'safe') },
        (event) => {
          if (event.stage === 'packaging') {
            callsAtPackaging = contourBounds.mock.calls.length;
            now = 30_001;
          }
        },
      )).rejects.toMatchObject({ code: 'TIME_LIMIT' } satisfies Partial<AutomaticOutlineError>);
      expect(callsAtPackaging).toBeGreaterThanOrEqual(0);
      expect(contourBounds).toHaveBeenCalledTimes(callsAtPackaging);
    } finally {
      Date.now = originalNow;
      contourBounds.mockRestore();
    }
  });

  it('does not project after exact extraction exhausts a resource limit', async () => {
    const exact = vi.spyOn(extraction, 'extractExactContours')
      .mockImplementationOnce(() => { throw new RangeError('Exact contour exceeds the triangle-layer test budget'); });
    const projected = vi.spyOn(extraction, 'extractProjectedContours');
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);
      expect(projected).not.toHaveBeenCalled();
    } finally {
      exact.mockRestore();
      projected.mockRestore();
    }
  });

  it('awaits packaging progress before resolving', async () => {
    let releasePackaging!: () => void;
    let markPackagingStarted!: () => void;
    const packagingDelivered = new Promise<void>((resolve) => { releasePackaging = resolve; });
    const packagingStarted = new Promise<void>((resolve) => { markPackagingStarted = resolve; });
    let settled = false;
    const conversion = convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }, async (event) => {
      if (event.stage === 'packaging') {
        markPackagingStarted();
        await packagingDelivered;
      }
    });
    const completion = Promise.resolve(conversion);
    void completion.finally(() => { settled = true; });

    await packagingStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releasePackaging();
    await expect(completion).resolves.toMatchObject({ mode: 'exact' });
  });

  it('fails closed when progress delivery rejects', async () => {
    const callbackError = new Error('progress receiver closed');

    await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }, async (event) => {
      if (event.stage === 'packaging') throw callbackError;
    })).rejects.toBe(callbackError);
  });

  it('keeps progress monotonic and emits one bounded preview per supported stage during fallback', async () => {
    const events: AutomaticOutlineProgressEvent[] = [];
    const onProgress = vi.fn((event: AutomaticOutlineProgressEvent) => { events.push(event); });

    await convertAutomatically({ bytes: writeBinarySTL(scaled(openTetrahedron(), 20, 20, 20), 'safe') }, onProgress);

    const stages = events.map(({ stage }) => stage);
    expect(stages).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'slicing', 'packaging']);
    const stageOrder: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
    expect(stages.every((stage, index) => index === 0
      || stageOrder.indexOf(stage) >= stageOrder.indexOf(stages[index - 1]))).toBe(true);
    expect(events.filter((event) => 'preview' in event).map(({ stage }) => stage)).toEqual(['analyzing', 'slicing']);
  });
});
