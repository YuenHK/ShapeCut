import {
  SliceKernelBoundaryError,
  initializeSliceKernel,
} from './slice-kernel-wrapper.mjs';

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
const MAX_POSITION_ALLOCATION_BYTES = MAX_VERTEX_COUNT * 3 * Float32Array.BYTES_PER_ELEMENT;
const MAX_INDEX_ALLOCATION_BYTES = MAX_TRIANGLE_COUNT * 3 * Uint32Array.BYTES_PER_ELEMENT;
const MAX_PLANE_ALLOCATION_BYTES = MAX_PLANE_COUNT * Float64Array.BYTES_PER_ELEMENT;
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

const objectFreeze = Object.freeze;
const FALLBACK_CAPABILITY = objectFreeze({});
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
    objectFreeze(this);
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

function createSliceKernelRuntimeError(
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
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const mathFloor = Math.floor;
const mathMin = Math.min;
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
  readonly buffer: ArrayBuffer;
  readonly spec: ExactTypedArraySpec<T>;
  readonly name: string;
  readonly code: 'INVALID_REQUEST' | 'INVALID_RESULT';
}

interface ExactTypedArraySpec<T extends Float32Array | Float64Array | Uint32Array> {
  readonly prototype: object;
  readonly bytesPerElement: number;
  create(length: number): T;
  createView(buffer: ArrayBuffer, byteOffset: number, length: number): T;
}

const float32ArraySpec: ExactTypedArraySpec<Float32Array> = objectFreeze({
  prototype: Float32ArrayIntrinsic.prototype,
  bytesPerElement: Float32ArrayIntrinsic.BYTES_PER_ELEMENT,
  create: (length: number) => new Float32ArrayIntrinsic(length),
  createView: (buffer: ArrayBuffer, byteOffset: number, length: number) => new Float32ArrayIntrinsic(
    buffer,
    byteOffset,
    length,
  ),
});
const float64ArraySpec: ExactTypedArraySpec<Float64Array> = objectFreeze({
  prototype: Float64ArrayIntrinsic.prototype,
  bytesPerElement: Float64ArrayIntrinsic.BYTES_PER_ELEMENT,
  create: (length: number) => new Float64ArrayIntrinsic(length),
  createView: (buffer: ArrayBuffer, byteOffset: number, length: number) => new Float64ArrayIntrinsic(
    buffer,
    byteOffset,
    length,
  ),
});
const uint32ArraySpec: ExactTypedArraySpec<Uint32Array> = objectFreeze({
  prototype: Uint32ArrayIntrinsic.prototype,
  bytesPerElement: Uint32ArrayIntrinsic.BYTES_PER_ELEMENT,
  create: (length: number) => new Uint32ArrayIntrinsic(length),
  createView: (buffer: ArrayBuffer, byteOffset: number, length: number) => new Uint32ArrayIntrinsic(
    buffer,
    byteOffset,
    length,
  ),
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
    if (!numberIsSafeInteger(length)
      || !numberIsSafeInteger(byteLength)
      || !numberIsSafeInteger(byteOffset)
      || !numberIsSafeInteger(bufferByteLength)
      || (length as number) < 0
      || (byteLength as number) < 0
      || (byteOffset as number) !== 0
      || (byteOffset as number) % bytesPerElement !== 0
      || (byteLength as number) !== (length as number) * bytesPerElement
      || (byteLength as number) !== bufferByteLength
      || resizable !== false) {
      throw new TypeError('invalid owned typed array span');
    }
    return objectFreeze({
      value: value as T,
      length: length as number,
      byteLength: byteLength as number,
      buffer: buffer as ArrayBuffer,
      spec,
      name,
      code,
    });
  } catch {
    failInspection(code, name);
  }
}

type AnyExactTypedArray = ExactTypedArray<Float32Array | Float64Array | Uint32Array>;

interface ChunkedTypedArray<T extends Float64Array | Uint32Array> {
  readonly chunks: readonly T[];
  readonly length: number;
  readonly byteLength: number;
  readonly chunkLength: number;
}

function revalidateExactTypedArray(inspected: AnyExactTypedArray): void {
  const current = inspectExactTypedArray(
    inspected.value,
    inspected.spec,
    inspected.name,
    inspected.code,
  );
  if (current.length !== inspected.length
    || current.byteLength !== inspected.byteLength
    || current.buffer !== inspected.buffer) {
    failInspection(inspected.code, inspected.name);
  }
}

function revalidateAll(inspections: readonly AnyExactTypedArray[]): void {
  for (const inspected of inspections) revalidateExactTypedArray(inspected);
}

function checkOwnedArrayCap(
  byteLength: number,
  name: string,
): void {
  if (!numberIsSafeInteger(byteLength) || byteLength > MAX_OWNED_ARRAY_BYTES) {
    failOrdinaryResult('RESOURCE_LIMIT', `${name} exceeds the approved allocation limit`);
  }
}

function checkRequestArrayCap(byteLength: number, maximum: number, name: string): void {
  if (!numberIsSafeInteger(byteLength) || byteLength > maximum) {
    fail('RESOURCE_LIMIT', `${name} exceeds the approved request allocation limit`);
  }
}

class ImmutableSliceArray implements ReadonlySliceArray {
  readonly elementType: 'uint32' | 'float64';
  readonly length: number;
  readonly byteLength: number;
  readonly #values: ChunkedTypedArray<Uint32Array | Float64Array>;

  constructor(
    values: ChunkedTypedArray<Uint32Array | Float64Array>,
    elementType: 'uint32' | 'float64',
  ) {
    this.#values = values;
    this.elementType = elementType;
    this.length = values.length;
    this.byteLength = values.byteLength;
    objectFreeze(this);
  }

  at(index: number): number | undefined {
    return chunkedAt(this.#values, index);
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let index = 0; index < this.length; index += 1) {
      yield chunkedAt(this.#values, index) as number;
    }
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
      return objectFreeze({ reason, source }) as SliceKernelAbort;
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

function checkCheckpoint(
  checkpoint: SliceKernelCheckpoint,
  inspections: readonly AnyExactTypedArray[] = [],
): void {
  revalidateAll(inspections);
  const abort = readSliceKernelAbort(checkpoint);
  revalidateAll(inspections);
  if (abort) throw sliceKernelAbortError(abort);
}

function defensiveCopy<T extends Float32Array | Float64Array | Uint32Array>(
  inspected: ExactTypedArray<T>,
  interval: number,
  checkpoint: SliceKernelCheckpoint,
  surroundingInspections: readonly AnyExactTypedArray[],
): T {
  checkCheckpoint(checkpoint, surroundingInspections);
  let copy: T;
  try {
    copy = inspected.spec.create(inspected.length);
  } catch {
    if (inspected.code === 'INVALID_RESULT') {
      failOrdinaryResult('RESOURCE_LIMIT', `${inspected.name} allocation failed closed`);
    }
    fail('RESOURCE_LIMIT', `${inspected.name} allocation failed closed`);
  }
  const copiedInspection = inspectExactTypedArray(
    copy,
    inspected.spec,
    `${inspected.name} defensive copy`,
    inspected.code,
  );
  const activeInspections = [...surroundingInspections, copiedInspection];
  checkCheckpoint(checkpoint, activeInspections);

  try {
    if (typeof typedArraySet !== 'function') {
      throw new TypeError('missing typed array copy intrinsic');
    }
    for (let start = 0; start < inspected.length; start += interval) {
      const end = mathMin(start + interval, inspected.length);
      const chunk = inspected.spec.createView(
        inspected.buffer,
        start * inspected.spec.bytesPerElement,
        end - start,
      );
      reflectApply(typedArraySet, copy, [chunk, start]);
      checkCheckpoint(checkpoint, activeInspections);
    }
    return copy;
  } catch (error) {
    if (error instanceof SliceKernelError) throw error;
    failInspection(inspected.code, inspected.name);
  }
}

function defensiveChunkedCopy<T extends Float64Array | Uint32Array>(
  inspected: ExactTypedArray<T>,
  interval: number,
  checkpoint: SliceKernelCheckpoint,
  surroundingInspections: readonly AnyExactTypedArray[],
): ChunkedTypedArray<T> {
  const chunks: T[] = [];
  if (inspected.length === 0) checkCheckpoint(checkpoint, surroundingInspections);
  for (let start = 0; start < inspected.length; start += interval) {
    const end = mathMin(start + interval, inspected.length);
    checkCheckpoint(checkpoint, surroundingInspections);
    let chunk: T;
    try {
      chunk = inspected.spec.create(end - start);
    } catch {
      failOrdinaryResult('RESOURCE_LIMIT', `${inspected.name} chunk allocation failed closed`);
    }
    const chunkInspection = inspectExactTypedArray(
      chunk,
      inspected.spec,
      `${inspected.name} defensive chunk`,
      inspected.code,
    );
    const activeInspections = [...surroundingInspections, chunkInspection];
    checkCheckpoint(checkpoint, activeInspections);
    try {
      if (typeof typedArraySet !== 'function') {
        throw new TypeError('missing typed array copy intrinsic');
      }
      const sourceChunk = inspected.spec.createView(
        inspected.buffer,
        start * inspected.spec.bytesPerElement,
        end - start,
      );
      reflectApply(typedArraySet, chunk, [sourceChunk, 0]);
    } catch {
      failInspection(inspected.code, inspected.name);
    }
    checkCheckpoint(checkpoint, activeInspections);
    chunks.push(chunk);
  }
  return objectFreeze({
    chunks: objectFreeze(chunks),
    length: inspected.length,
    byteLength: inspected.byteLength,
    chunkLength: interval,
  });
}

function chunkedAt(
  values: ChunkedTypedArray<Float64Array | Uint32Array>,
  index: number,
): number | undefined {
  const resolved = index < 0 ? values.length + index : index;
  if (!numberIsSafeInteger(resolved) || resolved < 0 || resolved >= values.length) {
    return undefined;
  }
  const chunkIndex = mathFloor(resolved / values.chunkLength);
  const chunkOffset = resolved - (chunkIndex * values.chunkLength);
  return reflectApply(typedArrayAt, values.chunks[chunkIndex], [chunkOffset]) as number | undefined;
}

function forEachChunkedSnapshot<T extends Float64Array | Uint32Array>(
  values: ChunkedTypedArray<T>,
  interval: number,
  checkpoint: SliceKernelCheckpoint,
  visit: (value: number, index: number) => void,
  inspections: readonly AnyExactTypedArray[],
): void {
  for (let start = 0; start < values.length; start += interval) {
    checkCheckpoint(checkpoint, inspections);
    const end = mathMin(start + interval, values.length);
    for (let index = start; index < end; index += 1) {
      visit(chunkedAt(values, index) as number, index);
    }
  }
}

function forEachChunked<T extends Float32Array | Float64Array | Uint32Array>(
  values: T,
  length: number,
  interval: number,
  checkpoint: SliceKernelCheckpoint,
  visit: (value: number, index: number) => void,
  inspections: readonly AnyExactTypedArray[] = [],
): void {
  for (let start = 0; start < length; start += interval) {
    checkCheckpoint(checkpoint, inspections);
    const end = mathMin(start + interval, length);
    for (let index = start; index < end; index += 1) {
      visit(reflectApply(typedArrayAt, values, [index]) as number, index);
    }
  }
}

interface InspectedSliceBatchRequest {
  readonly positions: ExactTypedArray<Float32Array>;
  readonly indices: ExactTypedArray<Uint32Array>;
  readonly planes: ExactTypedArray<Float64Array>;
  readonly interval: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

interface TrustedSliceBatchRequestSnapshot {
  readonly request: SliceBatchRequest;
  readonly planeCount: number;
  readonly indexCount: number;
  readonly sourceInspections: readonly AnyExactTypedArray[];
}

function inspectSliceBatchRequest(value: unknown): InspectedSliceBatchRequest {
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

  checkRequestArrayCap(
    inspectedPositions.byteLength,
    MAX_POSITION_ALLOCATION_BYTES,
    'positions',
  );
  checkRequestArrayCap(inspectedIndices.byteLength, MAX_INDEX_ALLOCATION_BYTES, 'indices');
  checkRequestArrayCap(inspectedPlanes.byteLength, MAX_PLANE_ALLOCATION_BYTES, 'planes');

  if (!numberIsSafeInteger(deadlineCheckInterval)
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
  if (!numberIsSafeInteger(work) || work > MAX_PLANE_TRIANGLE_TESTS) {
    fail('RESOURCE_LIMIT', 'slice request exceeds the kernel work limit');
  }

  return objectFreeze({
    positions: inspectedPositions,
    indices: inspectedIndices,
    planes: inspectedPlanes,
    interval,
    vertexCount,
    triangleCount,
  });
}

function materializeSliceBatchRequest(
  inspected: InspectedSliceBatchRequest,
  checkpoint: SliceKernelCheckpoint,
  additionalInspections: readonly AnyExactTypedArray[] = [],
): TrustedSliceBatchRequestSnapshot {
  const sourceInspections = [
    ...additionalInspections,
    inspected.positions,
    inspected.indices,
    inspected.planes,
  ];

  const positions = defensiveCopy(
    inspected.positions,
    inspected.interval,
    checkpoint,
    sourceInspections,
  );
  const indices = defensiveCopy(
    inspected.indices,
    inspected.interval,
    checkpoint,
    sourceInspections,
  );
  const planes = defensiveCopy(
    inspected.planes,
    inspected.interval,
    checkpoint,
    sourceInspections,
  );

  checkCheckpoint(checkpoint, sourceInspections);
  forEachChunked(positions, inspected.positions.length, inspected.interval, checkpoint, (position) => {
    if (!numberIsFinite(position)) fail('INVALID_REQUEST', 'positions must be finite');
  }, sourceInspections);
  forEachChunked(indices, inspected.indices.length, inspected.interval, checkpoint, (index) => {
    if (index >= inspected.vertexCount) fail('INVALID_REQUEST', 'triangle index is out of range');
  }, sourceInspections);
  let previousPlane: number | undefined;
  forEachChunked(planes, inspected.planes.length, inspected.interval, checkpoint, (plane) => {
    if (!numberIsFinite(plane) || (previousPlane !== undefined && plane <= previousPlane)) {
      fail('INVALID_REQUEST', 'planes must be finite and strictly increasing');
    }
    previousPlane = plane;
  }, sourceInspections);

  const request = objectFreeze({
    positions,
    indices,
    planes,
    deadlineCheckInterval: inspected.interval,
  });
  return objectFreeze({
    request,
    planeCount: inspected.planes.length,
    indexCount: inspected.indices.length,
    sourceInspections,
  });
}

export function validateSliceBatchRequest(
  value: unknown,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchRequest {
  return materializeSliceBatchRequest(inspectSliceBatchRequest(value), checkpoint).request;
}

function requireSafeInteger(
  value: unknown,
  name: string,
  allowed?: readonly number[],
): number {
  if (!numberIsSafeInteger(value) || (allowed && !allowed.includes(value as number))) {
    failOrdinaryResult('INVALID_RESULT', `${name} is invalid`);
  }
  return value as number;
}

interface InspectedSliceBatchResult {
  readonly version: number;
  readonly statusCode: number;
  readonly planeOffsets: ExactTypedArray<Uint32Array>;
  readonly endpoints: ExactTypedArray<Float64Array>;
  readonly diagnosticCounters: ExactTypedArray<Uint32Array>;
}

function inspectSliceBatchResult(value: unknown): InspectedSliceBatchResult {
  const snapshot = requireStrictRecord(
    value,
    ['version', 'statusCode', 'planeOffsets', 'endpoints', 'diagnosticCounters'],
    'INVALID_RESULT',
    'slice result',
  );

  const versionValue = snapshot.get('version');
  const statusCodeValue = snapshot.get('statusCode');
  const planeOffsets = inspectExactTypedArray(
    snapshot.get('planeOffsets'),
    uint32ArraySpec,
    'plane offsets',
    'INVALID_RESULT',
  );
  const endpoints = inspectExactTypedArray(
    snapshot.get('endpoints'),
    float64ArraySpec,
    'endpoints',
    'INVALID_RESULT',
  );
  const diagnosticCounters = inspectExactTypedArray(
    snapshot.get('diagnosticCounters'),
    uint32ArraySpec,
    'diagnostic counters',
    'INVALID_RESULT',
  );

  const version = requireSafeInteger(
    versionValue,
    'slice result version',
    [SLICE_RESULT_VERSION],
  );
  const statusCode = requireSafeInteger(
    statusCodeValue,
    'slice result status',
    [SLICE_STATUS_OK, SLICE_STATUS_GEOMETRY_EVIDENCE],
  );

  checkOwnedArrayCap(planeOffsets.byteLength, 'plane offsets');
  checkOwnedArrayCap(endpoints.byteLength, 'endpoints');
  checkOwnedArrayCap(diagnosticCounters.byteLength, 'diagnostic counters');
  if (endpoints.length > MAX_ENDPOINT_VALUE_COUNT || endpoints.length % 4 !== 0) {
    failOrdinaryResult('INVALID_RESULT', 'endpoint length is invalid');
  }
  if (diagnosticCounters.length !== DIAGNOSTIC_COUNTER_COUNT) {
    failOrdinaryResult('INVALID_RESULT', 'diagnostic counter count is invalid');
  }

  return objectFreeze({ version, statusCode, planeOffsets, endpoints, diagnosticCounters });
}

function parseSliceBatchResultWithTrustedRequest(
  inspected: InspectedSliceBatchResult,
  trustedRequest: TrustedSliceBatchRequestSnapshot,
  checkpoint: SliceKernelCheckpoint,
  additionalInspections: readonly AnyExactTypedArray[] = [],
): SliceBatchResult {
  const sourceInspections = [
    ...additionalInspections,
    inspected.planeOffsets,
    inspected.endpoints,
    inspected.diagnosticCounters,
  ];
  const { request, planeCount: requestPlaneCount, indexCount: requestIndexCount } = trustedRequest;
  const planeOffsets = defensiveChunkedCopy(
    inspected.planeOffsets,
    request.deadlineCheckInterval,
    checkpoint,
    sourceInspections,
  );
  const endpoints = defensiveChunkedCopy(
    inspected.endpoints,
    request.deadlineCheckInterval,
    checkpoint,
    sourceInspections,
  );
  const diagnosticCounters = defensiveChunkedCopy(
    inspected.diagnosticCounters,
    request.deadlineCheckInterval,
    checkpoint,
    sourceInspections,
  );

  if (inspected.planeOffsets.length !== requestPlaneCount + 1) {
    failOrdinaryResult('INVALID_RESULT', 'plane offset count does not match the request');
  }

  const segmentCount = inspected.endpoints.length / 4;
  if (chunkedAt(planeOffsets, 0) !== 0) {
    failOrdinaryResult('INVALID_RESULT', 'plane offsets must start at zero');
  }
  let previousOffset: number | undefined;
  forEachChunkedSnapshot(
    planeOffsets,
    request.deadlineCheckInterval,
    checkpoint,
    (offset) => {
      if (previousOffset !== undefined && (offset < previousOffset || offset > segmentCount)) {
        failOrdinaryResult('INVALID_RESULT', 'plane offsets must be bounded and monotonic');
      }
      previousOffset = offset;
    },
    sourceInspections,
  );
  if (chunkedAt(planeOffsets, inspected.planeOffsets.length - 1)
    !== segmentCount) {
    failOrdinaryResult('INVALID_RESULT', 'final plane offset does not match endpoint segments');
  }
  forEachChunkedSnapshot(
    endpoints,
    request.deadlineCheckInterval,
    checkpoint,
    (endpoint) => {
      if (!numberIsFinite(endpoint)) {
        failOrdinaryResult('INVALID_RESULT', 'endpoints must be finite');
      }
    },
    sourceInspections,
  );

  const counter = (index: number): number => chunkedAt(diagnosticCounters, index) as number;
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
  if ((inspected.statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) !== hasGeometryEvidence) {
    failOrdinaryResult('INVALID_RESULT', 'slice status does not match diagnostic evidence');
  }

  return objectFreeze({
    version: inspected.version as typeof SLICE_RESULT_VERSION,
    statusCode: inspected.statusCode as SliceBatchResult['statusCode'],
    planeOffsets: new ImmutableSliceArray(planeOffsets, 'uint32'),
    endpoints: new ImmutableSliceArray(endpoints, 'float64'),
    diagnosticCounters: new ImmutableSliceArray(diagnosticCounters, 'uint32'),
  });
}

export function parseSliceBatchResult(
  value: unknown,
  requestValue: SliceBatchRequest,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchResult {
  const inspectedResult = inspectSliceBatchResult(value);
  const inspectedRequest = inspectSliceBatchRequest(requestValue);
  const resultInspections = [
    inspectedResult.planeOffsets,
    inspectedResult.endpoints,
    inspectedResult.diagnosticCounters,
  ];
  const requestInspections = [
    inspectedRequest.positions,
    inspectedRequest.indices,
    inspectedRequest.planes,
  ];
  const trustedRequest = materializeSliceBatchRequest(
    inspectedRequest,
    checkpoint,
    resultInspections,
  );
  return parseSliceBatchResultWithTrustedRequest(
    inspectedResult,
    trustedRequest,
    checkpoint,
    requestInspections,
  );
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
    const token = objectFreeze({}) as CanonicalPublicationToken;
    this.#state = nextState;
    this.#activeToken = token;
    return token;
  }
}

const WASM_ASSET_URL = new URL('./generated/geometry_wasm_bg.wasm', import.meta.url);

function mappedRuntimeError(code: SliceKernelErrorCode, message: string): SliceKernelError {
  return createSliceKernelRuntimeError(code, message);
}

function mapExecutionError(
  error: unknown,
  observedAbort?: SliceKernelAbort,
  checkpointFailure?: SliceKernelError,
): SliceKernelError {
  if (checkpointFailure) return checkpointFailure;
  if (observedAbort) return sliceKernelAbortError(observedAbort);
  if (error instanceof SliceKernelError) return error;
  if (!(error instanceof SliceKernelBoundaryError)) {
    return mappedRuntimeError('EXECUTION_FAILED', 'WASM geometry execution failed');
  }
  switch (error.code) {
    case 'INVALID_REQUEST':
      return error.phase === 'request'
        ? mappedRuntimeError('INVALID_REQUEST', 'WASM geometry request was rejected')
        : mappedRuntimeError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'INVALID_RESULT':
      return error.phase === 'result'
        ? mappedRuntimeError('INVALID_RESULT', 'WASM geometry result was rejected')
        : mappedRuntimeError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'RESOURCE_LIMIT':
      return mappedRuntimeError('RESOURCE_LIMIT', 'WASM geometry resource limit was exceeded');
    case 'DEADLINE_CHECK_FAILED':
      return error.phase === 'execution'
        ? mappedRuntimeError('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed')
        : mappedRuntimeError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'DEADLINE_EXCEEDED':
      return error.phase === 'execution'
        ? mappedRuntimeError('DEADLINE_EXCEEDED', 'WASM geometry deadline was exceeded')
        : mappedRuntimeError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'EXECUTION_FAILED':
      return mappedRuntimeError('EXECUTION_FAILED', 'WASM geometry execution failed');
  }
}

interface KernelOperationToken {
  readonly kernel: BrowserSliceKernel;
  readonly generation: number;
}

class BrowserSliceKernel implements SliceKernel {
  #disposed = false;
  #controlled: ReturnType<typeof initializeSliceKernel> | undefined;

  constructor(
    controlled: ReturnType<typeof initializeSliceKernel>,
    private readonly generation: number,
    private readonly isCurrent: (kernel: BrowserSliceKernel, generation: number) => boolean,
    private readonly release: (kernel: BrowserSliceKernel, generation: number) => void,
  ) {
    this.#controlled = controlled;
  }

  async sliceLayerBatch(
    requestValue: SliceBatchRequest,
    checkpoint: SliceKernelCheckpoint,
  ): Promise<SliceBatchResult> {
    const operationToken = objectFreeze({ kernel: this, generation: this.generation });
    this.#assertCurrent(operationToken);

    let observedAbort: SliceKernelAbort | undefined;
    let checkpointFailure: SliceKernelError | undefined;
    try {
      const trustedRequest = materializeSliceBatchRequest(
        inspectSliceBatchRequest(requestValue),
        checkpoint,
      );
      this.#assertCurrent(operationToken);
      const controlled = this.#controlled;
      if (!controlled) {
        throw mappedRuntimeError('DISPOSED', 'WASM geometry kernel has been disposed');
      }
      const controlledCheckpoint = (): boolean => {
        try {
          revalidateAll(trustedRequest.sourceInspections);
          const abort = readSliceKernelAbort(checkpoint);
          revalidateAll(trustedRequest.sourceInspections);
          if (!abort) return false;
          observedAbort = abort;
          return true;
        } catch (error) {
          checkpointFailure = error instanceof SliceKernelError
            ? error
            : mappedRuntimeError(
              'DEADLINE_CHECK_FAILED',
              'WASM geometry checkpoint failed closed',
            );
          throw checkpointFailure;
        }
      };
      const encoded = controlled.sliceLayerBatch(
        trustedRequest.request,
        { deadlineHook: controlledCheckpoint },
      );
      this.#assertCurrent(operationToken);
      const result = parseSliceBatchResultWithTrustedRequest(
        inspectSliceBatchResult(encoded),
        trustedRequest,
        checkpoint,
        trustedRequest.sourceInspections,
      );
      this.#assertCurrent(operationToken);
      return result;
    } catch (error) {
      throw mapExecutionError(error, observedAbort, checkpointFailure);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controlled = undefined;
    this.release(this, this.generation);
  }

  #assertCurrent(token: KernelOperationToken): void {
    if (token.kernel !== this
      || token.generation !== this.generation
      || this.#disposed
      || !this.isCurrent(this, token.generation)) {
      throw mappedRuntimeError('DISPOSED', 'WASM geometry kernel has been disposed');
    }
  }
}

let activeKernel: SliceKernel | undefined;
let activeLoad: Promise<SliceKernel> | undefined;
let generation = 0;

function isCurrentKernel(kernel: BrowserSliceKernel, kernelGeneration: number): boolean {
  return generation === kernelGeneration && activeKernel === kernel;
}

function releaseKernel(kernel: BrowserSliceKernel, kernelGeneration: number): void {
  if (generation !== kernelGeneration || activeKernel !== kernel) return;
  generation += 1;
  activeKernel = undefined;
  activeLoad = undefined;
}

async function createBrowserSliceKernel(expectedGeneration: number): Promise<SliceKernel> {
  try {
    const response = await fetch(WASM_ASSET_URL);
    if (!response.ok) throw new Error('WASM asset request failed');
    const bytes = await response.arrayBuffer();
    const kernel = new BrowserSliceKernel(
      initializeSliceKernel(bytes),
      expectedGeneration,
      isCurrentKernel,
      releaseKernel,
    );
    if (generation !== expectedGeneration) {
      kernel.dispose();
      throw mappedRuntimeError('DISPOSED', 'WASM geometry kernel load was disposed');
    }
    activeKernel = kernel;
    return kernel;
  } catch (error) {
    if (error instanceof SliceKernelError && error.code === 'DISPOSED') throw error;
    throw mappedRuntimeError('LOAD_FAILED', 'WASM geometry kernel could not be loaded');
  }
}

export function loadSliceKernel(): Promise<SliceKernel> {
  if (activeKernel) return Promise.resolve(activeKernel);
  if (activeLoad) return activeLoad;

  const expectedGeneration = generation;
  const pending = createBrowserSliceKernel(expectedGeneration);
  activeLoad = pending;
  void pending.finally(() => {
    if (activeLoad === pending) activeLoad = undefined;
  }).catch(() => undefined);
  return pending;
}

export function disposeSliceKernel(): void {
  const kernel = activeKernel;
  generation += 1;
  activeKernel = undefined;
  activeLoad = undefined;
  kernel?.dispose();
}
