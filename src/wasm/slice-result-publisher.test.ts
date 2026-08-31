// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('bundled slice worker result publisher', () => {
  it('uses captured ownership buffers and a hardened transfer transport', async () => {
    const contractUrl = new URL('./slice-kernel-contract.ts', import.meta.url);
    const workerUrl = new URL('../workers/slice.worker.ts', contractUrl);
    const nativeStructuredClone = globalThis.structuredClone;
    let delivered: unknown;
    class FakeWorkerGlobalScope {
      static [Symbol.hasInstance](): boolean { return true; }
    }
    vi.stubGlobal('WorkerGlobalScope', FakeWorkerGlobalScope);
    vi.stubGlobal('location', { href: workerUrl.href, pathname: workerUrl.pathname });
    vi.stubGlobal('postMessage', (value: unknown, options: StructuredSerializeOptions) => {
      delivered = nativeStructuredClone(value, options);
    });
    const contract = await import('./slice-kernel-contract');
    const counters = new Uint32Array(9);
    counters[3] = 1;
    counters[4] = 1;
    const result = contract.parseSliceBatchResult({
      version: 1,
      statusCode: 0,
      planeOffsets: new Uint32Array([0, 1]),
      endpoints: new Float64Array([0, 0, 1, 1]),
      diagnosticCounters: counters,
    }, {
      positions: new Float32Array([0, 0, -1, 2, 0, 1, 0, 2, 1]),
      indices: new Uint32Array([0, 1, 2]),
      planes: new Float64Array([0]),
      deadlineCheckInterval: 4_096,
    }, () => undefined);
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const bufferDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer');
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
    try {
      Object.defineProperty(typedArrayPrototype, 'buffer', {
        configurable: true,
        get() { throw new Error('patched typed-array buffer getter'); },
      });
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value() { throw new Error('patched array iterator'); },
      });
      contract.publishBundledSliceBatchResult(result, {
        type: 'slice-result',
        generation: 1,
        partitionIndex: 0,
      });
    } finally {
      Object.defineProperty(typedArrayPrototype, 'buffer', bufferDescriptor!);
      Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor!);
    }
    expect(delivered).toMatchObject({
      type: 'slice-result',
      generation: 1,
      partitionIndex: 0,
      endpoints: new Float64Array([0, 0, 1, 1]),
    });
  });
});
