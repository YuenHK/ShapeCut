import { Worker as NodeWorker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SliceWorkerPool,
  SliceWorkerPoolError,
  type SliceWorkerInboundMessage,
  type SliceWorkerLike,
  type SliceWorkerOutboundMessage,
} from './slice-worker-pool';

type MessageListener = (event: MessageEvent<SliceWorkerOutboundMessage>) => void;
type ErrorListener = (event: ErrorEvent) => void;

class ControlledWorker implements SliceWorkerLike {
  readonly posted: SliceWorkerInboundMessage[] = [];
  readonly transferred: Transferable[][] = [];
  terminated = false;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  postMessage(message: SliceWorkerInboundMessage, transfer: Transferable[]): void {
    this.posted.push(message);
    this.transferred.push(transfer);
  }

  addEventListener(type: 'message' | 'error', listener: MessageListener | ErrorListener): void {
    if (type === 'message') this.messageListeners.add(listener as MessageListener);
    else this.errorListeners.add(listener as ErrorListener);
  }

  removeEventListener(type: 'message' | 'error', listener: MessageListener | ErrorListener): void {
    if (type === 'message') this.messageListeners.delete(listener as MessageListener);
    else this.errorListeners.delete(listener as ErrorListener);
  }

  terminate(): void { this.terminated = true; }

  complete(endpointBase = 0): void {
    const request = this.posted.at(-1);
    if (!request || request.type !== 'slice') throw new Error('worker has no request');
    const planeOffsets = new Uint32Array(request.planes.length + 1);
    const endpoints = new Float64Array(request.planes.length * 4);
    for (let localPlane = 0; localPlane < request.planes.length; localPlane += 1) {
      planeOffsets[localPlane + 1] = localPlane + 1;
      endpoints.set([request.planes[localPlane] + endpointBase, 0, request.planes[localPlane], 1], localPlane * 4);
    }
    const diagnosticCounters = new Uint32Array(9);
    diagnosticCounters[3] = request.indices.length / 3 * request.planes.length;
    diagnosticCounters[4] = request.planes.length;
    this.emitMessage({
      type: 'slice-result',
      generation: request.generation,
      partitionIndex: request.partitionIndex,
      version: 1,
      statusCode: 0,
      planeOffsets,
      endpoints,
      diagnosticCounters,
    });
  }

  emitMessage(data: SliceWorkerOutboundMessage): void {
    const event = { data } as MessageEvent<SliceWorkerOutboundMessage>;
    for (const listener of this.messageListeners) listener(event);
  }

  captureQueuedMessageDelivery(): (data: SliceWorkerOutboundMessage) => void {
    const listener = [...this.messageListeners][0];
    if (!listener) throw new Error('worker has no message listener');
    return (data) => listener({ data } as MessageEvent<SliceWorkerOutboundMessage>);
  }

  crash(): void {
    const event = { message: 'private worker details' } as ErrorEvent;
    for (const listener of this.errorListeners) listener(event);
  }
}

function request(deadlineOffsetMs = 5_000) {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 4,
      2, 0, 0, 3, 0, 0, 2, 1, 1,
      4, 0, 3, 5, 0, 3, 4, 1, 4,
    ]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    planes: new Float64Array([0.5, 1.5, 2.5, 3.5]),
    deadlineCheckInterval: 64,
    deadlineAt: Date.now() + deadlineOffsetMs,
  };
}

const pools: SliceWorkerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.cancel()));
});

describe('SliceWorkerPool', () => {
  it('cancels before asynchronous partitioning can create a worker', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 4,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const run = pool.run(request());
    const rejection = expect(run).rejects.toMatchObject({ code: 'CANCELLED' });

    await pool.cancel();

    await rejection;
    expect(workers).toHaveLength(0);
    expect(pool.activeWorkerCount).toBe(0);
  });

  it('cancels during a yielded maximum-work legal partition without starting workers', async () => {
    const triangleCount = 500_000;
    const indices = new Uint32Array(triangleCount * 3);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      indices.set([0, 1, 2], triangle * 3);
    }
    const input = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 2]),
      indices,
      planes: Float64Array.from({ length: 500 }, (_value, index) => (index + 1) / 501 * 2),
      deadlineCheckInterval: 4_096,
      deadlineAt: Date.now() + 10_000,
    };
    const workers: ControlledWorker[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 8,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const run = pool.run(input);
    const rejection = expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const started = performance.now();

    await pool.cancel();

    await rejection;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(workers).toHaveLength(0);
    expect(pool.activeWorkerCount).toBe(0);
  });
  it('never invokes accessor fields while snapshotting pool intake', async () => {
    const source = request();
    let getterCalls = 0;
    const hostile = Object.defineProperty({
      indices: source.indices,
      planes: source.planes,
      deadlineCheckInterval: source.deadlineCheckInterval,
      deadlineAt: source.deadlineAt,
    }, 'positions', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return source.positions;
      },
    });
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => new ControlledWorker() });
    pools.push(pool);

    await expect(pool.run(hostile as ReturnType<typeof request>)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      fallbackEligible: false,
    });

    expect(getterCalls).toBe(0);
    expect(source.positions.byteLength).toBeGreaterThan(0);
  });
  it('submits partitions FIFO, transfers owned inputs, and consumes caller ownership', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 4,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const input = request();
    const run = pool.run(input);
    await vi.waitFor(() => expect(workers).toHaveLength(2));

    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.posted[0].partitionIndex)).toEqual([0, 1]);
    expect(workers.every((worker) => worker.transferred[0].length === 3)).toBe(true);
    expect(input.positions.byteLength).toBe(0);
    expect(input.indices.byteLength).toBe(0);
    expect(input.planes.byteLength).toBe(0);

    workers.forEach((worker) => worker.complete());
    await run;
  });

  it('merges out-of-order completions by global plane then stable segment order', async () => {
    const workers: ControlledWorker[] = [];
    const progress: number[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 4,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const run = pool.run(request(), (event) => progress.push(event.completedPartitions));
    await vi.waitFor(() => expect(workers).toHaveLength(2));

    workers[1].complete();
    workers[0].complete();
    const result = await run;

    expect([...result.planeOffsets]).toEqual([0, 1, 2, 3, 4]);
    expect([...result.endpoints].filter((_value, index) => index % 4 === 0))
      .toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(progress).toEqual([1, 2]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(result.endpoints))).toBe(true);
    expect(pool.activeWorkerCount).toBe(0);
  });

  it('ignores a truly queued old-generation delivery after job replacement', async () => {
    const workers: ControlledWorker[] = [];
    const replacementProgress: number[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 4,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const oldRun = pool.run(request());
    const oldRejection = expect(oldRun).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    const oldWorker = workers[0];
    const oldRequest = oldWorker.posted[0];
    const deliverQueuedOldMessage = oldWorker.captureQueuedMessageDelivery();

    const replacementRun = pool.run(request(), (event) => {
      replacementProgress.push(event.completedPartitions);
    });
    await oldRejection;
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    expect(workers.slice(0, 2).every((worker) => worker.terminated)).toBe(true);

    deliverQueuedOldMessage({
      type: 'slice-result',
      generation: oldRequest.generation,
      partitionIndex: oldRequest.partitionIndex,
      version: 1,
      statusCode: 0,
      planeOffsets: new Uint32Array(oldRequest.planes.length + 1),
      endpoints: new Float64Array(),
      diagnosticCounters: Uint32Array.from([
        0, 0, 0, oldRequest.indices.length / 3 * oldRequest.planes.length, 0, 0, 0, 0, 0,
      ]),
    });
    expect(replacementProgress).toEqual([]);
    expect(pool.activeWorkerCount).toBe(2);

    workers.slice(2).forEach((worker) => worker.complete());
    const replacementResult = await replacementRun;
    expect(replacementProgress).toEqual([1, 2]);
    expect([...replacementResult.planeOffsets]).toEqual([0, 1, 2, 3, 4]);
  });

  it('executes the controlled WASM kernel through a real Node worker', async () => {
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 1,
      workerFactory: createNodeProtocolWorker,
    });
    pools.push(pool);

    const result = await pool.run(request());

    expect(result.planeOffsets.length).toBe(5);
    expect(result.diagnosticCounters.at(3)).toBe(12);
    expect(pool.activeWorkerCount).toBe(0);
  });

  it('fails closed on an injected worker crash without granting fallback provenance', async () => {
    const worker = new ControlledWorker();
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => worker });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    worker.crash();

    await expect(run).rejects.toMatchObject({
      code: 'WORKER_CRASH',
      fallbackEligible: false,
      message: 'Slice worker crashed',
    });
    expect(pool.activeWorkerCount).toBe(0);
  });

  it('rejects malformed worker results without fallback', async () => {
    const worker = new ControlledWorker();
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => worker });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const submitted = worker.posted[0];
    worker.emitMessage({
      type: 'slice-result',
      generation: submitted.generation,
      partitionIndex: submitted.partitionIndex,
      version: 1,
      statusCode: 0,
      planeOffsets: new Uint32Array([1]),
      endpoints: new Float64Array(),
      diagnosticCounters: new Uint32Array(9),
    });

    await expect(run).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', fallbackEligible: false });
    expect(pool.activeWorkerCount).toBe(0);
  });

  it('rejects an oversized partition result before endpoint traversal or storage', async () => {
    const worker = new ControlledWorker();
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => worker });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const submitted = worker.posted[0];
    const segmentCount = 262_145;
    const planeOffsets = new Uint32Array(submitted.planes.length + 1);
    planeOffsets.fill(segmentCount);
    planeOffsets[0] = 0;
    const diagnosticCounters = new Uint32Array(9);
    diagnosticCounters[3] = submitted.indices.length / 3 * submitted.planes.length;
    diagnosticCounters[4] = segmentCount;
    const endpoints = new Float64Array(segmentCount * 4);
    let traversed = false;
    const originalIterator = Float64Array.prototype[Symbol.iterator];
    Object.defineProperty(Float64Array.prototype, Symbol.iterator, {
      configurable: true,
      value() {
        traversed = true;
        throw new Error('oversized endpoints must not be traversed');
      },
    });
    try {
      worker.emitMessage({
        type: 'slice-result', generation: submitted.generation,
        partitionIndex: submitted.partitionIndex, version: 1, statusCode: 0,
        planeOffsets, endpoints, diagnosticCounters,
      });
      await expect(run).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', fallbackEligible: false });
      expect(traversed).toBe(false);
    } finally {
      Object.defineProperty(Float64Array.prototype, Symbol.iterator, {
        configurable: true,
        value: originalIterator,
      });
    }
  });

  it('rejects aggregate endpoint bytes before storing the overflowing partition', async () => {
    const triangleCount = 262_144;
    const indices = new Uint32Array(triangleCount * 3);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      indices.set([0, 1, 2], triangle * 3);
    }
    const workers: ControlledWorker[] = [];
    const progress: number[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 3,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const run = pool.run({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 2]),
      indices,
      planes: new Float64Array([0.5, 1.5]),
      deadlineCheckInterval: 4_096,
      deadlineAt: Date.now() + 20_000,
    }, (event) => progress.push(event.completedPartitions));
    await vi.waitFor(() => expect(workers).toHaveLength(2), { timeout: 10_000 });
    const segmentCount = 131_073;
    for (const worker of workers) {
      const submitted = worker.posted[0];
      const diagnosticCounters = new Uint32Array(9);
      diagnosticCounters[3] = submitted.indices.length / 3 * submitted.planes.length;
      diagnosticCounters[4] = segmentCount;
      worker.emitMessage({
        type: 'slice-result', generation: submitted.generation,
        partitionIndex: submitted.partitionIndex, version: 1, statusCode: 0,
        planeOffsets: new Uint32Array([0, segmentCount]),
        endpoints: new Float64Array(segmentCount * 4),
        diagnosticCounters,
      });
    }

    await expect(run).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', fallbackEligible: false });
    expect(progress).toEqual([1]);
    expect(pool.activeWorkerCount).toBe(0);
  }, 15_000);

  it('rejects extra worker result fields as a protocol violation', async () => {
    const worker = new ControlledWorker();
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => worker });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const submitted = worker.posted[0];
    const planeOffsets = new Uint32Array(submitted.planes.length + 1);
    const diagnosticCounters = new Uint32Array(9);
    diagnosticCounters[3] = submitted.indices.length / 3 * submitted.planes.length;
    worker.emitMessage({
      type: 'slice-result', generation: submitted.generation,
      partitionIndex: submitted.partitionIndex, version: 1, statusCode: 0,
      planeOffsets, endpoints: new Float64Array(), diagnosticCounters,
      privateDetails: 'must not cross the protocol',
    } as SliceWorkerOutboundMessage);

    await expect(run).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', fallbackEligible: false });
  });

  it('does not trust an injected worker resource failure as fallback provenance', async () => {
    const worker = new ControlledWorker();
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => worker });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const submitted = worker.posted[0];
    worker.emitMessage({
      type: 'slice-error',
      generation: submitted.generation,
      partitionIndex: submitted.partitionIndex,
      code: 'RESOURCE_LIMIT',
    });

    await expect(run).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', fallbackEligible: false });
  });

  it('rejects impossible diagnostic counters from a worker', async () => {
    const worker = new ControlledWorker();
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => worker });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
    const submitted = worker.posted[0];
    const diagnosticCounters = new Uint32Array(9);
    diagnosticCounters[0] = submitted.indices.length / 3 + 1;
    diagnosticCounters[3] = submitted.indices.length / 3 * submitted.planes.length;
    worker.emitMessage({
      type: 'slice-result', generation: submitted.generation,
      partitionIndex: submitted.partitionIndex, version: 1, statusCode: 1,
      planeOffsets: new Uint32Array(submitted.planes.length + 1),
      endpoints: new Float64Array(), diagnosticCounters,
    });

    await expect(run).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', fallbackEligible: false });
  });

  it('hard-cancels every worker and reaches zero active workers within one second', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 8,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const run = pool.run(request());
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    const started = performance.now();

    await pool.cancel();

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(pool.activeWorkerCount).toBe(0);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED', fallbackEligible: false });
  });

  it('treats an expired worker deadline as fail-closed and never fallback eligible', async () => {
    const pool = new SliceWorkerPool({ hardwareConcurrency: 1, workerFactory: () => new ControlledWorker() });
    pools.push(pool);

    const run = pool.run(request(20));

    await expect(run).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED', fallbackEligible: false });
    expect(pool.activeWorkerCount).toBe(0);
  });

  it('rejects an oversized plane allocation before partitioning or ownership transfer', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new SliceWorkerPool({
      hardwareConcurrency: 1,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    pools.push(pool);
    const input = { ...request(), planes: new Float64Array(16_385) };

    await expect(pool.run(input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      fallbackEligible: false,
    });

    expect(workers).toHaveLength(0);
    expect(input.positions.byteLength).toBeGreaterThan(0);
    expect(input.indices.byteLength).toBeGreaterThan(0);
    expect(input.planes.byteLength).toBeGreaterThan(0);
  });
});

function createNodeProtocolWorker(): SliceWorkerLike {
  const worker = new NodeWorker(`
    const { readFileSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    void import(workerData.wrapperUrl).then(({ initializeSliceKernel }) => {
      const kernel = initializeSliceKernel(readFileSync(workerData.wasmPath));
      parentPort.on('message', (request) => {
        const result = kernel.sliceLayerBatch({
          positions: request.positions,
          indices: request.indices,
          planes: request.planes,
          deadlineCheckInterval: request.deadlineCheckInterval,
        }, { deadlineHook: () => false });
        parentPort.postMessage({
          type: 'slice-result', generation: request.generation,
          partitionIndex: request.partitionIndex, ...result,
        }, [
          result.planeOffsets.buffer,
          result.endpoints.buffer,
          result.diagnosticCounters.buffer,
        ]);
      });
    });
  `, {
    eval: true,
    workerData: {
      wrapperUrl: pathToFileURL(resolve('src/wasm/slice-kernel-wrapper.mjs')).href,
      wasmPath: resolve('src/wasm/generated/geometry_wasm_bg.wasm'),
    },
  });
  const messageWrappers = new Map<MessageListener, (data: SliceWorkerOutboundMessage) => void>();
  const errorWrappers = new Map<ErrorListener, (error: Error) => void>();
  return {
    postMessage(message, transfer) {
      worker.postMessage(message, transfer.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer));
    },
    addEventListener(type, listener) {
      if (type === 'message') {
        const wrapped = (data: SliceWorkerOutboundMessage) => {
          const currentRealmData: SliceWorkerOutboundMessage = data.type === 'slice-result'
            ? {
                ...data,
                planeOffsets: Uint32Array.from(data.planeOffsets),
                endpoints: Float64Array.from(data.endpoints),
                diagnosticCounters: Uint32Array.from(data.diagnosticCounters),
              }
            : data;
          (listener as MessageListener)({ data: currentRealmData } as MessageEvent<SliceWorkerOutboundMessage>);
        };
        messageWrappers.set(listener as MessageListener, wrapped);
        worker.on('message', wrapped);
      } else {
        const wrapped = (error: Error) => (listener as ErrorListener)({ message: error.message } as ErrorEvent);
        errorWrappers.set(listener as ErrorListener, wrapped);
        worker.on('error', wrapped);
      }
    },
    removeEventListener(type, listener) {
      if (type === 'message') {
        const wrapped = messageWrappers.get(listener as MessageListener);
        if (wrapped) worker.off('message', wrapped);
      } else {
        const wrapped = errorWrappers.get(listener as ErrorListener);
        if (wrapped) worker.off('error', wrapped);
      }
    },
    terminate() { void worker.terminate(); },
  };
}

it('uses a typed fail-closed pool error', () => {
  const error = new SliceWorkerPoolError('PROTOCOL_ERROR', 'bad protocol', false);
  expect(error).toMatchObject({ name: 'SliceWorkerPoolError', fallbackEligible: false });
});

it('does not let callers forge fallback eligibility from an error code', () => {
  const error = new SliceWorkerPoolError('WORKER_CRASH', 'caller-created');
  expect(error.fallbackEligible).toBe(false);
});
