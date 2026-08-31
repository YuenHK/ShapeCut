import { afterEach, describe, expect, it } from 'vitest';
import { SliceWorkerPool, type SliceWorkerLike } from './slice-worker-pool';

function tetrahedronRequest() {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 0, 3,
    ]),
    planes: new Float64Array([0.2, 0.4, 0.6, 0.8]),
    deadlineCheckInterval: 32,
    deadlineAt: Date.now() + 10_000,
  };
}

const pools: SliceWorkerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.cancel()));
});

describe('real Chromium slice worker pool', () => {
  it('uses only Worker and URL bootstrap primitives captured at module load', async () => {
    const originalWorker = globalThis.Worker;
    const originalUrl = globalThis.URL;
    const postMessageDescriptor = Object.getOwnPropertyDescriptor(originalWorker.prototype, 'postMessage');
    const terminateDescriptor = Object.getOwnPropertyDescriptor(originalWorker.prototype, 'terminate');
    const addDescriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener');
    const removeDescriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'removeEventListener');
    const urlToStringDescriptor = Object.getOwnPropertyDescriptor(URL.prototype, 'toString');
    const attackerUrl = URL.createObjectURL(new Blob([
      `self.onmessage = () => self.postMessage({ type: 'slice-result' })`,
    ], { type: 'text/javascript' }));
    class ReplacedWorker {
      constructor() { throw new Error('post-load replacement must not be trusted'); }
    }
    class ReplacedUrl {
      constructor() { throw new Error('post-load replacement must not be trusted'); }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ReplacedWorker });
    Object.defineProperty(globalThis, 'URL', { configurable: true, value: ReplacedUrl });
    Object.defineProperty(originalWorker.prototype, 'postMessage', {
      configurable: true, value() { throw new Error('patched postMessage'); },
    });
    Object.defineProperty(originalWorker.prototype, 'terminate', {
      configurable: true, value() { throw new Error('patched terminate'); },
    });
    Object.defineProperty(EventTarget.prototype, 'addEventListener', {
      configurable: true, value() { throw new Error('patched addEventListener'); },
    });
    Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
      configurable: true, value() { throw new Error('patched removeEventListener'); },
    });
    Object.defineProperty(originalUrl.prototype, 'toString', {
      configurable: true,
      value() { return attackerUrl; },
    });
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1 });
    pools.push(pool);
    try {
      const result = await pool.run(tetrahedronRequest());
      expect(result.planeOffsets.length).toBe(5);
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
      Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
      Object.defineProperty(originalWorker.prototype, 'postMessage', postMessageDescriptor!);
      Object.defineProperty(originalWorker.prototype, 'terminate', terminateDescriptor!);
      Object.defineProperty(EventTarget.prototype, 'addEventListener', addDescriptor!);
      Object.defineProperty(EventTarget.prototype, 'removeEventListener', removeDescriptor!);
      Object.defineProperty(originalUrl.prototype, 'toString', urlToStringDescriptor!);
      URL.revokeObjectURL(attackerUrl);
    }
  });

  it('rejects raw result publication from a crafted same-origin slice.worker pathname', async () => {
    const worker = new Worker(
      new URL('./crafted-slice.worker.test-fixture.ts', import.meta.url),
      { type: 'module' },
    );
    try {
      const response = new Promise<unknown>((resolve, reject) => {
        worker.addEventListener('message', (event) => resolve(event.data), { once: true });
        worker.addEventListener('error', reject, { once: true });
      });
      worker.postMessage(undefined);
      await expect(response).resolves.toEqual({ closedEntryDenied: true });
    } finally {
      worker.terminate();
    }
  });

  it('does not export raw result ownership to an arbitrary dedicated worker', async () => {
    const contractUrl = `${globalThis.location.origin}/src/wasm/slice-kernel-contract.ts`;
    const source = `
      self.onmessage = async (event) => {
        const contract = await import(event.data);
        const request = {
          positions: new Float32Array([0,0,-1, 2,0,1, 0,2,1]),
          indices: new Uint32Array([0,1,2]),
          planes: new Float64Array([0]),
          deadlineCheckInterval: 4096,
        };
        const counters = new Uint32Array(9);
        counters[3] = 1;
        counters[4] = 1;
        const result = contract.parseSliceBatchResult({
          version: 1,
          statusCode: 0,
          planeOffsets: new Uint32Array([0,1]),
          endpoints: new Float64Array([0,0,1,1]),
          diagnosticCounters: counters,
        }, request, () => undefined);
        let escaped = false;
        if (typeof contract.takeTransferableSliceBatchResultForBundledWorker === 'function') {
          escaped = contract.takeTransferableSliceBatchResultForBundledWorker(result)
            .endpoints instanceof Float64Array;
        }
        let closedEntryDenied = typeof contract.publishBundledSliceBatchResult !== 'function';
        if (typeof contract.publishBundledSliceBatchResult === 'function') {
          try {
            contract.publishBundledSliceBatchResult(result, {
              type: 'slice-result', generation: 1, partitionIndex: 0,
            });
          } catch {
            closedEntryDenied = true;
          }
        }
        self.postMessage({
          helperExported: typeof contract.takeTransferableSliceBatchResultForBundledWorker === 'function',
          escaped,
          closedEntryDenied,
          facade: [...result.endpoints],
        });
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    try {
      const response = new Promise<unknown>((resolve, reject) => {
        worker.addEventListener('message', (event) => resolve(event.data), { once: true });
        worker.addEventListener('error', reject, { once: true });
      });
      worker.postMessage(contractUrl);
      await expect(response).resolves.toEqual({
        helperExported: false,
        escaped: false,
        closedEntryDenied: true,
        facade: [0, 0, 1, 1],
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });

  it('loads WASM in bounded workers and merges canonical planes without shared memory', async () => {
    const pool = new SliceWorkerPool({ hardwareConcurrency: 8 });
    pools.push(pool);
    const input = tetrahedronRequest();
    const progress: number[] = [];

    const result = await pool.run(input, (event) => progress.push(event.completedPlanes));

    expect(input.positions.byteLength).toBe(0);
    expect(input.indices.byteLength).toBe(0);
    expect(input.planes.byteLength).toBe(0);
    expect([...result.planeOffsets]).toEqual([0, 3, 6, 9, 12]);
    expect([...result.endpoints]).toEqual([
      0.8, 0, 0, 0, 0, 0.8, 0.8, 0, 0, 0, 0, 0.8,
      0.6, 0, 0, 0, 0, 0.6, 0.6, 0, 0, 0, 0, 0.6,
      0.4, 0, 0, 0, 0, 0.4, 0.4, 0, 0, 0, 0, 0.4,
      0.19999999999999996, 0, 0, 0,
      0, 0.19999999999999996, 0.19999999999999996, 0,
      0, 0, 0, 0.19999999999999996,
    ]);
    expect(progress.at(-1)).toBe(4);
    expect(pool.activeWorkerCount).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(result.endpoints))).toBe(true);
    expect(globalThis.crossOriginIsolated).not.toBe(true);
  });

  it('preserves remote degenerate evidence even when no planes are requested', async () => {
    const pool = new SliceWorkerPool({ hardwareConcurrency: 8 });
    pools.push(pool);
    const result = await pool.run({
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 2,
        0, 0, 100, 1, 0, 100, 2, 0, 100,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      planes: new Float64Array(),
      deadlineCheckInterval: 32,
      deadlineAt: Date.now() + 10_000,
    });

    expect(result.statusCode).toBe(1);
    expect(result.diagnosticCounters.at(0)).toBe(1);
    expect([...result.planeOffsets]).toEqual([0]);
  });

  it('hard-terminates real workers and ignores their late completion', async () => {
    const pool = new SliceWorkerPool({ hardwareConcurrency: 8 });
    pools.push(pool);
    const run = pool.run(tetrahedronRequest());
    const rejection = expect(run).rejects.toMatchObject({
      code: 'CANCELLED',
      fallbackEligible: false,
    });

    await pool.cancel();

    await rejection;
    expect(pool.activeWorkerCount).toBe(0);
  });

  it.each([
    ['crash', `self.onmessage = () => { throw new Error('private worker details') }`, 'WORKER_CRASH'],
    ['malformed protocol', `self.onmessage = () => self.postMessage({ type: 'slice-result' })`, 'PROTOCOL_ERROR'],
    ['deadline timeout', `self.onmessage = () => undefined`, 'DEADLINE_EXCEEDED'],
  ])('fails closed for a real Chromium worker %s', async (_name, source, code) => {
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 1,
      workerFactory: () => createBlobWorker(source),
    });
    pools.push(pool);
    const input = tetrahedronRequest();
    input.deadlineAt = Date.now() + 100;

    await expect(pool.run(input)).rejects.toMatchObject({ code, fallbackEligible: false });
    expect(pool.activeWorkerCount).toBe(0);
  });
});

function createBlobWorker(source: string): SliceWorkerLike {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  let terminated = false;
  return {
    postMessage(message, transfer) { worker.postMessage(message, transfer); },
    addEventListener(type, listener) { worker.addEventListener(type, listener as EventListener); },
    removeEventListener(type, listener) { worker.removeEventListener(type, listener as EventListener); },
    terminate() {
      if (terminated) return;
      terminated = true;
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
