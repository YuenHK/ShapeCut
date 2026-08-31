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
  /**
   * Calling `sliceLayerBatch` consumes all three full-span fixed ArrayBuffers.
   * Their caller-owned views are detached before the first checkpoint.
   */
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

/** Immutable facade with a frozen shared prototype and no typed-array escape. */
export interface ReadonlySliceArray extends Iterable<number> {
  readonly elementType: 'uint32' | 'float64';
  readonly length: number;
  readonly byteLength: number;
  /** Uses the same ToIntegerOrInfinity index semantics as Array.prototype.at. */
  at(index: number): number | undefined;
}

export interface SliceBatchResult {
  readonly version: typeof SLICE_RESULT_VERSION;
  readonly statusCode: typeof SLICE_STATUS_OK | typeof SLICE_STATUS_GEOMETRY_EVIDENCE;
  readonly planeOffsets: ReadonlySliceArray;
  readonly endpoints: ReadonlySliceArray;
  readonly diagnosticCounters: ReadonlySliceArray;
}

export interface InspectedSliceWorkerResultArray<T extends Uint32Array | Float64Array> {
  readonly value: T;
  readonly length: number;
  readonly byteLength: number;
}

export interface InspectedSliceWorkerResultArrays {
  readonly planeOffsets: InspectedSliceWorkerResultArray<Uint32Array>;
  readonly endpoints: InspectedSliceWorkerResultArray<Float64Array>;
  readonly diagnosticCounters: InspectedSliceWorkerResultArray<Uint32Array>;
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
const reflectOwnKeys = Reflect.ownKeys;
const objectDefineProperty = Object.defineProperty;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const mathMin = Math.min;
/**
 * Trusted bootstrap boundary: this binding must still be the native operation
 * when the module evaluates. Postcondition checks fail closed but cannot undo
 * partial detachment performed by a malicious preloaded replacement.
 */
const structuredCloneIntrinsic = globalThis.structuredClone;
const ArrayIntrinsic = Array;
const arrayIsArray = Array.isArray;
const arrayPrototype = ArrayIntrinsic.prototype;
const arrayIterator = objectGetOwnPropertyDescriptor(arrayPrototype, Symbol.iterator)?.value;
/** Same trusted-bootstrap boundary as structuredClone: capture both iterator layers. */
const arrayIteratorPrototype = typeof arrayIterator === 'function'
  ? objectGetPrototypeOf(reflectApply(arrayIterator, new ArrayIntrinsic(), []))
  : undefined;
const arrayIteratorNext = isRecord(arrayIteratorPrototype)
  ? objectGetOwnPropertyDescriptor(arrayIteratorPrototype, 'next')?.value
  : undefined;
const ArrayBufferIntrinsic = ArrayBuffer;
const arrayBufferPrototype = ArrayBufferIntrinsic.prototype;
const typedArrayPrototype = objectGetPrototypeOf(Uint8Array.prototype);
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayValues = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'values')?.value;
const typedArrayAt = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'at')?.value;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'byteLength',
)?.get;
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(
  arrayBufferPrototype,
  'resizable',
)?.get;
const arrayBufferSlice = objectGetOwnPropertyDescriptor(arrayBufferPrototype, 'slice')?.value;
const Float32ArrayIntrinsic = Float32Array;
const Float64ArrayIntrinsic = Float64Array;
const Uint32ArrayIntrinsic = Uint32Array;
const URLIntrinsic = globalThis.URL;
const urlPrototype = URLIntrinsic.prototype;
const urlHrefGetter = objectGetOwnPropertyDescriptor(urlPrototype, 'href')?.get;
const urlOriginGetter = objectGetOwnPropertyDescriptor(urlPrototype, 'origin')?.get;
const urlPathnameGetter = objectGetOwnPropertyDescriptor(urlPrototype, 'pathname')?.get;
const workerGlobalScopeIntrinsic = (globalThis as typeof globalThis & {
  readonly WorkerGlobalScope?: Function;
}).WorkerGlobalScope;
const workerLocationIntrinsic = (globalThis as typeof globalThis & {
  readonly location?: { readonly href?: unknown };
}).location;
const workerLocationPrototype = workerLocationIntrinsic === undefined
  ? undefined
  : objectGetPrototypeOf(workerLocationIntrinsic);
const locationHrefGetter = workerLocationPrototype === undefined
  ? undefined
  : objectGetOwnPropertyDescriptor(workerLocationPrototype, 'href')?.get;
let capturedWorkerHref: string | undefined;
try {
  const href = typeof locationHrefGetter === 'function'
    ? reflectApply(locationHrefGetter, workerLocationIntrinsic, []) as unknown
    : objectGetOwnPropertyDescriptor(workerLocationIntrinsic, 'href')?.value as unknown;
  if (typeof href === 'string') capturedWorkerHref = href;
} catch {
  capturedWorkerHref = undefined;
}
const workerPostMessageIntrinsic = (globalThis as typeof globalThis & {
  readonly postMessage?: Function;
}).postMessage;
let capturedDedicatedWorkerRealm = false;
try {
  const expectedDevelopmentWorkerUrl = new URLIntrinsic('../workers/slice.worker.ts', import.meta.url);
  const expectedDevelopmentWorkerHref = reflectApply(
    urlHrefGetter as Function,
    expectedDevelopmentWorkerUrl,
    [],
  ) as unknown;
  const actualWorkerUrl = new URLIntrinsic(capturedWorkerHref as string);
  const actualWorkerOrigin = reflectApply(urlOriginGetter as Function, actualWorkerUrl, []) as unknown;
  const actualWorkerPathname = reflectApply(
    urlPathnameGetter as Function,
    actualWorkerUrl,
    [],
  ) as unknown;
  const expectedWorkerOrigin = reflectApply(
    urlOriginGetter as Function,
    expectedDevelopmentWorkerUrl,
    [],
  ) as unknown;
  const expectedWorkerPathname = reflectApply(
    urlPathnameGetter as Function,
    expectedDevelopmentWorkerUrl,
    [],
  ) as unknown;
  capturedDedicatedWorkerRealm = typeof workerGlobalScopeIntrinsic === 'function'
    && globalThis instanceof (workerGlobalScopeIntrinsic as Function & { prototype: object })
    && typeof (globalThis as typeof globalThis & { document?: unknown }).document === 'undefined'
    && typeof capturedWorkerHref === 'string'
    && (capturedWorkerHref === import.meta.url
      || (typeof expectedDevelopmentWorkerHref === 'string'
        && actualWorkerOrigin === expectedWorkerOrigin
        && actualWorkerPathname === expectedWorkerPathname));
} catch {
  capturedDedicatedWorkerRealm = false;
}
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
  createView(buffer: ArrayBuffer, byteOffset: number, length: number): T;
}

const float32ArraySpec: ExactTypedArraySpec<Float32Array> = objectFreeze({
  prototype: Float32ArrayIntrinsic.prototype,
  bytesPerElement: Float32ArrayIntrinsic.BYTES_PER_ELEMENT,
  createView: (buffer: ArrayBuffer, byteOffset: number, length: number) => new Float32ArrayIntrinsic(
    buffer,
    byteOffset,
    length,
  ),
});
const float64ArraySpec: ExactTypedArraySpec<Float64Array> = objectFreeze({
  prototype: Float64ArrayIntrinsic.prototype,
  bytesPerElement: Float64ArrayIntrinsic.BYTES_PER_ELEMENT,
  createView: (buffer: ArrayBuffer, byteOffset: number, length: number) => new Float64ArrayIntrinsic(
    buffer,
    byteOffset,
    length,
  ),
});
const uint32ArraySpec: ExactTypedArraySpec<Uint32Array> = objectFreeze({
  prototype: Uint32ArrayIntrinsic.prototype,
  bytesPerElement: Uint32ArrayIntrinsic.BYTES_PER_ELEMENT,
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

export function inspectSliceWorkerResultArrays(
  planeOffsetsValue: unknown,
  endpointsValue: unknown,
  diagnosticCountersValue: unknown,
): InspectedSliceWorkerResultArrays {
  const planeOffsets = inspectExactTypedArray(
    planeOffsetsValue,
    uint32ArraySpec,
    'worker plane offsets',
    'INVALID_RESULT',
  );
  const endpoints = inspectExactTypedArray(
    endpointsValue,
    float64ArraySpec,
    'worker endpoints',
    'INVALID_RESULT',
  );
  const diagnosticCounters = inspectExactTypedArray(
    diagnosticCountersValue,
    uint32ArraySpec,
    'worker diagnostic counters',
    'INVALID_RESULT',
  );
  rejectSharedBackingBuffers(
    [planeOffsets, endpoints, diagnosticCounters],
    'INVALID_RESULT',
    'worker result arrays',
  );
  return objectFreeze({
    planeOffsets: objectFreeze({
      value: planeOffsets.value,
      length: planeOffsets.length,
      byteLength: planeOffsets.byteLength,
    }),
    endpoints: objectFreeze({
      value: endpoints.value,
      length: endpoints.length,
      byteLength: endpoints.byteLength,
    }),
    diagnosticCounters: objectFreeze({
      value: diagnosticCounters.value,
      length: diagnosticCounters.length,
      byteLength: diagnosticCounters.byteLength,
    }),
  });
}

type AnyExactTypedArray = ExactTypedArray<Float32Array | Float64Array | Uint32Array>;

function rejectSharedBackingBuffers(
  inspections: readonly AnyExactTypedArray[],
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
  name: string,
): void {
  for (let index = 0; index < inspections.length; index += 1) {
    for (let other = index + 1; other < inspections.length; other += 1) {
      if (inspections[index].buffer === inspections[other].buffer) failInspection(code, name);
    }
  }
}

function snapshotTransferredBuffers(
  value: unknown,
  expectedLength: number,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
  name: string,
): readonly ArrayBuffer[] {
  try {
    // Native clone returns an ordinary array. Descriptor-equivalent transparent
    // proxies cannot be identified in general, so never perform an ordinary get.
    if (!arrayIsArray(value) || objectGetPrototypeOf(value) !== arrayPrototype) {
      throw new TypeError('ownership transfer did not return an ordinary array');
    }
    const keys = reflectOwnKeys(value);
    if (keys.length !== expectedLength + 1) {
      throw new TypeError('ownership transfer returned unexpected keys');
    }
    for (let index = 0; index < expectedLength; index += 1) {
      if (keys[index] !== String(index)) {
        throw new TypeError('ownership transfer returned unexpected numeric keys');
      }
    }
    if (keys[expectedLength] !== 'length') {
      throw new TypeError('ownership transfer omitted its exact length key');
    }

    const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor)) {
      throw new TypeError('ownership transfer returned an accessor length');
    }
    const lengthValue = lengthDescriptor.value as unknown;
    if (lengthValue !== expectedLength
      || lengthDescriptor.configurable !== false
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.writable !== true) {
      throw new TypeError('ownership transfer returned an invalid length descriptor');
    }

    const snapshot = new ArrayIntrinsic<ArrayBuffer>(expectedLength);
    for (let index = 0; index < expectedLength; index += 1) {
      const key = String(index);
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('ownership transfer returned an accessor index');
      }
      const descriptorValue = descriptor.value as unknown;
      if (descriptor.configurable !== true
        || descriptor.enumerable !== true
        || descriptor.writable !== true) {
        throw new TypeError('ownership transfer returned an invalid numeric descriptor');
      }
      snapshot[index] = descriptorValue as ArrayBuffer;
    }
    return objectFreeze(snapshot);
  } catch {
    failInspection(code, name);
  }
}

function createPrivateTransferIterator(this: unknown): object {
  if (typeof arrayIterator !== 'function' || typeof arrayIteratorNext !== 'function') {
    throw new TypeError('array iterator intrinsics unavailable at trusted bootstrap');
  }
  const iterator = reflectApply(arrayIterator, this, []) as unknown;
  if (!isRecord(iterator)) throw new TypeError('array iterator creation failed');
  objectDefineProperty(iterator, 'next', {
    configurable: false,
    enumerable: false,
    value: arrayIteratorNext,
    writable: false,
  });
  return iterator;
}

function transferOwnedTypedArrays<T extends readonly AnyExactTypedArray[]>(
  inspections: T,
  code: 'INVALID_REQUEST' | 'INVALID_RESULT',
  name: string,
): T {
  rejectSharedBackingBuffers(inspections, code, name);
  try {
    if (typeof structuredCloneIntrinsic !== 'function') {
      throw new TypeError('structured clone transfer unavailable');
    }
    const sourceBuffers = new ArrayIntrinsic<ArrayBuffer>(inspections.length);
    for (let index = 0; index < inspections.length; index += 1) {
      sourceBuffers[index] = inspections[index].buffer;
    }
    if (typeof arrayIterator !== 'function' || typeof arrayIteratorNext !== 'function') {
      throw new TypeError('array iterator intrinsics unavailable at trusted bootstrap');
    }
    objectDefineProperty(sourceBuffers, Symbol.iterator, {
      configurable: false,
      enumerable: false,
      value: createPrivateTransferIterator,
      writable: false,
    });
    objectFreeze(sourceBuffers);
    const cloneReturn = structuredCloneIntrinsic(sourceBuffers, {
      transfer: sourceBuffers,
    });
    const privateBuffers = snapshotTransferredBuffers(
      cloneReturn,
      inspections.length,
      code,
      `${name} return container`,
    );
    for (let index = 0; index < inspections.length; index += 1) {
      const sourceBuffer = inspections[index].buffer;
      const sourceByteLength = reflectApply(
        arrayBufferByteLengthGetter as Function,
        sourceBuffer,
        [],
      ) as unknown;
      if (typeof arrayBufferSlice !== 'function') {
        throw new TypeError('array buffer slice unavailable at trusted bootstrap');
      }
      let sourceDetached = false;
      try {
        reflectApply(arrayBufferSlice, sourceBuffer, [0, 0]);
      } catch {
        sourceDetached = true;
      }
      if (sourceByteLength !== 0 || !sourceDetached) {
        throw new TypeError('ownership source was not detached');
      }

      const privateBuffer = privateBuffers[index] as unknown;
      const privateByteLength = reflectApply(
        arrayBufferByteLengthGetter as Function,
        privateBuffer,
        [],
      ) as unknown;
      const privateResizable = typeof arrayBufferResizableGetter === 'function'
        ? reflectApply(arrayBufferResizableGetter, privateBuffer, []) as unknown
        : false;
      if (!isRecord(privateBuffer)
        || privateByteLength !== inspections[index].byteLength
        || privateResizable !== false) {
        throw new TypeError('ownership transfer returned an invalid private buffer');
      }
      for (let sourceIndex = 0; sourceIndex < inspections.length; sourceIndex += 1) {
        if (privateBuffer === (inspections[sourceIndex].buffer as unknown)) {
          throw new TypeError('ownership transfer returned a source buffer');
        }
      }
      for (let privateIndex = 0; privateIndex < index; privateIndex += 1) {
        if (privateBuffer === (privateBuffers[privateIndex] as unknown)) {
          throw new TypeError('ownership transfer aliased private buffers');
        }
      }
    }
    const privateInspections = new ArrayIntrinsic<AnyExactTypedArray>(inspections.length);
    for (let index = 0; index < inspections.length; index += 1) {
      const inspected = inspections[index];
      privateInspections[index] = inspectExactTypedArray(
        inspected.spec.createView(privateBuffers[index], 0, inspected.length),
        inspected.spec,
        `${inspected.name} private ownership`,
        code,
      );
    }
    return privateInspections as unknown as T;
  } catch (error) {
    if (error instanceof SliceKernelError) throw error;
    failInspection(code, name);
  }
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
  readonly #values: Uint32Array | Float64Array;

  constructor(values: Uint32Array | Float64Array, elementType: 'uint32' | 'float64') {
    this.#values = values;
    this.elementType = elementType;
    this.length = reflectApply(typedArrayLengthGetter as Function, values, []) as number;
    this.byteLength = reflectApply(typedArrayByteLengthGetter as Function, values, []) as number;
    objectFreeze(this);
  }

  at(index: number): number | undefined {
    return reflectApply(typedArrayAt, this.#values, [index]) as number | undefined;
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let index = 0; index < this.length; index += 1) {
      yield reflectApply(typedArrayAt, this.#values, [index]) as number;
    }
  }
}
objectFreeze(ImmutableSliceArray.prototype);

interface TransferableSliceBatchResultOwnership {
  readonly planeOffsets: Uint32Array;
  readonly planeOffsetsBuffer: ArrayBuffer;
  readonly endpoints: Float64Array;
  readonly endpointsBuffer: ArrayBuffer;
  readonly diagnosticCounters: Uint32Array;
  readonly diagnosticCountersBuffer: ArrayBuffer;
}

const transferableSliceBatchResultOwnership = new WeakMap<
  SliceBatchResult,
  TransferableSliceBatchResultOwnership
>();

/** Closed one-shot publisher; it never returns the private arrays to caller code. */
export interface BundledSliceWorkerResultEnvelope {
  readonly type: 'slice-result';
  readonly generation: number;
  readonly partitionIndex: number;
}

export function publishBundledSliceBatchResult(
  result: SliceBatchResult,
  envelope: BundledSliceWorkerResultEnvelope,
): void {
  if (!capturedDedicatedWorkerRealm || typeof workerPostMessageIntrinsic !== 'function') {
    throw new TypeError('slice result publication is restricted to the bundled worker adapter');
  }
  const ownership = transferableSliceBatchResultOwnership.get(result);
  if (!ownership) {
    throw new TypeError('bundled worker result ownership is unavailable or already consumed');
  }
  transferableSliceBatchResultOwnership.delete(result);
  const transfer = new ArrayIntrinsic<ArrayBuffer>(3);
  transfer[0] = ownership.planeOffsetsBuffer;
  transfer[1] = ownership.endpointsBuffer;
  transfer[2] = ownership.diagnosticCountersBuffer;
  objectDefineProperty(transfer, Symbol.iterator, {
    configurable: false,
    enumerable: false,
    value: createPrivateTransferIterator,
    writable: false,
  });
  objectFreeze(transfer);
  const transport = objectFreeze({ transfer });
  const response = objectFreeze({
    type: envelope.type,
    generation: envelope.generation,
    partitionIndex: envelope.partitionIndex,
    version: result.version,
    statusCode: result.statusCode,
    planeOffsets: ownership.planeOffsets,
    endpoints: ownership.endpoints,
    diagnosticCounters: ownership.diagnosticCounters,
  });
  reflectApply(workerPostMessageIntrinsic, globalThis, [response, transport]);
  for (let index = 0; index < transfer.length; index += 1) {
    const buffer = transfer[index];
    const byteLength = reflectApply(arrayBufferByteLengthGetter as Function, buffer, []) as unknown;
    let detached = false;
    try {
      reflectApply(arrayBufferSlice as Function, buffer, [0, 0]);
    } catch {
      detached = true;
    }
    if (byteLength !== 0 || !detached) {
      throw new TypeError('slice result publication did not detach an owned buffer');
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
}

/**
 * Private ownership snapshot for trusted orchestration code. The source record
 * is descriptor-snapshotted once and all three source buffers are atomically
 * detached through the same hardened transport used by the kernel boundary.
 */
export interface OwnedSliceBatchRequestSnapshot extends SliceBatchRequest {
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly planeCount: number;
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

function takeSliceBatchRequestOwnership(
  inspected: InspectedSliceBatchRequest,
): InspectedSliceBatchRequest {
  const [privatePositions, privateIndices, privatePlanes] = transferOwnedTypedArrays([
    inspected.positions,
    inspected.indices,
    inspected.planes,
  ] as const, 'INVALID_REQUEST', 'slice request ownership transfer');
  return rebuildSliceBatchRequest(
    inspected,
    privatePositions,
    privateIndices,
    privatePlanes,
  );
}

export function takeSliceBatchRequestOwnershipSnapshot(
  value: unknown,
): OwnedSliceBatchRequestSnapshot {
  const owned = takeSliceBatchRequestOwnership(inspectSliceBatchRequest(value));
  return objectFreeze({
    positions: owned.positions.value,
    indices: owned.indices.value,
    planes: owned.planes.value,
    deadlineCheckInterval: owned.interval,
    vertexCount: owned.vertexCount,
    triangleCount: owned.triangleCount,
    planeCount: owned.planes.length,
  });
}

function rebuildSliceBatchRequest(
  inspected: InspectedSliceBatchRequest,
  positions: AnyExactTypedArray,
  indices: AnyExactTypedArray,
  planes: AnyExactTypedArray,
): InspectedSliceBatchRequest {
  return objectFreeze({
    positions: positions as ExactTypedArray<Float32Array>,
    indices: indices as ExactTypedArray<Uint32Array>,
    planes: planes as ExactTypedArray<Float64Array>,
    interval: inspected.interval,
    vertexCount: inspected.vertexCount,
    triangleCount: inspected.triangleCount,
  });
}

function materializeSliceBatchRequest(
  inspected: InspectedSliceBatchRequest,
  checkpoint: SliceKernelCheckpoint,
): TrustedSliceBatchRequestSnapshot {
  const positions = inspected.positions.value;
  const indices = inspected.indices.value;
  const planes = inspected.planes.value;

  forEachChunked(positions, inspected.positions.length, inspected.interval, checkpoint, (position) => {
    if (!numberIsFinite(position)) fail('INVALID_REQUEST', 'positions must be finite');
  });
  forEachChunked(indices, inspected.indices.length, inspected.interval, checkpoint, (index) => {
    if (index >= inspected.vertexCount) fail('INVALID_REQUEST', 'triangle index is out of range');
  });
  let previousPlane: number | undefined;
  forEachChunked(planes, inspected.planes.length, inspected.interval, checkpoint, (plane) => {
    if (!numberIsFinite(plane) || (previousPlane !== undefined && plane <= previousPlane)) {
      fail('INVALID_REQUEST', 'planes must be finite and strictly increasing');
    }
    previousPlane = plane;
  });

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
  });
}

/**
 * Consumes and validates a request without exposing the transferred private views.
 * All three caller buffers are detached on successful ownership transfer.
 */
export function validateSliceBatchRequest(
  value: unknown,
  checkpoint: SliceKernelCheckpoint,
): void {
  materializeSliceBatchRequest(
    takeSliceBatchRequestOwnership(inspectSliceBatchRequest(value)),
    checkpoint,
  );
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

function rebuildSliceBatchResult(
  inspected: InspectedSliceBatchResult,
  planeOffsets: AnyExactTypedArray,
  endpoints: AnyExactTypedArray,
  diagnosticCounters: AnyExactTypedArray,
): InspectedSliceBatchResult {
  return objectFreeze({
    version: inspected.version,
    statusCode: inspected.statusCode,
    planeOffsets: planeOffsets as ExactTypedArray<Uint32Array>,
    endpoints: endpoints as ExactTypedArray<Float64Array>,
    diagnosticCounters: diagnosticCounters as ExactTypedArray<Uint32Array>,
  });
}

function parseSliceBatchResultWithTrustedRequest(
  inspected: InspectedSliceBatchResult,
  trustedRequest: TrustedSliceBatchRequestSnapshot,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchResult {
  const { request, planeCount: requestPlaneCount, indexCount: requestIndexCount } = trustedRequest;
  const planeOffsets = inspected.planeOffsets.value;
  const endpoints = inspected.endpoints.value;
  const diagnosticCounters = inspected.diagnosticCounters.value;

  if (inspected.planeOffsets.length !== requestPlaneCount + 1) {
    failOrdinaryResult('INVALID_RESULT', 'plane offset count does not match the request');
  }

  const segmentCount = inspected.endpoints.length / 4;
  if (reflectApply(typedArrayAt, planeOffsets, [0]) !== 0) {
    failOrdinaryResult('INVALID_RESULT', 'plane offsets must start at zero');
  }
  let previousOffset: number | undefined;
  forEachChunked(
    planeOffsets,
    inspected.planeOffsets.length,
    request.deadlineCheckInterval,
    checkpoint,
    (offset) => {
      if (previousOffset !== undefined && (offset < previousOffset || offset > segmentCount)) {
        failOrdinaryResult('INVALID_RESULT', 'plane offsets must be bounded and monotonic');
      }
      previousOffset = offset;
    },
  );
  if (reflectApply(typedArrayAt, planeOffsets, [inspected.planeOffsets.length - 1])
    !== segmentCount) {
    failOrdinaryResult('INVALID_RESULT', 'final plane offset does not match endpoint segments');
  }
  forEachChunked(
    endpoints,
    inspected.endpoints.length,
    request.deadlineCheckInterval,
    checkpoint,
    (endpoint) => {
      if (!numberIsFinite(endpoint)) {
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
  if ((inspected.statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) !== hasGeometryEvidence) {
    failOrdinaryResult('INVALID_RESULT', 'slice status does not match diagnostic evidence');
  }

  const result = objectFreeze({
    version: inspected.version as typeof SLICE_RESULT_VERSION,
    statusCode: inspected.statusCode as SliceBatchResult['statusCode'],
    planeOffsets: new ImmutableSliceArray(planeOffsets, 'uint32'),
    endpoints: new ImmutableSliceArray(endpoints, 'float64'),
    diagnosticCounters: new ImmutableSliceArray(diagnosticCounters, 'uint32'),
  });
  transferableSliceBatchResultOwnership.set(result, objectFreeze({
    planeOffsets,
    planeOffsetsBuffer: reflectApply(
      typedArrayBufferGetter as Function,
      planeOffsets,
      [],
    ) as ArrayBuffer,
    endpoints,
    endpointsBuffer: reflectApply(
      typedArrayBufferGetter as Function,
      endpoints,
      [],
    ) as ArrayBuffer,
    diagnosticCounters,
    diagnosticCountersBuffer: reflectApply(
      typedArrayBufferGetter as Function,
      diagnosticCounters,
      [],
    ) as ArrayBuffer,
  }));
  return result;
}

/**
 * Direct boundary verifier used by contract tests and non-controlled callers.
 * It preflights six distinct buffers, then consumes all six in one transfer call
 * before any checkpoint.
 * Production controlled-wrapper results are already private and are wrapped directly.
 */
export function parseSliceBatchResult(
  value: unknown,
  requestValue: SliceBatchRequest,
  checkpoint: SliceKernelCheckpoint,
): SliceBatchResult {
  const inspectedResult = inspectSliceBatchResult(value);
  const inspectedRequest = inspectSliceBatchRequest(requestValue);
  const [
    privatePositions,
    privateIndices,
    privatePlanes,
    privatePlaneOffsets,
    privateEndpoints,
    privateDiagnosticCounters,
  ] = transferOwnedTypedArrays([
    inspectedRequest.positions,
    inspectedRequest.indices,
    inspectedRequest.planes,
    inspectedResult.planeOffsets,
    inspectedResult.endpoints,
    inspectedResult.diagnosticCounters,
  ], 'INVALID_REQUEST', 'slice request/result ownership transfer');
  const privateRequest = rebuildSliceBatchRequest(
    inspectedRequest,
    privatePositions,
    privateIndices,
    privatePlanes,
  );
  const privateResult = rebuildSliceBatchResult(
    inspectedResult,
    privatePlaneOffsets,
    privateEndpoints,
    privateDiagnosticCounters,
  );
  const trustedRequest = materializeSliceBatchRequest(privateRequest, checkpoint);
  return parseSliceBatchResultWithTrustedRequest(
    privateResult,
    trustedRequest,
    checkpoint,
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
        takeSliceBatchRequestOwnership(inspectSliceBatchRequest(requestValue)),
        checkpoint,
      );
      this.#assertCurrent(operationToken);
      const controlled = this.#controlled;
      if (!controlled) {
        throw mappedRuntimeError('DISPOSED', 'WASM geometry kernel has been disposed');
      }
      const controlledCheckpoint = (): boolean => {
        try {
          const abort = readSliceKernelAbort(checkpoint);
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
