import { describe, expect, it, vi } from 'vitest';
import { writeBinarySTL } from '../mesh/write-stl';
import type { TriangleMesh } from '../mesh/types';
import {
  interpenetratingTetrahedra,
  openTetrahedron,
  tetrahedron,
} from '../../test/mesh-builders';
import {
  AutomaticOutlineError,
  convertAutomatically,
  type AutomaticOutlineProgressStage,
} from './automatic-outline-pipeline';

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
  it('returns exact success for a safe symmetric mesh and preserves complete layer metadata', () => {
    const progress: AutomaticOutlineProgressStage[] = [];

    const result = convertAutomatically(
      { bytes: writeBinarySTL(cylinder(), 'safe') },
      (stage) => progress.push(stage),
    );

    expect(result).toMatchObject({
      mode: 'exact',
      status: 'success',
      repairAccepted: true,
      axis: { source: 'candidate' },
      warnings: [],
    });
    expect(result.layers).toHaveLength(6);
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{32}$/);
    expect(progress).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'packaging']);
  });

  it.each([
    ['open', openTetrahedron()],
    ['non-manifold', nonManifoldTetrahedron()],
    ['self-intersecting', interpenetratingTetrahedra()],
  ])('returns a warning 2.5D outline for a parseable %s mesh', (_label, mesh) => {
    const result = convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') });

    expect(result.mode).toBe('outline-2.5d');
    expect(result.status).toBe('warning');
    expect(result.repairAccepted).toBe(false);
    expect(result.layers.length).toBeGreaterThan(0);
    expect(result.warnings).toContain('已簡化模型');
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
  });

  it('falls back to projection when a safe mesh has an ambiguous exact slice', () => {
    const result = convertAutomatically({ bytes: writeBinarySTL(steppedCylinder(), 'safe') });

    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
    expect(result.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
  });

  it('uses a deterministic shortest-bounds axis with a warning when no candidate is trusted', () => {
    const first = convertAutomatically({ bytes: writeBinarySTL(openTetrahedron(), 'safe') });
    const second = convertAutomatically({ bytes: writeBinarySTL(openTetrahedron(), 'safe') });

    expect(first.axis).toEqual(second.axis);
    expect(first.axis.source).toBe('shortest-bounds');
    expect(first.warnings).toContain('未找到可信旋轉軸，已使用模型最短包圍盒軸');
  });

  it('fails closed with a typed error when no valid projected outline exists', () => {
    const emptyProjection: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]),
      indices: new Uint32Array([0, 1, 2]),
    };

    expect(() => convertAutomatically({ bytes: writeBinarySTL(emptyProjection, 'safe') }))
      .toThrow(expect.objectContaining<Partial<AutomaticOutlineError>>({ code: 'NO_OUTLINE' }));
  });

  it('maps unreadable bytes to a typed invalid STL error', () => {
    expect(() => convertAutomatically({ bytes: new ArrayBuffer(1) }))
      .toThrow(expect.objectContaining<Partial<AutomaticOutlineError>>({ code: 'INVALID_STL' }));
  });

  it('maps raster budget exhaustion to a typed resource limit error', () => {
    const oversized = scaled(openTetrahedron(), 2_000, 40, 2);

    expect(() => convertAutomatically({ bytes: writeBinarySTL(oversized, 'safe') }))
      .toThrow(expect.objectContaining<Partial<AutomaticOutlineError>>({ code: 'RESOURCE_LIMIT' }));
  });

  it('maps extraction deadline exhaustion to a typed time limit error', () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => { now += 10_001; return now; };
    try {
      expect(() => convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .toThrow(expect.objectContaining<Partial<AutomaticOutlineError>>({ code: 'TIME_LIMIT' }));
    } finally {
      Date.now = originalNow;
    }
  });

  it('emits each progress stage at most once even when exact slicing falls back', () => {
    const stages: AutomaticOutlineProgressStage[] = [];
    const onProgress = vi.fn((stage: AutomaticOutlineProgressStage) => stages.push(stage));

    convertAutomatically({ bytes: writeBinarySTL(openTetrahedron(), 'safe') }, onProgress);

    expect(stages).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'packaging']);
    expect(new Set(stages).size).toBe(stages.length);
  });
});
