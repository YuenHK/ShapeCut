import {
  SLICE_RESULT_VERSION,
  SLICE_STATUS_GEOMETRY_EVIDENCE,
  SLICE_STATUS_OK,
  type ReadonlySliceArray,
  type SliceBatchResult,
} from '../wasm/slice-kernel-contract';
import {
  partitionSliceWork,
  resolveSliceWorkerCount,
  type SliceWorkPartition,
} from './slice-partitioner';

export type SliceWorkerPoolErrorCode =
  | 'INVALID_REQUEST'
  | 'WORKER_CRASH'
  | 'PROTOCOL_ERROR'
  | 'LOAD_FAILED'
  | 'EXECUTION_FAILED'
  | 'RESOURCE_LIMIT'
  | 'CANCELLED'
  | 'DEADLINE_EXCEEDED';

const FALLBACK_ELIGIBLE_POOL_CODES: ReadonlySet<SliceWorkerPoolErrorCode> = new Set([
  'WORKER_CRASH',
  'LOAD_FAILED',
  'EXECUTION_FAILED',
  'RESOURCE_LIMIT',
]);
const FALLBACK_CAPABILITY = Object.freeze({});
const fallbackEligiblePoolErrors = new WeakSet<object>();

export class SliceWorkerPoolError extends Error {
  readonly code: SliceWorkerPoolErrorCode;
  readonly fallbackEligible: boolean;

  constructor(code: SliceWorkerPoolErrorCode, message: string, capability?: unknown) {
    super(message);
    this.name = 'SliceWorkerPoolError';
    this.code = code;
    this.fallbackEligible = capability === FALLBACK_CAPABILITY
      && FALLBACK_ELIGIBLE_POOL_CODES.has(code);
    if (this.fallbackEligible) fallbackEligiblePoolErrors.add(this);
    Object.freeze(this);
  }
}

export function isSliceWorkerPoolFallbackEligible(error: unknown): error is SliceWorkerPoolError {
  return error instanceof SliceWorkerPoolError && fallbackEligiblePoolErrors.has(error);
}

function fallbackPoolError(
  code: 'WORKER_CRASH' | 'LOAD_FAILED' | 'EXECUTION_FAILED' | 'RESOURCE_LIMIT',
  message: string,
  trustedOperation: boolean,
): SliceWorkerPoolError {
  return new SliceWorkerPoolError(
    code,
    message,
    trustedOperation ? FALLBACK_CAPABILITY : undefined,
  );
}

export interface SliceWorkerPoolRequest {
  /** All three full-span fixed buffers are consumed once the request is admitted. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly planes: Float64Array;
  readonly deadlineCheckInterval: number;
  readonly deadlineAt: number;
}

export interface SliceWorkerProgress {
  readonly completedPartitions: number;
  readonly totalPartitions: number;
  readonly completedPlanes: number;
  readonly totalPlanes: number;
}

export interface SliceWorkerRequestMessage {
  readonly type: 'slice';
  readonly generation: number;
  readonly partitionIndex: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly planes: Float64Array;
  readonly deadlineCheckInterval: number;
  readonly deadlineAt: number;
}

export type SliceWorkerInboundMessage = SliceWorkerRequestMessage;

export interface SliceWorkerResultMessage {
  readonly type: 'slice-result';
  readonly generation: number;
  readonly partitionIndex: number;
  readonly version: number;
  readonly statusCode: number;
  readonly planeOffsets: Uint32Array;
  readonly endpoints: Float64Array;
  readonly diagnosticCounters: Uint32Array;
}

export interface SliceWorkerErrorMessage {
  readonly type: 'slice-error';
  readonly generation: number;
  readonly partitionIndex: number;
  readonly code: 'LOAD_FAILED' | 'EXECUTION_FAILED' | 'INVALID_REQUEST' | 'INVALID_RESULT'
    | 'RESOURCE_LIMIT' | 'DEADLINE_CHECK_FAILED' | 'DEADLINE_EXCEEDED' | 'CANCELLED'
    | 'DISPOSED';
}

export type SliceWorkerOutboundMessage = SliceWorkerResultMessage | SliceWorkerErrorMessage;

type MessageListener = (event: MessageEvent<SliceWorkerOutboundMessage>) => void;
type ErrorListener = (event: ErrorEvent) => void;

export interface SliceWorkerLike {
  postMessage(message: SliceWorkerInboundMessage, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  addEventListener(type: 'error', listener: ErrorListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'error', listener: ErrorListener): void;
  terminate(): void;
}

export interface SliceWorkerPoolOptions {
  readonly hardwareConcurrency?: number;
  readonly workerFactory?: () => SliceWorkerLike;
}

interface ExpectedPartition {
  readonly partitionIndex: number;
  readonly planeIndices: Uint32Array;
  readonly planeCount: number;
  readonly triangleCount: number;
}

interface ValidatedPartitionResult {
  readonly expected: ExpectedPartition;
  readonly statusCode: typeof SLICE_STATUS_OK | typeof SLICE_STATUS_GEOMETRY_EVIDENCE;
  readonly planeOffsets: Uint32Array;
  readonly endpoints: Float64Array;
  readonly diagnosticCounters: Uint32Array;
}

interface ActiveWorker {
  readonly worker: SliceWorkerLike;
  readonly messageListener: MessageListener;
  readonly errorListener: ErrorListener;
}

interface ActiveJob {
  readonly generation: number;
  readonly totalPlanes: number;
  readonly workers: Set<ActiveWorker>;
  readonly results: Map<number, ValidatedPartitionResult>;
  readonly reject: (error: SliceWorkerPoolError) => void;
  readonly resolve: (result: SliceBatchResult) => void;
  readonly onProgress: ((event: SliceWorkerProgress) => void) | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  completedPlanes: number;
  settled: boolean;
}

const structuredCloneIntrinsic = globalThis.structuredClone;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'resizable',
)?.get;
const arrayBufferSlice = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'slice')?.value;
const MAX_VERTEX_COUNT = 3_145_728;
const MAX_TRIANGLE_COUNT = 1_048_576;
const MAX_PLANE_COUNT = 16_384;
const MAX_PLANE_TRIANGLE_TESTS = 250_000_000;
const MAX_MERGED_ENDPOINT_BYTES = 8 * 1024 * 1024;

export class SliceWorkerPool {
  readonly #hardwareConcurrency: number | undefined;
  readonly #workerFactory: () => SliceWorkerLike;
  readonly #trustedWorkerFactory: boolean;
  #generation = 0;
  #activeJob: ActiveJob | undefined;

  constructor(options: SliceWorkerPoolOptions = {}) {
    this.#hardwareConcurrency = options.hardwareConcurrency;
    this.#workerFactory = options.workerFactory ?? createBrowserSliceWorker;
    this.#trustedWorkerFactory = options.workerFactory === undefined;
  }

  get activeWorkerCount(): number {
    return this.#activeJob?.workers.size ?? 0;
  }

  run(
    request: SliceWorkerPoolRequest,
    onProgress?: (event: SliceWorkerProgress) => void,
  ): Promise<SliceBatchResult> {
    this.#abortActive(new SliceWorkerPoolError('CANCELLED', 'Slice worker job was superseded'));
    const generation = ++this.#generation;
    let partitions: readonly SliceWorkPartition[];
    let totalPlanes: number;
    try {
      validatePoolRequest(request);
      if (request.deadlineAt <= Date.now()) {
        throw new SliceWorkerPoolError('DEADLINE_EXCEEDED', 'Slice worker deadline was exceeded');
      }
      totalPlanes = request.planes.length;
      partitions = partitionSliceWork(
        { positions: request.positions, indices: request.indices },
        request.planes,
        resolveSliceWorkerCount(this.#hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency),
      );
      consumePoolRequest(request);
    } catch (error) {
      return Promise.reject(asPoolRequestError(error));
    }

    if (partitions.length === 0) return Promise.resolve(emptySliceResult());

    return new Promise<SliceBatchResult>((resolve, reject) => {
      const job: ActiveJob = {
        generation,
        totalPlanes,
        workers: new Set(),
        results: new Map(),
        reject,
        resolve,
        onProgress,
        timeout: undefined,
        completedPlanes: 0,
        settled: false,
      };
      this.#activeJob = job;
      const timeoutMs = Math.max(0, Math.min(2_147_483_647, request.deadlineAt - Date.now()));
      job.timeout = setTimeout(() => {
        this.#failJob(job, new SliceWorkerPoolError(
          'DEADLINE_EXCEEDED',
          'Slice worker deadline was exceeded',
        ));
      }, timeoutMs);

      try {
        for (const partition of partitions) this.#submitPartition(job, partition, request);
      } catch (error) {
        this.#failJob(job, error instanceof SliceWorkerPoolError
          ? error
          : fallbackPoolError(
              'WORKER_CRASH',
              'Slice worker could not be started',
              this.#trustedWorkerFactory,
            ));
      }
    });
  }

  cancel(): Promise<void> {
    this.#generation += 1;
    this.#abortActive(new SliceWorkerPoolError('CANCELLED', 'Slice worker job was cancelled'));
    return Promise.resolve();
  }

  #submitPartition(
    job: ActiveJob,
    partition: SliceWorkPartition,
    request: Pick<SliceWorkerPoolRequest, 'deadlineCheckInterval' | 'deadlineAt'>,
  ): void {
    const worker = this.#workerFactory();
    const expected: ExpectedPartition = Object.freeze({
      partitionIndex: partition.partitionIndex,
      planeIndices: partition.planeIndices,
      planeCount: partition.planes.length,
      triangleCount: partition.indices.length / 3,
    });
    let activeWorker: ActiveWorker;
    const messageListener: MessageListener = (event) => {
      if (job !== this.#activeJob || job.generation !== this.#generation || job.settled) return;
      try {
        if (isWorkerErrorMessage(event.data, expected, job.generation)) {
          this.#failJob(job, mapWorkerError(event.data.code, this.#trustedWorkerFactory));
          return;
        }
        const result = validateWorkerResult(event.data, expected, job.generation);
        if (job.results.has(expected.partitionIndex)) {
          throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker sent a duplicate result');
        }
        job.results.set(expected.partitionIndex, result);
        job.completedPlanes += expected.planeCount;
        this.#releaseWorker(job, activeWorker);
        job.onProgress?.(Object.freeze({
          completedPartitions: job.results.size,
          totalPartitions: job.workers.size + job.results.size,
          completedPlanes: job.completedPlanes,
          totalPlanes: job.totalPlanes,
        }));
        if (job.completedPlanes === job.totalPlanes) {
          this.#completeJob(job);
        }
      } catch (error) {
        this.#failJob(job, error instanceof SliceWorkerPoolError
          ? error
          : new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker protocol was rejected'));
      }
    };
    const errorListener: ErrorListener = () => {
      if (job !== this.#activeJob || job.generation !== this.#generation || job.settled) return;
      this.#failJob(job, fallbackPoolError(
        'WORKER_CRASH',
        'Slice worker crashed',
        this.#trustedWorkerFactory,
      ));
    };
    activeWorker = { worker, messageListener, errorListener };
    worker.addEventListener('message', messageListener);
    worker.addEventListener('error', errorListener);
    job.workers.add(activeWorker);
    const message: SliceWorkerRequestMessage = {
      type: 'slice',
      generation: job.generation,
      partitionIndex: partition.partitionIndex,
      positions: partition.positions,
      indices: partition.indices,
      planes: partition.planes,
      deadlineCheckInterval: request.deadlineCheckInterval,
      deadlineAt: request.deadlineAt,
    };
    worker.postMessage(message, [
      partition.positions.buffer,
      partition.indices.buffer,
      partition.planes.buffer,
    ]);
  }

  #releaseWorker(job: ActiveJob, active: ActiveWorker): void {
    active.worker.removeEventListener('message', active.messageListener);
    active.worker.removeEventListener('error', active.errorListener);
    active.worker.terminate();
    job.workers.delete(active);
  }

  #completeJob(job: ActiveJob): void {
    if (job.settled) return;
    try {
      const result = mergePartitionResults([...job.results.values()], job.totalPlanes);
      job.settled = true;
      if (job.timeout !== undefined) clearTimeout(job.timeout);
      for (const worker of [...job.workers]) this.#releaseWorker(job, worker);
      if (this.#activeJob === job) this.#activeJob = undefined;
      job.resolve(result);
    } catch (error) {
      this.#failJob(job, error instanceof SliceWorkerPoolError
        ? error
        : new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker results could not be merged'));
    }
  }

  #failJob(job: ActiveJob, error: SliceWorkerPoolError): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timeout !== undefined) clearTimeout(job.timeout);
    for (const worker of [...job.workers]) this.#releaseWorker(job, worker);
    if (this.#activeJob === job) this.#activeJob = undefined;
    job.reject(error);
  }

  #abortActive(error: SliceWorkerPoolError): void {
    const job = this.#activeJob;
    if (!job) return;
    this.#failJob(job, error);
  }
}

function createBrowserSliceWorker(): SliceWorkerLike {
  return new Worker(new URL('./slice.worker.ts', import.meta.url), { type: 'module' });
}

function validatePoolRequest(request: SliceWorkerPoolRequest): void {
  if (request === null || typeof request !== 'object'
    || !isExactFullSpanTypedArray(request.positions, Float32Array.prototype)
    || !isExactFullSpanTypedArray(request.indices, Uint32Array.prototype)
    || !isExactFullSpanTypedArray(request.planes, Float64Array.prototype)
    || request.positions.buffer === request.indices.buffer
    || request.positions.buffer === request.planes.buffer
    || request.indices.buffer === request.planes.buffer
    || request.positions.length % 3 !== 0
    || request.indices.length % 3 !== 0
    || request.positions.length / 3 > MAX_VERTEX_COUNT
    || request.indices.length / 3 > MAX_TRIANGLE_COUNT
    || request.planes.length > MAX_PLANE_COUNT
    || request.indices.length / 3 * request.planes.length > MAX_PLANE_TRIANGLE_TESTS
    || !Number.isSafeInteger(request.deadlineCheckInterval)
    || request.deadlineCheckInterval < 1
    || request.deadlineCheckInterval > 4_096
    || !Number.isFinite(request.deadlineAt)
    || !Number.isSafeInteger(request.deadlineAt)) {
    throw new SliceWorkerPoolError('INVALID_REQUEST', 'Slice worker request was rejected');
  }
}

function isExactFullSpanTypedArray(
  value: Float32Array | Float64Array | Uint32Array,
  expectedPrototype: object,
): boolean {
  try {
    if (Object.getPrototypeOf(value) !== expectedPrototype
      || Object.getPrototypeOf(value.buffer) !== ArrayBuffer.prototype
      || value.byteOffset !== 0
      || value.byteLength !== value.buffer.byteLength) return false;
    return typeof arrayBufferResizableGetter !== 'function'
      || Reflect.apply(arrayBufferResizableGetter, value.buffer, []) === false;
  } catch {
    return false;
  }
}

function consumePoolRequest(request: SliceWorkerPoolRequest): void {
  if (typeof structuredCloneIntrinsic !== 'function') {
    throw new SliceWorkerPoolError('INVALID_REQUEST', 'Slice worker ownership transfer is unavailable');
  }
  const buffers = [
    request.positions.buffer,
    request.indices.buffer,
    request.planes.buffer,
  ] as ArrayBuffer[];
  try {
    structuredCloneIntrinsic(null, { transfer: buffers });
    if (buffers.some((buffer) => !isDetached(buffer))) throw new Error('source remained attached');
  } catch {
    throw new SliceWorkerPoolError('INVALID_REQUEST', 'Slice worker ownership transfer failed');
  }
}

function isDetached(buffer: ArrayBuffer): boolean {
  try {
    if (typeof arrayBufferByteLengthGetter !== 'function' || typeof arrayBufferSlice !== 'function') return false;
    if (Reflect.apply(arrayBufferByteLengthGetter, buffer, []) !== 0) return false;
    Reflect.apply(arrayBufferSlice, buffer, [0, 0]);
    return false;
  } catch {
    return true;
  }
}

function asPoolRequestError(error: unknown): SliceWorkerPoolError {
  return error instanceof SliceWorkerPoolError
    ? error
    : new SliceWorkerPoolError('INVALID_REQUEST', 'Slice worker request was rejected');
}

function isWorkerErrorMessage(
  message: unknown,
  expected: ExpectedPartition,
  generation: number,
): message is SliceWorkerErrorMessage {
  if (!isRecord(message) || message.type !== 'slice-error') return false;
  if (!hasExactOwnDataKeys(message, [
    'type', 'generation', 'partitionIndex', 'code',
  ])) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker error protocol was rejected');
  }
  if (message.generation !== generation || message.partitionIndex !== expected.partitionIndex
    || typeof message.code !== 'string' || !WORKER_ERROR_CODES.has(message.code)) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker error protocol was rejected');
  }
  return true;
}

const WORKER_ERROR_CODES: ReadonlySet<string> = new Set([
  'LOAD_FAILED', 'EXECUTION_FAILED', 'INVALID_REQUEST', 'INVALID_RESULT', 'RESOURCE_LIMIT',
  'DEADLINE_CHECK_FAILED', 'DEADLINE_EXCEEDED', 'CANCELLED', 'DISPOSED',
]);

function mapWorkerError(
  code: SliceWorkerErrorMessage['code'],
  trustedOperation: boolean,
): SliceWorkerPoolError {
  switch (code) {
    case 'LOAD_FAILED': return fallbackPoolError(
      'LOAD_FAILED',
      'Slice worker WASM could not be loaded',
      trustedOperation,
    );
    case 'EXECUTION_FAILED':
      return fallbackPoolError('EXECUTION_FAILED', 'Slice worker execution failed', trustedOperation);
    case 'RESOURCE_LIMIT':
      return fallbackPoolError(
        'RESOURCE_LIMIT',
        'Slice worker resource limit was exceeded',
        trustedOperation,
      );
    case 'DEADLINE_EXCEEDED': return new SliceWorkerPoolError('DEADLINE_EXCEEDED', 'Slice worker deadline was exceeded');
    case 'CANCELLED': return new SliceWorkerPoolError('CANCELLED', 'Slice worker job was cancelled');
    default: return new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker result was rejected');
  }
}

function validateWorkerResult(
  message: unknown,
  expected: ExpectedPartition,
  generation: number,
): ValidatedPartitionResult {
  if (!isRecord(message) || message.type !== 'slice-result'
    || !hasExactOwnDataKeys(message, [
      'type', 'generation', 'partitionIndex', 'version', 'statusCode',
      'planeOffsets', 'endpoints', 'diagnosticCounters',
    ])
    || message.generation !== generation
    || message.partitionIndex !== expected.partitionIndex
    || message.version !== SLICE_RESULT_VERSION
    || (message.statusCode !== SLICE_STATUS_OK && message.statusCode !== SLICE_STATUS_GEOMETRY_EVIDENCE)
    || !isExactFullSpanTypedArray(message.planeOffsets as Uint32Array, Uint32Array.prototype)
    || !isExactFullSpanTypedArray(message.endpoints as Float64Array, Float64Array.prototype)
    || !isExactFullSpanTypedArray(message.diagnosticCounters as Uint32Array, Uint32Array.prototype)) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker result protocol was rejected');
  }
  const planeOffsets = message.planeOffsets as Uint32Array;
  const endpoints = message.endpoints as Float64Array;
  const diagnosticCounters = message.diagnosticCounters as Uint32Array;
  const segmentCount = endpoints.length / 4;
  const work = expected.triangleCount * expected.planeCount;
  const maximumCheckpointCount = work + expected.planeCount;
  if (planeOffsets.length !== expected.planeCount + 1
    || endpoints.length % 4 !== 0
    || diagnosticCounters.length !== 9
    || planeOffsets[0] !== 0
    || planeOffsets.at(-1) !== segmentCount
    || diagnosticCounters[0] > expected.triangleCount
    || diagnosticCounters[1] > work
    || diagnosticCounters[2] !== 0
    || diagnosticCounters[3] !== work
    || diagnosticCounters[4] !== segmentCount
    || diagnosticCounters[5] > maximumCheckpointCount
    || diagnosticCounters[6] > work
    || diagnosticCounters[7] > work
    || diagnosticCounters[8] > (segmentCount === 0 ? 0 : segmentCount)) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker result was inconsistent');
  }
  let previous = 0;
  for (const offset of planeOffsets) {
    if (offset < previous || offset > segmentCount) {
      throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker offsets were inconsistent');
    }
    previous = offset;
  }
  for (const endpoint of endpoints) {
    if (!Number.isFinite(endpoint)) {
      throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker endpoints were non-finite');
    }
  }
  const hasEvidence = diagnosticCounters[0] > 0 || diagnosticCounters[1] > 0
    || diagnosticCounters[6] > 0 || diagnosticCounters[7] > 0;
  if ((message.statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) !== hasEvidence) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker status was inconsistent');
  }
  return Object.freeze({
    expected,
    statusCode: message.statusCode,
    planeOffsets,
    endpoints,
    diagnosticCounters,
  });
}

function mergePartitionResults(
  results: readonly ValidatedPartitionResult[],
  planeCount: number,
): SliceBatchResult {
  const byPlane = new Array<{
    readonly source: Float64Array;
    readonly start: number;
    readonly end: number;
  } | undefined>(planeCount);
  const diagnostics = new Uint32Array(9);
  let statusCode: SliceBatchResult['statusCode'] = SLICE_STATUS_OK;
  let totalEndpointValues = 0;
  for (const result of [...results].sort((left, right) => (
    left.expected.partitionIndex - right.expected.partitionIndex
  ))) {
    if (result.statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) statusCode = SLICE_STATUS_GEOMETRY_EVIDENCE;
    for (let counter = 0; counter < diagnostics.length; counter += 1) {
      const sum = diagnostics[counter] + result.diagnosticCounters[counter];
      if (!Number.isSafeInteger(sum) || sum > 0xffff_ffff) {
        throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker diagnostics overflowed');
      }
      diagnostics[counter] = sum;
    }
    for (let localPlane = 0; localPlane < result.expected.planeCount; localPlane += 1) {
      const globalPlane = result.expected.planeIndices[localPlane];
      if (globalPlane >= planeCount || byPlane[globalPlane] !== undefined) {
        throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker plane coverage was invalid');
      }
      const start = result.planeOffsets[localPlane] * 4;
      const end = result.planeOffsets[localPlane + 1] * 4;
      byPlane[globalPlane] = { source: result.endpoints, start, end };
      totalEndpointValues += end - start;
    }
  }
  if (byPlane.some((values) => values === undefined)) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker plane coverage was incomplete');
  }
  if (totalEndpointValues * Float64Array.BYTES_PER_ELEMENT > MAX_MERGED_ENDPOINT_BYTES) {
    throw new SliceWorkerPoolError('PROTOCOL_ERROR', 'Slice worker merged result exceeded its allocation cap');
  }
  const offsets = new Uint32Array(planeCount + 1);
  const endpoints = new Float64Array(totalEndpointValues);
  let writeOffset = 0;
  for (let planeIndex = 0; planeIndex < planeCount; planeIndex += 1) {
    const values = byPlane[planeIndex] as NonNullable<(typeof byPlane)[number]>;
    endpoints.set(values.source.subarray(values.start, values.end), writeOffset);
    writeOffset += values.end - values.start;
    offsets[planeIndex + 1] = writeOffset / 4;
  }
  diagnostics[4] = totalEndpointValues / 4;
  return Object.freeze({
    version: SLICE_RESULT_VERSION,
    statusCode,
    planeOffsets: new ImmutablePoolSliceArray(offsets, 'uint32'),
    endpoints: new ImmutablePoolSliceArray(endpoints, 'float64'),
    diagnosticCounters: new ImmutablePoolSliceArray(diagnostics, 'uint32'),
  });
}

function emptySliceResult(): SliceBatchResult {
  return Object.freeze({
    version: SLICE_RESULT_VERSION,
    statusCode: SLICE_STATUS_OK,
    planeOffsets: new ImmutablePoolSliceArray(new Uint32Array([0]), 'uint32'),
    endpoints: new ImmutablePoolSliceArray(new Float64Array(), 'float64'),
    diagnosticCounters: new ImmutablePoolSliceArray(new Uint32Array(9), 'uint32'),
  });
}

class ImmutablePoolSliceArray implements ReadonlySliceArray {
  readonly elementType: 'uint32' | 'float64';
  readonly length: number;
  readonly byteLength: number;
  readonly #values: Uint32Array | Float64Array;

  constructor(values: Uint32Array | Float64Array, elementType: 'uint32' | 'float64') {
    this.#values = values;
    this.elementType = elementType;
    this.length = values.length;
    this.byteLength = values.byteLength;
    Object.freeze(this);
  }

  at(index: number): number | undefined { return this.#values.at(index); }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let index = 0; index < this.#values.length; index += 1) yield this.#values[index];
  }
}
Object.freeze(ImmutablePoolSliceArray.prototype);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasExactOwnDataKeys(value: object, expectedKeys: readonly string[]): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return false;
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    });
  } catch {
    return false;
  }
}
