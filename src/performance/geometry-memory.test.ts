import { describe, expect, it } from 'vitest';
import {
  estimateGeometryLiveBytes,
} from './geometry-memory';
import { GEOMETRY_PREVIEW_LIMITS } from '../domain/pipeline/automatic-outline-pipeline';

describe('geometry live-memory contract', () => {
  it('counts each owned buffer once and keeps preview evidence bounded', () => {
    const shared = new ArrayBuffer(96);
    const positions = new Float32Array(shared, 0, 12);
    const indices = new Uint32Array(shared, 48, 6);
    const previewPositions = new Float32Array(18_000);
    const previewIndices = new Uint32Array(6_000);

    expect(estimateGeometryLiveBytes({ positions, indices, previewPositions, previewIndices }))
      .toEqual({ meshBytes: 96, previewBytes: 96_000, totalBytes: 96_096 });
    expect(previewIndices.length / 3).toBeLessThanOrEqual(GEOMETRY_PREVIEW_LIMITS.maxTriangles);
    expect(previewPositions.length / 3).toBeLessThanOrEqual(GEOMETRY_PREVIEW_LIMITS.maxVertices);
  });

  it('rejects duplicate full-mesh ownership when positions and indices use different full-span buffers', () => {
    expect(() => estimateGeometryLiveBytes({
      positions: new Float32Array(3_000_000),
      indices: new Uint32Array(3_000_000),
    }, { maximumOwnedFullMeshBuffers: 1 })).toThrow(/duplicate full-mesh buffers/i);
  });
});
