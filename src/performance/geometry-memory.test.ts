import { describe, expect, it } from 'vitest';
import {
  GeometryLiveByteTracker,
  measureGeometryLiveBytes,
} from './geometry-memory';
import { GEOMETRY_PREVIEW_LIMITS } from '../domain/pipeline/automatic-outline-pipeline';

describe('geometry live-memory contract', () => {
  it('counts aliases of one actually owned buffer once and keeps preview evidence bounded', () => {
    const shared = new ArrayBuffer(96);
    const positions = new Float32Array(shared, 0, 12);
    const indices = new Uint32Array(shared, 48, 6);
    const previewPositions = new Float32Array(18_000);
    const previewIndices = new Uint32Array(6_000);

    expect(measureGeometryLiveBytes('preview-retained', [
      { owner: 'parsed-mesh', buffers: [positions] },
      { owner: 'parsed-mesh', buffers: [indices] },
      { owner: 'preview', buffers: [previewPositions, previewIndices] },
    ])).toEqual({
      stage: 'preview-retained',
      totalBytes: 96_096,
      owners: { 'parsed-mesh': 96, preview: 96_000 },
    });
    expect(previewIndices.length / 3).toBeLessThanOrEqual(GEOMETRY_PREVIEW_LIMITS.maxTriangles);
    expect(previewPositions.length / 3).toBeLessThanOrEqual(GEOMETRY_PREVIEW_LIMITS.maxVertices);
  });

  it('counts normal positions and indices buffers as distinct parts of one mesh owner', () => {
    const positions = new Float32Array(3_000_000);
    const indices = new Uint32Array(3_000_000);

    expect(measureGeometryLiveBytes('mesh-parsed', [
      { owner: 'parsed-mesh', buffers: [positions, indices] },
    ])).toEqual({
      stage: 'mesh-parsed',
      totalBytes: 24_000_000,
      owners: { 'parsed-mesh': 24_000_000 },
    });
  });

  it('tracks atomic ownership replacement and reports deterministic cleanup', () => {
    const observations: unknown[] = [];
    const tracker = new GeometryLiveByteTracker((observation) => observations.push(observation));
    const stl = new ArrayBuffer(84 + 50);
    const batchPositions = new Float32Array(9);
    const batchIndices = new Uint32Array(3);

    tracker.update('worker-input', [{ owner: 'worker-stl', buffers: [stl] }]);
    tracker.update('batch-transferred', [
      { owner: 'worker-stl', buffers: [] },
      { owner: 'wasm-batch', buffers: [batchPositions, batchIndices] },
    ]);
    tracker.clear('cancelled');

    expect(observations).toEqual([
      { stage: 'worker-input', totalBytes: 134, owners: { 'worker-stl': 134 } },
      { stage: 'batch-transferred', totalBytes: 48, owners: { 'wasm-batch': 48 } },
      { stage: 'cancelled', totalBytes: 0, owners: {} },
    ]);
  });
});
