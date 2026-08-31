import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  disposeSliceKernel,
  loadSliceKernel,
} from './load-slice-kernel';

const request = {
  positions: new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0,
    0, 0, 2,
  ]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
  planes: new Float64Array([0.5, 1]),
  deadlineCheckInterval: 64,
} as const;

afterEach(() => {
  disposeSliceKernel();
  vi.restoreAllMocks();
});

describe('production-compatible browser WASM loader', () => {
  it('loads the Vite WASM asset and returns validated owned segments in Chromium', async () => {
    const kernel = await loadSliceKernel();
    const result = await kernel.sliceLayerBatch(request, () => false);

    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
    expect(result.endpoints).toHaveLength(24);
    expect(result.diagnosticCounters[4]).toBe(6);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('single-flights concurrent loads and explicitly disposes the published adapter', async () => {
    const [first, second] = await Promise.all([loadSliceKernel(), loadSliceKernel()]);
    expect(first).toBe(second);

    disposeSliceKernel();
    await expect(first.sliceLayerBatch(request, () => false)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code: 'DISPOSED',
    });

    const replacement = await loadSliceKernel();
    expect(replacement).not.toBe(first);
    await expect(replacement.sliceLayerBatch(request, () => false)).resolves.toMatchObject({
      version: 1,
    });
  });

  it('sanitizes asset load failures and permits a clean retry', async () => {
    const fetchFailure = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('/Users/private/model.stl'));

    const failure = await loadSliceKernel().catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'SliceKernelError', code: 'LOAD_FAILED' });
    expect((failure as Error).message).toBe('WASM geometry kernel could not be loaded');
    expect((failure as Error).message).not.toContain('/Users/');

    fetchFailure.mockRestore();
    await expect(loadSliceKernel()).resolves.toBeDefined();
  });

  it.each([
    ['CANCELLED', (): boolean => true],
    ['DEADLINE_CHECK_FAILED', (): boolean => { throw new Error('private checkpoint detail'); }],
  ] as const)('maps checkpoint failure to typed non-fallback error %s', async (code, checkpoint) => {
    const kernel = await loadSliceKernel();
    await expect(kernel.sliceLayerBatch(request, checkpoint)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code,
    });
  });
});
