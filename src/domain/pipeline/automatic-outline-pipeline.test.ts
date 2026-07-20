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
  convertAutomatically,
  removalEvidenceFingerprint,
  type AutomaticOutlineProgressStage,
} from './automatic-outline-pipeline';
import * as extraction from '../outline-2.5d/extract';

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

describe('automatic outline pipeline', () => {
  it('returns exact success for a safe symmetric mesh and preserves complete layer metadata', async () => {
    const progress: AutomaticOutlineProgressStage[] = [];

    const result = await convertAutomatically(
      { bytes: writeBinarySTL(cylinder(), 'safe') },
      (stage) => { progress.push(stage); },
    );

    expect(result).toMatchObject({
      mode: 'exact',
      status: 'success',
      repairAccepted: true,
      axis: { source: 'candidate' },
      warnings: [],
    });
    expect(result.layers).toHaveLength(6);
    expect(result.removedComponentCount).toBe(0);
    expect(result.layers.every((layer) => layer.removedComponentCount === 0)).toBe(true);
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{32}$/);
    expect(progress).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'packaging']);
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
    const conversion = convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }, async (stage) => {
      if (stage === 'packaging') {
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

    await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }, async (stage) => {
      if (stage === 'packaging') throw callbackError;
    })).rejects.toBe(callbackError);
  });

  it('emits each progress stage at most once even when exact slicing falls back', async () => {
    const stages: AutomaticOutlineProgressStage[] = [];
    const onProgress = vi.fn((stage: AutomaticOutlineProgressStage) => { stages.push(stage); });

    await convertAutomatically({ bytes: writeBinarySTL(scaled(openTetrahedron(), 20, 20, 20), 'safe') }, onProgress);

    expect(stages).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'packaging']);
    expect(new Set(stages).size).toBe(stages.length);
  });
});
