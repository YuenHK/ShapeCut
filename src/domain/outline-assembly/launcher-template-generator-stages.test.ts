import { describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { TriangleMesh } from '../mesh/types';

const stage = vi.hoisted(() => ({ current: '', inside: false, axialReads: 0, lastAxialReads: 0 }));

vi.mock('../axis/find-axis', () => ({
  findAxisCandidates: () => [{
    origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: false,
    source: 'inertia', radialRmsError: 0, centroidOffset: 0,
  }],
}));

const rectangles: readonly (readonly Point2[])[] = [
  [[9, -0.5], [11, -0.5], [11, 0.5], [9, 0.5]],
  [[-5.5, 8.16], [-3.5, 8.16], [-3.5, 9.16], [-5.5, 9.16]],
  [[-5.5, -9.16], [-3.5, -9.16], [-3.5, -8.16], [-5.5, -8.16]],
];

vi.mock('../outline-2.5d/raster', () => ({
  projectMesh: () => {
    const source = stage.current === 'axial'
      ? Array.from({ length: 4_096 }, (_, index) => [index % 2, index % 3, index] as const)
      : [[0, 0, -1], [1, 0, 1], [0, 1, 0]];
    const vertices = new Proxy(source, {
      get(target, property, receiver) {
        if (stage.current === 'axial' && typeof property === 'string' && /^\d+$/.test(property)) {
          stage.axialReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return {
      vertices, triangles: [[0, 1, 2]],
      minX: 0, minY: 0, maxX: 1, maxY: 1, planarDiameter: Math.SQRT2,
    };
  },
  rasterCellSize: () => 0.1,
  rasterProjectLayer: (
    _projected: unknown, _spec: unknown, _budgets: unknown, _deadline: number, checkpoint: () => void,
  ) => {
    if (stage.current === 'raster') {
      stage.inside = true;
      try { checkpoint(); } finally { stage.inside = false; }
    }
    return {
      outer: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
      occupiedCellCount: 1_000, componentCount: 1,
      enclosedVoids: rectangles.map((outer) => ({ outer, occupiedCellCount: 100 })),
      sourceBoundsMm: { minX: -20, minY: -20, maxX: 20, maxY: 20 }, sourceAreaMm2: 1_600,
    };
  },
}));

vi.mock('../outline-2.5d/simplify', () => ({
  simplifyClosedLoop: (
    points: readonly Point2[], _tolerance: number, _maximum: number, _deadline: number, checkpoint: () => void,
  ) => {
    if (stage.current === 'simplify') {
      stage.inside = true;
      try { checkpoint(); } finally { stage.inside = false; }
    }
    return points;
  },
}));

import { generateLauncherTemplateFromMeshes } from '../../../scripts/launcher-template-generator';

const mesh: TriangleMesh = {
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

describe('launcher generator in-flight cancellation', () => {
  it.each(['raster', 'simplify'] as const)('preserves the caller error from inside %s', (current) => {
    const cancellation = new RangeError(`${current} stage cancelled`);
    stage.current = current;
    let caught: unknown;
    try {
      generateLauncherTemplateFromMeshes([
        { mesh, provenanceHash: 'a'.repeat(64) },
        { mesh, provenanceHash: 'b'.repeat(64) },
      ], {
        deadline: Infinity,
        checkpoint: () => {
          if (stage.inside) throw cancellation;
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      stage.current = '';
    }
    expect(caught).toBe(cancellation);
  });

  it('polls during the late projected axial-value scan with bounded latency', () => {
    const cancellation = new Error('axial scan cancelled');
    stage.current = 'axial';
    stage.axialReads = 0;
    stage.lastAxialReads = 0;
    let caught: unknown;
    try {
      generateLauncherTemplateFromMeshes([
        { mesh, provenanceHash: 'a'.repeat(64) },
        { mesh, provenanceHash: 'b'.repeat(64) },
      ], {
        deadline: Infinity,
        checkpoint: () => {
          const interval = stage.axialReads - stage.lastAxialReads;
          if (interval > 256) throw new Error(`axial checkpoint interval ${interval}`);
          stage.lastAxialReads = stage.axialReads;
          if (stage.axialReads >= 2_048) throw cancellation;
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      stage.current = '';
    }
    expect(caught).toBe(cancellation);
  });
});
