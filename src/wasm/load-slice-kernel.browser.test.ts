import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  disposeSliceKernel,
  loadSliceKernel,
} from './load-slice-kernel';
import { CanonicalFallbackGuard } from './slice-kernel-contract';

const requestTemplate = {
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

function createRequest(): {
  positions: Float32Array;
  indices: Uint32Array;
  planes: Float64Array;
  deadlineCheckInterval: number;
} {
  return {
    positions: requestTemplate.positions.slice(),
    indices: requestTemplate.indices.slice(),
    planes: requestTemplate.planes.slice(),
    deadlineCheckInterval: requestTemplate.deadlineCheckInterval,
  };
}

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

const hostileRequestRecordCases = [
  ['revoked proxy', () => {
    const pair = Proxy.revocable(createRequest(), {});
    pair.revoke();
    return pair.proxy;
  }],
  ['throwing prototype trap', () => new Proxy(createRequest(), {
    getPrototypeOf: () => { throw new Error('private request prototype detail'); },
  })],
  ['throwing ownKeys trap', () => new Proxy(createRequest(), {
    ownKeys: () => { throw new Error('private request ownKeys detail'); },
  })],
  ['throwing descriptor trap', () => new Proxy(createRequest(), {
    getOwnPropertyDescriptor: () => { throw new Error('private request descriptor detail'); },
  })],
] as const;

function withThrowingOwnProperty<T extends object>(target: T, key: PropertyKey): T {
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => { throw new Error(`private ${String(key)} detail`); },
  });
  return target;
}

function detachedFloat32Array(): Float32Array {
  const view = new Float32Array([0, 0, 0]);
  structuredClone(view.buffer, { transfer: [view.buffer] });
  return view;
}

function expectFallbackDenied(error: unknown): void {
  expect(() => new CanonicalFallbackGuard().claimTypeScriptFallback(error)).toThrowError(
    expect.objectContaining({ name: 'SliceKernelError', code: 'FALLBACK_NOT_ALLOWED' }),
  );
}

afterEach(() => {
  disposeSliceKernel();
  vi.restoreAllMocks();
});

describe('production-compatible browser WASM loader', () => {
  it('loads the Vite WASM asset and returns validated owned segments in Chromium', async () => {
    const kernel = await loadSliceKernel();
    const result = await kernel.sliceLayerBatch(createRequest(), () => undefined);

    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
    expect(result.endpoints).toHaveLength(24);
    expect(result.diagnosticCounters.at(4)).toBe(6);
    expect(Object.isFrozen(result)).toBe(true);
    const publicOffsets = result.planeOffsets as unknown as Uint32Array;
    expect(() => { publicOffsets[0] = 99; }).toThrow(TypeError);
    expect(() => publicOffsets.set(new Uint32Array([99]))).toThrow(TypeError);
    expect(() => publicOffsets.fill(99)).toThrow(TypeError);
    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
    expect(Reflect.ownKeys(result.endpoints).sort()).toEqual([
      'byteLength',
      'elementType',
      'length',
    ]);
    expect(result.endpoints.at(1.9)).toBe(result.endpoints.at(1));
    expect(result.endpoints.at(Number.NaN)).toBe(result.endpoints.at(0));
    expect(result.endpoints.at(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('single-flights concurrent loads and explicitly disposes the published adapter', async () => {
    const [first, second] = await Promise.all([loadSliceKernel(), loadSliceKernel()]);
    expect(first).toBe(second);

    disposeSliceKernel();
    await expect(first.sliceLayerBatch(createRequest(), () => undefined)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code: 'DISPOSED',
    });

    const replacement = await loadSliceKernel();
    expect(replacement).not.toBe(first);
    await expect(replacement.sliceLayerBatch(createRequest(), () => undefined)).resolves.toMatchObject({
      version: 1,
    });
  });

  it('instance disposal clears the matching loader cache', async () => {
    const first = await loadSliceKernel();
    first.dispose();

    const replacement = await loadSliceKernel();
    expect(replacement).not.toBe(first);
    await expect(first.sliceLayerBatch(createRequest(), () => undefined)).rejects.toMatchObject({
      name: 'SliceKernelError',
      code: 'DISPOSED',
    });
    await expect(replacement.sliceLayerBatch(createRequest(), () => undefined)).resolves.toMatchObject({
      version: 1,
    });
  });

  it('rejects a late result when dispose is reentered from the controlled checkpoint', async () => {
    const kernel = await loadSliceKernel();
    let checkpointCount = 0;

    await expect(kernel.sliceLayerBatch(createRequest(), () => {
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
    expect(new CanonicalFallbackGuard().claimTypeScriptFallback(failure)).toBeDefined();

    fetchFailure.mockRestore();
    await expect(loadSliceKernel()).resolves.toBeDefined();
  });

  it.each([
    ['CANCELLED', () => ({ reason: 'cancelled', source: 'user' } as const)],
    ['DEADLINE_CHECK_FAILED', (): undefined => { throw new Error('private checkpoint detail'); }],
  ] as const)('maps checkpoint failure to typed non-fallback error %s', async (code, checkpoint) => {
    const kernel = await loadSliceKernel();
    await expect(kernel.sliceLayerBatch(createRequest(), checkpoint)).rejects.toMatchObject({
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
      await expect(kernel.sliceLayerBatch(createRequest(), () => abort)).rejects.toMatchObject({
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
      await expect(kernel.sliceLayerBatch(createRequest(), () => {
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
      const error = await kernel.sliceLayerBatch(createRequest(), () => createAbort() as never)
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
      const error = await kernel.sliceLayerBatch(createRequest(), () => {
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

  it.each(hostileRequestRecordCases)(
    'fails closed for production request %s with INVALID_REQUEST and no fallback',
    async (_name, createRequest) => {
      const kernel = await loadSliceKernel();
      const error = await kernel.sliceLayerBatch(createRequest() as never, () => undefined)
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'SliceKernelError', code: 'INVALID_REQUEST' });
      expectFallbackDenied(error);
    },
  );

  it('uses production request descriptor snapshots without invoking an ordinary get trap', async () => {
    const kernel = await loadSliceKernel();
    const requestProxy = new Proxy(createRequest(), {
      get: () => { throw new Error('ordinary production request get must not run'); },
    });
    await expect(kernel.sliceLayerBatch(requestProxy, () => undefined)).resolves.toMatchObject({
      version: 1,
    });
  });

  it.each([
    ['Proxy-wrapped', () => new Proxy(new Float32Array([0, 0, 0]), {})],
    ['own constructor', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'constructor')],
    ['own buffer', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'buffer')],
    ['own length', () => withThrowingOwnProperty(new Float32Array([0, 0, 0]), 'length')],
    ['detached', detachedFloat32Array],
    ['non-zero offset', () => new Float32Array(new ArrayBuffer(16), 4, 3)],
    ['partial backing buffer', () => new Float32Array(new ArrayBuffer(16), 0, 3)],
  ] as const)(
    'rejects production %s request typed array with INVALID_REQUEST and no fallback',
    async (_name, createPositions) => {
      const kernel = await loadSliceKernel();
      const error = await kernel.sliceLayerBatch(
        { ...createRequest(), positions: createPositions() as Float32Array },
        () => undefined,
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'SliceKernelError', code: 'INVALID_REQUEST' });
      expectFallbackDenied(error);
    },
  );

  it('detaches all production request buffers before the first checkpoint', async () => {
    const kernel = await loadSliceKernel();
    const source = createRequest();
    let checkpointCount = 0;
    const result = await kernel.sliceLayerBatch(source, () => {
      checkpointCount += 1;
      expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
        .toEqual([0, 0, 0]);
      try { source.positions[0] = Number.NaN; } catch { /* detached writes may throw */ }
      try { source.indices[0] = 999; } catch { /* detached writes may throw */ }
      try { source.planes[0] = Number.NaN; } catch { /* detached writes may throw */ }
      return undefined;
    });
    expect(checkpointCount).toBeGreaterThan(0);
    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
  });

  it('rejects a production resizable request buffer without permitting fallback', async () => {
    const kernel = await loadSliceKernel();
    const ResizableArrayBuffer = ArrayBuffer as unknown as {
      new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer;
    };
    const positions = new Float32Array(new ResizableArrayBuffer(
      requestTemplate.positions.byteLength,
      { maxByteLength: requestTemplate.positions.byteLength + Float32Array.BYTES_PER_ELEMENT },
    ));
    positions.set(requestTemplate.positions);
    const error = await kernel.sliceLayerBatch({ ...createRequest(), positions }, () => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'SliceKernelError', code: 'INVALID_REQUEST' });
    expectFallbackDenied(error);
  });

  it('keeps production values private across delayed caller mutation attempts', async () => {
    const kernel = await loadSliceKernel();
    const source = createRequest();
    let checkpointCount = 0;
    const result = await kernel.sliceLayerBatch(source, () => {
      checkpointCount += 1;
      if (checkpointCount === 14) {
        try { source.positions[0] = Number.NaN; } catch { /* detached writes may throw */ }
        try { source.indices[0] = 999; } catch { /* detached writes may throw */ }
        try { source.planes[0] = Number.NaN; } catch { /* detached writes may throw */ }
      }
      return undefined;
    });
    expect(checkpointCount).toBeGreaterThanOrEqual(14);
    expect([source.positions, source.indices, source.planes].map((view) => view.byteLength))
      .toEqual([0, 0, 0]);
    expect(Array.from(result.planeOffsets)).toEqual([0, 3, 6]);
  });
});
