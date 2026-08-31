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

const FALLBACK_CAPABILITY = Object.freeze({});
const FALLBACK_ELIGIBLE_CODES: ReadonlySet<SliceKernelErrorCode> = new Set([
  'LOAD_FAILED',
  'EXECUTION_FAILED',
  'INVALID_RESULT',
  'RESOURCE_LIMIT',
]);
const fallbackEligibleErrors = new WeakSet<object>();

export class SliceKernelError extends Error {
  readonly code: SliceKernelErrorCode;
  readonly abortReason: SliceKernelAbortReason | undefined;
  readonly abortSource: SliceKernelAbortSource | undefined;
  readonly fallbackEligible: boolean;

  constructor(
    code: SliceKernelErrorCode,
    message: string,
    abort?: SliceKernelAbort,
    capability?: unknown,
  ) {
    super(message);
    this.name = 'SliceKernelError';
    this.code = code;
    this.abortReason = abort?.reason;
    this.abortSource = abort?.source;
    this.fallbackEligible = new.target === SliceKernelError
      && capability === FALLBACK_CAPABILITY
      && FALLBACK_ELIGIBLE_CODES.has(code);
    if (this.fallbackEligible) fallbackEligibleErrors.add(this);
    Object.freeze(this);
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

function createFallbackEligibleError(
  code: 'LOAD_FAILED' | 'EXECUTION_FAILED' | 'INVALID_RESULT' | 'RESOURCE_LIMIT',
  message: string,
): SliceKernelError {
  return new SliceKernelError(code, message, undefined, FALLBACK_CAPABILITY);
}

function failOrdinaryResult(
  code: 'INVALID_RESULT' | 'RESOURCE_LIMIT',
  message: string,
): never {
  throw createFallbackEligibleError(code, message);
}

/** @internal Only the controlled production loader may map a completed boundary phase. */
export function createSliceKernelRuntimeError(
  code: SliceKernelErrorCode,
  message: string,
): SliceKernelError {
  switch (code) {
    case 'LOAD_FAILED':
    case 'EXECUTION_FAILED':
    case 'INVALID_RESULT':
    case 'RESOURCE_LIMIT':
      return createFallbackEligibleError(code, message);
    default:
      return new SliceKernelError(code, message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function failInspection(
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
  name: string,
): never {
  fail(code, `${name} failed strict boundary inspection`);
}

function requireStrictRecord<Key extends string>(
  value: unknown,
  expectedKeys: readonly Key[],
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
  name: string,
): ReadonlyMap<Key, unknown> {
  try {
    if (!isRecord(value)) throw new TypeError('not a record');
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key as Key))) {
      throw new TypeError('invalid strict record shape');
    }
    const snapshot = new Map<Key, unknown>();
    for (const key of expectedKeys) {
      if (!Object.hasOwn(value, key)) throw new TypeError('missing strict record key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('strict record accessor');
      }
      snapshot.set(key, descriptor.value);
    }
    return snapshot;
  } catch {
    failInspection(code, name);
  }
}

const reflectApply = Reflect.apply;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const typedArrayPrototype = objectGetPrototypeOf(Uint8Array.prototype);
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayValues = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'values')?.value;
const typedArrayAt = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'at')?.value;
const typedArraySet = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'set')?.value;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'resizable',
)?.get;
const Float32ArrayIntrinsic = Float32Array;
const Float64ArrayIntrinsic = Float64Array;
const Uint32ArrayIntrinsic = Uint32Array;
const forbiddenTypedArrayOwnKeys = [
  'constructor',
  'buffer',
  'length',
  'byteLength',
  'byteOffset',
  'subarray',
  'values',
  'at',
  Symbol.iterator,
] as const;

interface ExactTypedArray<T extends Float32Array | Float64Array | Uint32Array> {
  readonly value: T;
  readonly length: number;
  readonly byteLength: number;
}

interface ExactTypedArraySpec<T extends Float32Array | Float64Array | Uint32Array> {
  readonly prototype: object;
  readonly bytesPerElement: number;
  create(length: number): T;
}

const float32ArraySpec: ExactTypedArraySpec<Float32Array> = Object.freeze({
  prototype: Float32ArrayIntrinsic.prototype,
  bytesPerElement: Float32ArrayIntrinsic.BYTES_PER_ELEMENT,
  create: (length: number) => new Float32ArrayIntrinsic(length),
});
const float64ArraySpec: ExactTypedArraySpec<Float64Array> = Object.freeze({
  prototype: Float64ArrayIntrinsic.prototype,
  bytesPerElement: Float64ArrayIntrinsic.BYTES_PER_ELEMENT,
  create: (length: number) => new Float64ArrayIntrinsic(length),
});
const uint32ArraySpec: ExactTypedArraySpec<Uint32Array> = Object.freeze({
  prototype: Uint32ArrayIntrinsic.prototype,
  bytesPerElement: Uint32ArrayIntrinsic.BYTES_PER_ELEMENT,
  create: (length: number) => new Uint32ArrayIntrinsic(length),
});

function inspectExactTypedArray<T extends Float32Array | Float64Array | Uint32Array>(
  value: unknown,
  spec: ExactTypedArraySpec<T>,
  name: string,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
): ExactTypedArray<T> {
  try {
    if (!isRecord(value)
      || typeof typedArrayLengthGetter !== 'function'
      || typeof typedArrayBufferGetter !== 'function'
      || typeof typedArrayByteLengthGetter !== 'function'
      || typeof typedArrayByteOffsetGetter !== 'function'
      || typeof typedArrayValues !== 'function'
      || typeof typedArrayAt !== 'function'
      || typeof typedArraySet !== 'function'
      || typeof arrayBufferByteLengthGetter !== 'function'
      || objectGetPrototypeOf(value) !== spec.prototype
      || forbiddenTypedArrayOwnKeys.some((key) => objectHasOwn(value, key))) {
      throw new TypeError('invalid exact typed array');
    }
    const length = reflectApply(typedArrayLengthGetter, value, []) as unknown;
    const buffer = reflectApply(typedArrayBufferGetter, value, []) as unknown;
    const byteLength = reflectApply(typedArrayByteLengthGetter, value, []) as unknown;
    const byteOffset = reflectApply(typedArrayByteOffsetGetter, value, []) as unknown;
    reflectApply(typedArrayAt, value, [0]);
    const bufferByteLength = reflectApply(arrayBufferByteLengthGetter, buffer, []) as unknown;
    const resizable = typeof arrayBufferResizableGetter === 'function'
      ? reflectApply(arrayBufferResizableGetter, buffer, []) as unknown
      : false;
    const bytesPerElement = spec.bytesPerElement;
    if (!Number.isSafeInteger(length)
      || !Number.isSafeInteger(byteLength)
      || !Number.isSafeInteger(byteOffset)
      || !Number.isSafeInteger(bufferByteLength)
      || (length as number) < 0
      || (byteLength as number) < 0
      || (byteOffset as number) !== 0
      || (byteOffset as number) % bytesPerElement !== 0
      || (byteLength as number) !== (length as number) * bytesPerElement
      || (byteLength as number) !== bufferByteLength
      || resizable !== false) {
      throw new TypeError('invalid owned typed array span');
    }
    return Object.freeze({
      value: value as T,
      length: length as number,
      byteLength: byteLength as number,
    });
  } catch {
    failInspection(code, name);
  }
}

function defensiveCopy<T extends Float32Array | Float64Array | Uint32Array>(
  inspected: ExactTypedArray<T>,
  spec: ExactTypedArraySpec<T>,
  name: string,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
): T {
  try {
    if (typeof typedArraySet !== 'function') throw new TypeError('missing typed array set');
    const copy = spec.create(inspected.length);
    reflectApply(typedArraySet, copy, [inspected.value, 0]);
    return copy;
  } catch {
    failInspection(code, name);
  }
}

function checkOwnedArrayCap(
  byteLength: number,
  name: string,
): void {
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_OWNED_ARRAY_BYTES) {
    failOrdinaryResult('RESOURCE_LIMIT', `${name} exceeds the approved allocation limit`);
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
    this.length = reflectApply(typedArrayLengthGetter as Function, values, []) as number;
    this.byteLength = reflectApply(typedArrayByteLengthGetter as Function, values, []) as number;
    Object.freeze(this);
  }

  at(index: number): number | undefined {
    return reflectApply(typedArrayAt, this.#values, [index]) as number | undefined;
  }

  [Symbol.iterator](): IterableIterator<number> {
    return reflectApply(typedArrayValues, this.#values, []) as IterableIterator<number>;
  }
}

export function readSliceKernelAbort(checkpoint: SliceKernelCheckpoint): SliceKernelAbort | undefined {
  try {
    if (typeof checkpoint !== 'function') {
      throw new TypeError('invalid checkpoint');
    }
    const abort: unknown = checkpoint();
    if (abort === undefined) return undefined;
    if (!isRecord(abort)) throw new TypeError('invalid abort result');

    const prototype = Object.getPrototypeOf(abort);
    const keys = Reflect.ownKeys(abort);
    const reasonDescriptor = Object.getOwnPropertyDescriptor(abort, 'reason');
    const sourceDescriptor = Object.getOwnPropertyDescriptor(abort, 'source');
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2
      || !keys.includes('reason')
      || !keys.includes('source')
      || !reasonDescriptor
      || !('value' in reasonDescriptor)
      || !sourceDescriptor
      || !('value' in sourceDescriptor)) {
      throw new TypeError('invalid abort shape');
    }
    const reason = reasonDescriptor.value;
    const source = sourceDescriptor.value;
    if ((reason === 'cancelled' && (source === 'user' || source === 'superseded'))
      || (reason === 'deadline' && source === 'runtime-deadline')) {
      return Object.freeze({ reason, source }) as SliceKernelAbort;
    }
    throw new TypeError('invalid abort reason and source');
  } catch {
    fail('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
  }
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
  length: number,
  interval: number,
  checkpoint: SliceKernelCheckpoint,
  visit: (value: number, index: number) => void,
): void {
  for (let start = 0; start < length; start += interval) {
    checkCheckpoint(checkpoint);
    const end = Math.min(start + interval, length);
    for (let index = start; index < end; index += 1) {
      visit(reflectApply(typedArrayAt, values, [index]) as number, index);
    }
  }
}

export function validateSliceBatchRequest(
  value: unknown,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchRequest {
  const snapshot = requireStrictRecord(
    value,
    ['positions', 'indices', 'planes', 'deadlineCheckInterval'],
    'INVALID_REQUEST',
    'slice request',
  );

  const inspectedPositions = inspectExactTypedArray(
    snapshot.get('positions'),
    float32ArraySpec,
    'positions',
    'INVALID_REQUEST',
  );
  const inspectedIndices = inspectExactTypedArray(
    snapshot.get('indices'),
    uint32ArraySpec,
    'indices',
    'INVALID_REQUEST',
  );
  const inspectedPlanes = inspectExactTypedArray(
    snapshot.get('planes'),
    float64ArraySpec,
    'planes',
    'INVALID_REQUEST',
  );
  const deadlineCheckInterval = snapshot.get('deadlineCheckInterval');

  if (!Number.isSafeInteger(deadlineCheckInterval)
    || (deadlineCheckInterval as number) <= 0
    || (deadlineCheckInterval as number) > MAX_DEADLINE_CHECK_INTERVAL) {
    fail('INVALID_REQUEST', 'deadline check interval is invalid');
  }
  const interval = deadlineCheckInterval as number;
  if (inspectedPositions.length % 3 !== 0 || inspectedIndices.length % 3 !== 0) {
    fail('INVALID_REQUEST', 'slice request contains incomplete vertices or triangles');
  }
  const vertexCount = inspectedPositions.length / 3;
  const triangleCount = inspectedIndices.length / 3;
  if (vertexCount > MAX_VERTEX_COUNT
    || triangleCount > MAX_TRIANGLE_COUNT
    || inspectedPlanes.length > MAX_PLANE_COUNT) {
    fail('RESOURCE_LIMIT', 'slice request exceeds a kernel count limit');
  }
  const work = triangleCount * inspectedPlanes.length;
  if (!Number.isSafeInteger(work) || work > MAX_PLANE_TRIANGLE_TESTS) {
    fail('RESOURCE_LIMIT', 'slice request exceeds the kernel work limit');
  }

  const positions = defensiveCopy(
    inspectedPositions,
    float32ArraySpec,
    'positions',
    'INVALID_REQUEST',
  );
  const indices = defensiveCopy(
    inspectedIndices,
    uint32ArraySpec,
    'indices',
    'INVALID_REQUEST',
  );
  const planes = defensiveCopy(
    inspectedPlanes,
    float64ArraySpec,
    'planes',
    'INVALID_REQUEST',
  );

  checkCheckpoint(checkpoint);
  forEachChunked(positions, inspectedPositions.length, interval, checkpoint, (position) => {
    if (!Number.isFinite(position)) fail('INVALID_REQUEST', 'positions must be finite');
  });
  forEachChunked(indices, inspectedIndices.length, interval, checkpoint, (index) => {
    if (index >= vertexCount) fail('INVALID_REQUEST', 'triangle index is out of range');
  });
  let previousPlane: number | undefined;
  forEachChunked(planes, inspectedPlanes.length, interval, checkpoint, (plane) => {
    if (!Number.isFinite(plane) || (previousPlane !== undefined && plane <= previousPlane)) {
      fail('INVALID_REQUEST', 'planes must be finite and strictly increasing');
    }
    previousPlane = plane;
  });

  return Object.freeze({ positions, indices, planes, deadlineCheckInterval: interval });
}

function requireSafeInteger(
  value: unknown,
  name: string,
  allowed?: readonly number[],
): number {
  if (!Number.isSafeInteger(value) || (allowed && !allowed.includes(value as number))) {
    failOrdinaryResult('INVALID_RESULT', `${name} is invalid`);
  }
  return value as number;
}

export function parseSliceBatchResult(
  value: unknown,
  requestValue: SliceBatchRequest,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchResult {
  const snapshot = requireStrictRecord(
    value,
    ['version', 'statusCode', 'planeOffsets', 'endpoints', 'diagnosticCounters'],
    'INVALID_RESULT',
    'slice result',
  );

  const version = requireSafeInteger(
    snapshot.get('version'),
    'slice result version',
    [SLICE_RESULT_VERSION],
  );
  const statusCode = requireSafeInteger(
    snapshot.get('statusCode'),
    'slice result status',
    [SLICE_STATUS_OK, SLICE_STATUS_GEOMETRY_EVIDENCE],
  );
  const inspectedPlaneOffsets = inspectExactTypedArray(
    snapshot.get('planeOffsets'),
    uint32ArraySpec,
    'plane offsets',
    'INVALID_RESULT',
  );
  const inspectedEndpoints = inspectExactTypedArray(
    snapshot.get('endpoints'),
    float64ArraySpec,
    'endpoints',
    'INVALID_RESULT',
  );
  const inspectedDiagnosticCounters = inspectExactTypedArray(
    snapshot.get('diagnosticCounters'),
    uint32ArraySpec,
    'diagnostic counters',
    'INVALID_RESULT',
  );

  checkOwnedArrayCap(inspectedPlaneOffsets.byteLength, 'plane offsets');
  checkOwnedArrayCap(inspectedEndpoints.byteLength, 'endpoints');
  checkOwnedArrayCap(inspectedDiagnosticCounters.byteLength, 'diagnostic counters');
  if (inspectedEndpoints.length > MAX_ENDPOINT_VALUE_COUNT
    || inspectedEndpoints.length % 4 !== 0) {
    failOrdinaryResult('INVALID_RESULT', 'endpoint length is invalid');
  }
  if (inspectedDiagnosticCounters.length !== DIAGNOSTIC_COUNTER_COUNT) {
    failOrdinaryResult('INVALID_RESULT', 'diagnostic counter count is invalid');
  }

  const planeOffsets = defensiveCopy(
    inspectedPlaneOffsets,
    uint32ArraySpec,
    'plane offsets',
    'INVALID_RESULT',
  );
  const endpoints = defensiveCopy(
    inspectedEndpoints,
    float64ArraySpec,
    'endpoints',
    'INVALID_RESULT',
  );
  const diagnosticCounters = defensiveCopy(
    inspectedDiagnosticCounters,
    uint32ArraySpec,
    'diagnostic counters',
    'INVALID_RESULT',
  );

  const request = validateSliceBatchRequest(requestValue, checkpoint);
  const requestPlaneCount = reflectApply(
    typedArrayLengthGetter as Function,
    request.planes,
    [],
  ) as number;
  const requestIndexCount = reflectApply(
    typedArrayLengthGetter as Function,
    request.indices,
    [],
  ) as number;
  if (inspectedPlaneOffsets.length !== requestPlaneCount + 1) {
    failOrdinaryResult('INVALID_RESULT', 'plane offset count does not match the request');
  }

  const segmentCount = inspectedEndpoints.length / 4;
  if (reflectApply(typedArrayAt, planeOffsets, [0]) !== 0) {
    failOrdinaryResult('INVALID_RESULT', 'plane offsets must start at zero');
  }
  let previousOffset: number | undefined;
  forEachChunked(
    planeOffsets,
    inspectedPlaneOffsets.length,
    request.deadlineCheckInterval,
    checkpoint,
    (offset) => {
      if (previousOffset !== undefined && (offset < previousOffset || offset > segmentCount)) {
        failOrdinaryResult('INVALID_RESULT', 'plane offsets must be bounded and monotonic');
      }
      previousOffset = offset;
    },
  );
  if (reflectApply(typedArrayAt, planeOffsets, [inspectedPlaneOffsets.length - 1])
    !== segmentCount) {
    failOrdinaryResult('INVALID_RESULT', 'final plane offset does not match endpoint segments');
  }
  forEachChunked(
    endpoints,
    inspectedEndpoints.length,
    request.deadlineCheckInterval,
    checkpoint,
    (endpoint) => {
      if (!Number.isFinite(endpoint)) {
        failOrdinaryResult('INVALID_RESULT', 'endpoints must be finite');
      }
    },
  );

  const counter = (index: number): number => reflectApply(
    typedArrayAt,
    diagnosticCounters,
    [index],
  ) as number;
  const triangleCount = requestIndexCount / 3;
  const work = triangleCount * requestPlaneCount;
  const maxCheckpointCount = work + requestPlaneCount;
  if (counter(DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT) > triangleCount
    || counter(DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT) > work
    || counter(DIAGNOSTIC_NON_FINITE_INPUT_COUNT) !== 0
    || counter(DIAGNOSTIC_PLANE_TRIANGLE_TEST_COUNT) !== work
    || counter(DIAGNOSTIC_SEGMENT_COUNT) !== segmentCount
    || counter(DIAGNOSTIC_CHECKPOINT_COUNT) > maxCheckpointCount
    || counter(DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT) > work
    || counter(DIAGNOSTIC_ON_PLANE_EDGE_COUNT) > work
    || counter(DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT)
      > (segmentCount === 0 ? 0 : segmentCount)) {
    failOrdinaryResult('INVALID_RESULT', 'diagnostic counters are inconsistent or overflowed');
  }
  const hasGeometryEvidence = counter(DIAGNOSTIC_DEGENERATE_TRIANGLE_COUNT) > 0
    || counter(DIAGNOSTIC_COPLANAR_TRIANGLE_PLANE_COUNT) > 0
    || counter(DIAGNOSTIC_AMBIGUOUS_INTERSECTION_COUNT) > 0
    || counter(DIAGNOSTIC_ON_PLANE_EDGE_COUNT) > 0;
  if ((statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) !== hasGeometryEvidence) {
    failOrdinaryResult('INVALID_RESULT', 'slice status does not match diagnostic evidence');
  }

  return Object.freeze({
    version: version as typeof SLICE_RESULT_VERSION,
    statusCode: statusCode as SliceBatchResult['statusCode'],
    planeOffsets: new ImmutableSliceArray(planeOffsets, 'uint32'),
    endpoints: new ImmutableSliceArray(endpoints, 'float64'),
    diagnosticCounters: new ImmutableSliceArray(diagnosticCounters, 'uint32'),
  });
}

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
    if (!(error instanceof SliceKernelError) || !fallbackEligibleErrors.has(error)) {
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
