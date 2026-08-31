import {
  SliceKernelError,
  inspectSliceWorkerResultArrays,
} from '../wasm/slice-kernel-contract';
import {
  SliceKernelBoundaryError,
  initializeSliceKernel,
  type ControlledSliceBatchResult,
  type ControlledSliceKernel,
} from '../wasm/slice-kernel-wrapper.mjs';
import type {
  SliceWorkerErrorMessage,
  SliceWorkerRequestMessage,
} from './slice-worker-pool';

const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const objectFreeze = Object.freeze;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectDefineProperty = Object.defineProperty;
const ArrayIntrinsic = Array;
const arrayIterator = objectGetOwnPropertyDescriptor(
  ArrayIntrinsic.prototype,
  Symbol.iterator,
)?.value;
const arrayIteratorPrototype = typeof arrayIterator === 'function'
  ? objectGetPrototypeOf(reflectApply(arrayIterator, new ArrayIntrinsic(), []))
  : undefined;
const arrayIteratorNext = arrayIteratorPrototype === undefined
  ? undefined
  : objectGetOwnPropertyDescriptor(arrayIteratorPrototype, 'next')?.value;
const typedArrayPrototype = objectGetPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = objectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
)?.get;
const arrayBufferPrototype = ArrayBuffer.prototype;
const arrayBufferByteLengthGetter = objectGetOwnPropertyDescriptor(
  arrayBufferPrototype,
  'byteLength',
)?.get;
const arrayBufferSlice = objectGetOwnPropertyDescriptor(arrayBufferPrototype, 'slice')?.value;
const addEventListenerIntrinsic = objectGetOwnPropertyDescriptor(
  EventTarget.prototype,
  'addEventListener',
)?.value;
const postMessageIntrinsic = globalThis.postMessage;
const fetchIntrinsic = globalThis.fetch.bind(globalThis);
const dateNowIntrinsic = Date.now;
const WASM_ASSET_URL = new URL('../wasm/generated/geometry_wasm_bg.wasm', import.meta.url);

class WorkerLoadError extends Error {}

interface PrivateControlledResult {
  readonly version: unknown;
  readonly statusCode: unknown;
  readonly planeOffsets: Uint32Array;
  readonly endpoints: Float64Array;
  readonly diagnosticCounters: Uint32Array;
  readonly buffers: readonly [ArrayBuffer, ArrayBuffer, ArrayBuffer];
}

let busy = false;
let controlledLoad: Promise<ControlledSliceKernel> | undefined;

if (typeof addEventListenerIntrinsic !== 'function') {
  throw new TypeError('captured worker event primitive is unavailable');
}
reflectApply(addEventListenerIntrinsic, globalThis, ['message', (event: MessageEvent<unknown>) => {
  if (busy) return;
  busy = true;
  void execute(event.data);
}]);

async function execute(value: unknown): Promise<void> {
  let request: SliceWorkerRequestMessage | undefined;
  try {
    request = validateRequest(value);
    const controlled = await loadControlledKernel();
    const result = controlled.sliceLayerBatch({
      positions: request.positions,
      indices: request.indices,
      planes: request.planes,
      deadlineCheckInterval: request.deadlineCheckInterval,
    }, {
      deadlineHook: () => reflectApply(dateNowIntrinsic, Date, []) >= request!.deadlineAt,
    });
    publishPrivateResult(inspectControlledResult(result), request);
  } catch (error) {
    if (!request) return;
    const response: SliceWorkerErrorMessage = objectFreeze({
      type: 'slice-error',
      generation: request.generation,
      partitionIndex: request.partitionIndex,
      code: mapWorkerError(error),
    });
    if (typeof postMessageIntrinsic === 'function') {
      reflectApply(postMessageIntrinsic, globalThis, [response]);
    }
  }
}

async function loadControlledKernel(): Promise<ControlledSliceKernel> {
  if (!controlledLoad) {
    controlledLoad = (async () => {
      try {
        const response = await fetchIntrinsic(WASM_ASSET_URL);
        if (!response.ok) throw new WorkerLoadError();
        return initializeSliceKernel(await response.arrayBuffer());
      } catch (error) {
        if (error instanceof WorkerLoadError) throw error;
        throw new WorkerLoadError();
      }
    })();
  }
  return controlledLoad;
}

function inspectControlledResult(value: ControlledSliceBatchResult): PrivateControlledResult {
  if (objectGetPrototypeOf(value) !== Object.prototype) throw new TypeError('invalid controlled result');
  const keys = reflectOwnKeys(value);
  const expected = [
    'version',
    'statusCode',
    'planeOffsets',
    'endpoints',
    'diagnosticCounters',
  ] as const;
  if (keys.length !== expected.length) throw new TypeError('invalid controlled result');
  const snapshot = new ArrayIntrinsic<unknown>(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) throw new TypeError('invalid controlled result');
    const descriptor = objectGetOwnPropertyDescriptor(value, expected[index]);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('invalid controlled result');
    snapshot[index] = descriptor.value as unknown;
  }
  const inspected = inspectSliceWorkerResultArrays(snapshot[2], snapshot[3], snapshot[4]);
  if (typeof typedArrayBufferGetter !== 'function') {
    throw new TypeError('captured typed-array buffer primitive is unavailable');
  }
  return objectFreeze({
    version: snapshot[0],
    statusCode: snapshot[1],
    planeOffsets: inspected.planeOffsets.value,
    endpoints: inspected.endpoints.value,
    diagnosticCounters: inspected.diagnosticCounters.value,
    buffers: objectFreeze([
      reflectApply(typedArrayBufferGetter, inspected.planeOffsets.value, []) as ArrayBuffer,
      reflectApply(typedArrayBufferGetter, inspected.endpoints.value, []) as ArrayBuffer,
      reflectApply(typedArrayBufferGetter, inspected.diagnosticCounters.value, []) as ArrayBuffer,
    ]) as unknown as readonly [ArrayBuffer, ArrayBuffer, ArrayBuffer],
  });
}

function publishPrivateResult(
  result: PrivateControlledResult,
  request: SliceWorkerRequestMessage,
): void {
  if (typeof postMessageIntrinsic !== 'function'
    || typeof arrayIterator !== 'function'
    || typeof arrayIteratorNext !== 'function') {
    throw new TypeError('captured worker transfer primitives are unavailable');
  }
  const transfer = new ArrayIntrinsic<ArrayBuffer>(3);
  transfer[0] = result.buffers[0];
  transfer[1] = result.buffers[1];
  transfer[2] = result.buffers[2];
  objectDefineProperty(transfer, Symbol.iterator, {
    configurable: false,
    enumerable: false,
    value: createPrivateTransferIterator,
    writable: false,
  });
  objectFreeze(transfer);
  const response = objectFreeze({
    type: 'slice-result' as const,
    generation: request.generation,
    partitionIndex: request.partitionIndex,
    version: result.version,
    statusCode: result.statusCode,
    planeOffsets: result.planeOffsets,
    endpoints: result.endpoints,
    diagnosticCounters: result.diagnosticCounters,
  });
  reflectApply(postMessageIntrinsic, globalThis, [response, objectFreeze({ transfer })]);
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
      throw new TypeError('slice worker result transfer did not detach an owned buffer');
    }
  }
}

function createPrivateTransferIterator(this: unknown): object {
  const iterator = reflectApply(arrayIterator, this, []) as unknown;
  if (iterator === null || typeof iterator !== 'object') {
    throw new TypeError('worker transfer iterator creation failed');
  }
  objectDefineProperty(iterator, 'next', {
    configurable: false,
    enumerable: false,
    value: arrayIteratorNext,
    writable: false,
  });
  return iterator;
}

function validateRequest(value: unknown): SliceWorkerRequestMessage {
  if (value === null || typeof value !== 'object') throw new TypeError('invalid worker request');
  const request = value as Partial<SliceWorkerRequestMessage>;
  if (request.type !== 'slice'
    || !Number.isSafeInteger(request.generation)
    || !Number.isSafeInteger(request.partitionIndex)
    || request.partitionIndex! < 0
    || objectGetPrototypeOf(request.positions) !== Float32Array.prototype
    || objectGetPrototypeOf(request.indices) !== Uint32Array.prototype
    || objectGetPrototypeOf(request.planes) !== Float64Array.prototype
    || !Number.isSafeInteger(request.deadlineCheckInterval)
    || request.deadlineCheckInterval! < 1
    || request.deadlineCheckInterval! > 4_096
    || !Number.isSafeInteger(request.deadlineAt)) {
    throw new TypeError('invalid worker request');
  }
  return request as SliceWorkerRequestMessage;
}

function mapWorkerError(error: unknown): SliceWorkerErrorMessage['code'] {
  if (error instanceof WorkerLoadError) return 'LOAD_FAILED';
  if (error instanceof SliceKernelBoundaryError) {
    switch (error.code) {
      case 'INVALID_REQUEST':
      case 'INVALID_RESULT':
      case 'RESOURCE_LIMIT':
      case 'DEADLINE_CHECK_FAILED':
      case 'DEADLINE_EXCEEDED':
      case 'EXECUTION_FAILED':
        return error.code;
    }
  }
  if (error instanceof SliceKernelError) {
    switch (error.code) {
      case 'INVALID_REQUEST':
      case 'INVALID_RESULT':
      case 'RESOURCE_LIMIT':
      case 'DEADLINE_CHECK_FAILED':
      case 'DEADLINE_EXCEEDED':
      case 'CANCELLED':
      case 'DISPOSED':
      case 'LOAD_FAILED':
      case 'EXECUTION_FAILED':
        return error.code;
      case 'FALLBACK_NOT_ALLOWED':
      case 'PUBLICATION_CONFLICT':
        return 'EXECUTION_FAILED';
    }
  }
  return 'EXECUTION_FAILED';
}
