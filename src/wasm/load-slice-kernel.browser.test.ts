import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  disposeSliceKernel,
  loadSliceKernel,
} from './load-slice-kernel';
import { CanonicalFallbackGuard } from './slice-kernel-contract';

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

const maliciousAbortCases = [
  ['revoked proxy', () => {
    const pair = Proxy.revocable({ reason: 'cancelled', source: 'user' }, {});
    pair.revoke();
    return pair.proxy;
  }],
  ['throwing ownKeys trap', () => new Proxy({}, {
    ownKeys: () => { throw new Error('private ownKeys detail'); },
  })],
  ['throwing prototype trap', () => new Proxy({}, {
    getPrototypeOf: () => { throw new Error('private prototype detail'); },
  })],
  ['throwing descriptor trap', () => new Proxy({ reason: 'cancelled', source: 'user' }, {
    getOwnPropertyDescriptor: () => { throw new Error('private descriptor detail'); },
  })],
] as const;

afterEach(() => {
  disposeSliceKernel();
  vi.restoreAllMocks();
});

describe('production-compatible browser WASM loader', () => {
  it('loads the Vite WASM asset and returns validated owned segments in Chromium', async () => {
    const kernel = await loadSliceKernel();
    const result = await kernel.sliceLayerBatch(request, () => undefined);

    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
    expect(result.endpoints).toHaveLength(24);
    expect(result.diagnosticCounters.at(4)).toBe(6);
    expect(Object.isFrozen(result)).toBe(true);
    const publicOffsets = result.planeOffsets as unknown as Uint32Array;
    expect(() => { publicOffsets[0] = 99; }).toThrow(TypeError);
    expect(() => publicOffsets.set(new Uint32Array([99]))).toThrow(TypeError);
    expect(() => publicOffsets.fill(99)).toThrow(TypeError);
    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
  });

  it('single-flights concurrent loads and explicitly disposes the published adapter', async () => {
    const [first, second] = await Promise.all([loadSliceKernel(), loadSliceKernel()]);
    expect(first).toBe(second);

    disposeSliceKernel();
    await expect(first.sliceLayerBatch(request, () => undefined)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code: 'DISPOSED',
    });

    const replacement = await loadSliceKernel();
    expect(replacement).not.toBe(first);
    await expect(replacement.sliceLayerBatch(request, () => undefined)).resolves.toMatchObject({
      version: 1,
    });
  });

  it('instance disposal clears the matching loader cache', async () => {
    const first = await loadSliceKernel();
    first.dispose();

    const replacement = await loadSliceKernel();
    expect(replacement).not.toBe(first);
    await expect(first.sliceLayerBatch(request, () => undefined)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code: 'DISPOSED',
    });
    await expect(replacement.sliceLayerBatch(request, () => undefined)).resolves.toMatchObject({
      version: 1,
    });
  });

  it('rejects a late result when dispose is reentered from the controlled checkpoint', async () => {
    const kernel = await loadSliceKernel();
    let checkpointCount = 0;

    await expect(kernel.sliceLayerBatch(request, () => {
      checkpointCount += 1;
      if (checkpointCount === 5) kernel.dispose();
      return undefined;
    })).rejects.toMatchObject({ name: 'SliceKernelError', code: 'DISPOSED' });
    expect(checkpointCount).toBeGreaterThanOrEqual(5);

    const replacement = await loadSliceKernel();
    expect(replacement).not.toBe(kernel);
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
    ['CANCELLED', () => ({ reason: 'cancelled', source: 'user' } as const)],
    ['DEADLINE_CHECK_FAILED', (): undefined => { throw new Error('private checkpoint detail'); }],
  ] as const)('maps checkpoint failure to typed non-fallback error %s', async (code, checkpoint) => {
    const kernel = await loadSliceKernel();
    await expect(kernel.sliceLayerBatch(request, checkpoint)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code,
    });
  });

  it.each([
    [{ reason: 'cancelled', source: 'user' }, 'CANCELLED'],
    [{ reason: 'deadline', source: 'runtime-deadline' }, 'DEADLINE_EXCEEDED'],
  ] as const)(
    'preserves immediate $0.reason from $0.source as typed error $1',
    async (abort, code) => {
      const kernel = await loadSliceKernel();
      await expect(kernel.sliceLayerBatch(request, () => abort)).rejects.toMatchObject({
        name: 'SliceKernelError',
        code,
        abortSource: abort.source,
      });
    },
  );

  it.each([
    [{ reason: 'cancelled', source: 'user' }, 'CANCELLED'],
    [{ reason: 'deadline', source: 'runtime-deadline' }, 'DEADLINE_EXCEEDED'],
  ] as const)(
    'preserves delayed $0.reason from $0.source across the controlled boundary as typed error $1',
    async (abort, code) => {
      const kernel = await loadSliceKernel();
      let checkpointCount = 0;
      await expect(kernel.sliceLayerBatch(request, () => {
        checkpointCount += 1;
        return checkpointCount === 5 ? abort : undefined;
      })).rejects.toMatchObject({
        name: 'SliceKernelError',
        code,
        abortSource: abort.source,
      });
      expect(checkpointCount).toBe(5);
    },
  );

  it.each(maliciousAbortCases)(
    'fails closed for immediate %s checkpoint reflection and denies fallback',
    async (_name, createAbort) => {
      const kernel = await loadSliceKernel();
      const error = await kernel.sliceLayerBatch(request, () => createAbort() as never)
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'SliceKernelError', code: 'DEADLINE_CHECK_FAILED' });
      expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
        expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
      );
    },
  );

  it.each(maliciousAbortCases)(
    'fails closed for delayed %s checkpoint reflection and denies fallback',
    async (_name, createAbort) => {
      const kernel = await loadSliceKernel();
      let checkpointCount = 0;
      const error = await kernel.sliceLayerBatch(request, () => {
        checkpointCount += 1;
        return checkpointCount === 5 ? createAbort() as never : undefined;
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'SliceKernelError', code: 'DEADLINE_CHECK_FAILED' });
      expect(checkpointCount).toBe(5);
      expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
        expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
      );
    },
  );
});
