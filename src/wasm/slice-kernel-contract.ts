export const SLICE_RESULT_VERSION = 1 as const;
export const SLICE_STATUS_OK = 0 as const;
export const SLICE_STATUS_GEOMETRY_EVIDENCE = 1 as const;

const MAX_VERTEX_COUNT = 3_145_728;
const MAX_TRIANGLE_COUNT = 1_048_576;
const MAX_PLANE_COUNT = 16_384;
const MAX_PLANE_TRIANGLE_TESTS = 250_000_000;
const MAX_SEGMENT_COUNT = 262_144;
const MAX_ENDPOINT_VALUE_COUNT = MAX_SEGMENT_COUNT * 4;
const MAX_DEADLINE_CHECK_INTERVAL = 4_096;
const MAX_OWNED_ARRAY_BYTES = 8 * 1024 * 1024;
const DIAGNOSTIC_COUNTER_COUNT = 9;

const DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT = 0;
const DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT = 1;
const DIAGNOSTIC_NON_FINITE_INPUT_COUNT = 2;
const DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT = 3;
const DIAGNOSTIC_SEGMENT_COUNT = 4;
const DIAGNOSTIC_CHECKPOINT_COUNT = 5;
const DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT = 6;
const DIAGNOSTIC_ON_PLANE_EDGE_COUNT = 7;
const DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT = 8;
const validatedRequests = new WeakSet<SliceBatchRequest>();

export type SliceKernelErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESULT'
  | 'RESOURCE_LIMIT'
  | 'LOAD_FAILED'
  | 'EXECUTION_FAILED'
  | 'DEADLINE_CHECK_FAILED'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'DISPOSED'
  | 'FALLBACK_NOT_ALLOWED'
  | 'PUBLICATION_CONFLICT';

export class SliceKernelError extends Error {
  readonly code: SliceKernelErrorCode;
  readonly abortReason: SliceKernelAbortReason | undefined;
  readonly abortSource: SliceKernelAbortSource | undefined;

  constructor(code: SliceKernelErrorCode, message: string, abort?: SliceKernelAbort) {
    super(message);
    this.name = 'SliceKernelError';
    this.code = code;
    this.abortReason = abort?.reason;
    this.abortSource = abort?.source;
  }
}

export interface SliceBatchRequest {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly planes: Float64Array;
  readonly deadlineCheckInterval: number;
}

export type SliceKernelAbortReason = 'cancelled' | 'deadline';
export type SliceKernelAbortSource = 'user' | 'superseded' | 'runtime-deadline';
export type SliceKernelAbort =
  | Readonly<{ reason: 'cancelled'; source: 'user' | 'superseded' }>
  | Readonly<{ reason: 'deadline'; source: 'runtime-deadline' }>;
export type SliceKernelCheckpoint = () => SliceKernelAbort | undefined;

export interface ReadonlySliceArray extends Iterable<number> {
  readonly elementType: 'uint32' | 'float64';
  readonly length: number;
  readonly byteLength: number;
  at(index: number): number | undefined;
}

export interface SliceBatchResult {
  readonly version: typeof SLICE_RESULT_VERSION;
  readonly statusCode: typeof SLICE_STATUS_OK | typeof SLICE_STATUS_GEOMETRY_EVIDENCE;
  readonly planeOffsets: ReadonlySliceArray;
  readonly endpoints: ReadonlySliceArray;
  readonly diagnosticCounters: ReadonlySliceArray;
}

export interface SliceKernel {
  sliceLayerBatch(
    request: SliceBatchRequest,
    checkpoint: SliceKernelCheckpoint,
  ): Promise<SliceBatchResult>;
  dispose(): void;
}

function fail(code: SliceKernelErrorCode, message: string): never {
  throw new SliceKernelError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function requireStrictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(code, `${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    || expectedKeys.some((key) => !Object.hasOwn(value, key))) {
    fail(code, `${name} does not match the strict schema`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      fail(code, `${name} must contain data properties only`);
    }
  }
}

function requireExactTypedArray<T extends Float32Array | Float64Array | Uint32Array>(
  value: unknown,
  constructor: { new(length: number): T; readonly BYTES_PER_ELEMENT: number },
  name: string,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
): T {
  if (!(value instanceof constructor) || value.constructor !== constructor) {
    fail(code, `${name} has an invalid typed-array representation`);
  }
  if (!(value.buffer instanceof ArrayBuffer)) {
    fail(code, `${name} must use an owned non-shared ArrayBuffer`);
  }
  return value;
}

function checkOwnedArrayCap(
  value: Float32Array | Float64Array | Uint32Array,
  name: string,
): void {
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength > MAX_OWNED_ARRAY_BYTES) {
    fail('RESOURCE_LIMIT', `${name} exceeds the approved allocation limit`);
  }
}

class ImmutableSliceArray implements ReadonlySliceArray {
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

  at(index: number): number | undefined {
    return this.#values.at(index);
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this.#values.values();
  }
}

export function readSliceKernelAbort(checkpoint: SliceKernelCheckpoint): SliceKernelAbort | undefined {
  if (typeof checkpoint !== 'function') {
    fail('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
  }
  let abort: unknown;
  try {
    abort = checkpoint();
  } catch {
    fail('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
  }
  if (abort === undefined) return undefined;
  if (!isRecord(abort)) {
    fail('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
  }
  const keys = Reflect.ownKeys(abort);
  const reasonDescriptor = Object.getOwnPropertyDescriptor(abort, 'reason');
  const sourceDescriptor = Object.getOwnPropertyDescriptor(abort, 'source');
  if ((Object.getPrototypeOf(abort) !== Object.prototype && Object.getPrototypeOf(abort) !== null)
    || keys.length !== 2
    || !keys.includes('reason')
    || !keys.includes('source')
    || !reasonDescriptor
    || !('value' in reasonDescriptor)
    || !sourceDescriptor
    || !('value' in sourceDescriptor)) {
    fail('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
  }
  const reason = reasonDescriptor.value;
  const source = sourceDescriptor.value;
  if ((reason === 'cancelled' && (source === 'user' || source === 'superseded'))
    || (reason === 'deadline' && source === 'runtime-deadline')) {
    return Object.freeze({ reason, source }) as SliceKernelAbort;
  }
  fail('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
}

export function sliceKernelAbortError(abort: SliceKernelAbort): SliceKernelError {
  return abort.reason === 'cancelled'
    ? new SliceKernelError('CANCELLED', 'WASM geometry operation was cancelled', abort)
    : new SliceKernelError('DEADLINE_EXCEEDED', 'WASM geometry deadline was exceeded', abort);
}

function checkCheckpoint(checkpoint: SliceKernelCheckpoint): void {
  const abort = readSliceKernelAbort(checkpoint);
  if (abort) throw sliceKernelAbortError(abort);
}

function forEachChunked<T extends Float32Array | Float64Array | Uint32Array>(
  values: T,
  interval: number,
  checkpoint: SliceKernelCheckpoint,
  visit: (value: number, index: number) => void,
): void {
  for (let start = 0; start < values.length; start += interval) {
    checkCheckpoint(checkpoint);
    const end = Math.min(start + interval, values.length);
    for (let index = start; index < end; index += 1) visit(values[index], index);
  }
}

export function validateSliceBatchRequest(
  value: unknown,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchRequest {
  requireStrictRecord(
    value,
    ['positions', 'indices', 'planes', 'deadlineCheckInterval'],
    'INVALID_REQUEST',
    'slice request',
  );

  const positions = requireExactTypedArray(
    value.positions,
    Float32Array,
    'positions',
    'INVALID_REQUEST',
  );
  const indices = requireExactTypedArray(
    value.indices,
    Uint32Array,
    'indices',
    'INVALID_REQUEST',
  );
  const planes = requireExactTypedArray(
    value.planes,
    Float64Array,
    'planes',
    'INVALID_REQUEST',
  );
  const deadlineCheckInterval = value.deadlineCheckInterval;

  if (!Number.isSafeInteger(deadlineCheckInterval)
    || (deadlineCheckInterval as number) <= 0
    || (deadlineCheckInterval as number) > MAX_DEADLINE_CHECK_INTERVAL) {
    fail('INVALID_REQUEST', 'deadline check interval is invalid');
  }
  const interval = deadlineCheckInterval as number;
  if (positions.length % 3 !== 0 || indices.length % 3 !== 0) {
    fail('INVALID_REQUEST', 'slice request contains incomplete vertices or triangles');
  }
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  if (vertexCount > MAX_VERTEX_COUNT
    || triangleCount > MAX_TRIANGLE_COUNT
    || planes.length > MAX_PLANE_COUNT) {
    fail('RESOURCE_LIMIT', 'slice request exceeds a kernel count limit');
  }
  const work = triangleCount * planes.length;
  if (!Number.isSafeInteger(work) || work > MAX_PLANE_TRIANGLE_TESTS) {
    fail('RESOURCE_LIMIT', 'slice request exceeds the kernel work limit');
  }

  checkCheckpoint(checkpoint);
  forEachChunked(positions, interval, checkpoint, (position) => {
    if (!Number.isFinite(position)) fail('INVALID_REQUEST', 'positions must be finite');
  });
  forEachChunked(indices, interval, checkpoint, (index) => {
    if (index >= vertexCount) fail('INVALID_REQUEST', 'triangle index is out of range');
  });
  forEachChunked(planes, interval, checkpoint, (plane, index) => {
    if (!Number.isFinite(plane) || (index > 0 && plane <= planes[index - 1])) {
      fail('INVALID_REQUEST', 'planes must be finite and strictly increasing');
    }
  });

  const validated = Object.freeze({ positions, indices, planes, deadlineCheckInterval: interval });
  validatedRequests.add(validated);
  return validated;
}

function requireSafeInteger(
  value: unknown,
  name: string,
  allowed?: readonly number[],
): number {
  if (!Number.isSafeInteger(value) || (allowed && !allowed.includes(value as number))) {
    fail('INVALID_RESULT', `${name} is invalid`);
  }
  return value as number;
}

export function parseSliceBatchResult(
  value: unknown,
  requestValue: SliceBatchRequest,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchResult {
  const request = validatedRequests.has(requestValue)
    ? requestValue
    : validateSliceBatchRequest(requestValue, checkpoint);
  requireStrictRecord(
    value,
    ['version', 'statusCode', 'planeOffsets', 'endpoints', 'diagnosticCounters'],
    'INVALID_RESULT',
    'slice result',
  );

  const version = requireSafeInteger(value.version, 'slice result version', [SLICE_RESULT_VERSION]);
  const statusCode = requireSafeInteger(
    value.statusCode,
    'slice result status',
    [SLICE_STATUS_OK, SLICE_STATUS_GEOMETRY_EVIDENCE],
  );
  const planeOffsets = requireExactTypedArray(
    value.planeOffsets,
    Uint32Array,
    'plane offsets',
    'INVALID_RESULT',
  );
  const endpoints = requireExactTypedArray(
    value.endpoints,
    Float64Array,
    'endpoints',
    'INVALID_RESULT',
  );
  const diagnosticCounters = requireExactTypedArray(
    value.diagnosticCounters,
    Uint32Array,
    'diagnostic counters',
    'INVALID_RESULT',
  );

  checkOwnedArrayCap(planeOffsets, 'plane offsets');
  checkOwnedArrayCap(endpoints, 'endpoints');
  checkOwnedArrayCap(diagnosticCounters, 'diagnostic counters');
  if (planeOffsets.length !== request.planes.length + 1) {
    fail('INVALID_RESULT', 'plane offset count does not match the request');
  }
  if (endpoints.length > MAX_ENDPOINT_VALUE_COUNT || endpoints.length % 4 !== 0) {
    fail('INVALID_RESULT', 'endpoint length is invalid');
  }
  if (diagnosticCounters.length !== DIAGNOSTIC_COUNTER_COUNT) {
    fail('INVALID_RESULT', 'diagnostic counter count is invalid');
  }

  const segmentCount = endpoints.length / 4;
  if (planeOffsets[0] !== 0) fail('INVALID_RESULT', 'plane offsets must start at zero');
  forEachChunked(planeOffsets, request.deadlineCheckInterval, checkpoint, (offset, index) => {
    if (index > 0 && (offset < planeOffsets[index - 1] || offset > segmentCount)) {
      fail('INVALID_RESULT', 'plane offsets must be bounded and monotonic');
    }
  });
  if (planeOffsets[planeOffsets.length - 1] !== segmentCount) {
    fail('INVALID_RESULT', 'final plane offset does not match endpoint segments');
  }
  forEachChunked(endpoints, request.deadlineCheckInterval, checkpoint, (endpoint) => {
    if (!Number.isFinite(endpoint)) fail('INVALID_RESULT', 'endpoints must be finite');
  });

  const triangleCount = request.indices.length / 3;
  const work = triangleCount * request.planes.length;
  const maxCheckpointCount = work + request.planes.length;
  if (diagnosticCounters[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT] > triangleCount
    || diagnosticCounters[DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT] > work
    || diagnosticCounters[DIAGNOSTIC_NON_FINITE_INPUT_COUNT] !== 0
    || diagnosticCounters[DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT] !== work
    || diagnosticCounters[DIAGNOSTIC_SEGMENT_COUNT] !== segmentCount
    || diagnosticCounters[DIAGNOSTIC_CHECKPOINT_COUNT] > maxCheckpointCount
    || diagnosticCounters[DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT] > work
    || diagnosticCounters[DIAGNOSTIC_ON_PLANE_EDGE_COUNT] > work
    || diagnosticCounters[DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT]
      > (segmentCount === 0 ? 0 : segmentCount)) {
    fail('INVALID_RESULT', 'diagnostic counters are inconsistent or overflowed');
  }
  const hasGeometryEvidence = diagnosticCounters[DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT] > 0
    || diagnosticCounters[DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT] > 0
    || diagnosticCounters[DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT] > 0
    || diagnosticCounters[DIAGNOSTIC_ON_PLANE_EDGE_COUNT] > 0;
  if ((statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) !== hasGeometryEvidence) {
    fail('INVALID_RESULT', 'slice status does not match diagnostic evidence');
  }

  return Object.freeze({
    version: version as typeof SLICE_RESULT_VERSION,
    statusCode: statusCode as SliceBatchResult['statusCode'],
    planeOffsets: new ImmutableSliceArray(planeOffsets, 'uint32'),
    endpoints: new ImmutableSliceArray(endpoints, 'float64'),
    diagnosticCounters: new ImmutableSliceArray(diagnosticCounters, 'uint32'),
  });
}

const FALLBACK_ELIGIBLE_CODES: ReadonlySet<SliceKernelErrorCode> = new Set([
  'LOAD_FAILED',
  'EXECUTION_FAILED',
  'INVALID_RESULT',
  'RESOURCE_LIMIT',
]);

declare const canonicalPublicationTokenBrand: unique symbol;
export interface CanonicalPublicationToken {
  readonly [canonicalPublicationTokenBrand]: never;
}

type PublicationState = 'idle' | 'wasm_claimed' | 'fallback_claimed' | 'published';

export class CanonicalFallbackGuard {
  #state: PublicationState = 'idle';
  #activeToken: CanonicalPublicationToken | undefined;

  claimWasmPublication(): CanonicalPublicationToken {
    return this.#claim('wasm_claimed');
  }

  claimTypeScriptFallback(error: unknown): CanonicalPublicationToken {
    if (!(error instanceof SliceKernelError) || !FALLBACK_ELIGIBLE_CODES.has(error.code)) {
      fail('FALLBACK_NOT_ALLOWED', 'TypeScript compatibility fallback is not allowed');
    }
    return this.#claim('fallback_claimed');
  }

  publishCanonicalResult<T>(token: CanonicalPublicationToken, publisher: () => T): T {
    if (typeof publisher !== 'function') {
      fail('INVALID_REQUEST', 'canonical result publisher must be a function');
    }
    if ((this.#state !== 'wasm_claimed' && this.#state !== 'fallback_claimed')
      || token !== this.#activeToken) {
      fail('PUBLICATION_CONFLICT', 'canonical publication token is late, forged, or duplicate');
    }
    this.#state = 'published';
    this.#activeToken = undefined;
    return publisher();
  }

  #claim(nextState: 'wasm_claimed' | 'fallback_claimed'): CanonicalPublicationToken {
    if (this.#state !== 'idle') {
      fail('PUBLICATION_CONFLICT', 'canonical publication has already been claimed');
    }
    const token = Object.freeze({}) as CanonicalPublicationToken;
    this.#state = nextState;
    this.#activeToken = token;
    return token;
  }
}
