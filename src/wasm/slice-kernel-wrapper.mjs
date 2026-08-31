import * as generated from './generated/geometry_wasm.js';

const RESULT_VERSION = 1;
const STATUS_OK = 0;
const STATUS_GEOMETRY_EVIDENCE = 1;
const DIAGNOSTIC_COUNTER_COUNT = 9;
const MAX_ENDPOINT_VALUE_COUNT = 262_144 * 4;
const MAX_OWNED_ARRAY_BYTES = 8 * 1024 * 1024;
const DEADLINE_HOOK_NAME = '__shapecut_geometry_should_abort';
let activeKernelCall = false;

function requireTypedArray(value, constructor, name) {
  if (!(value instanceof constructor)) {
    throw new TypeError(`${name} must be a ${constructor.name}`);
  }
}

function checkedView(memoryBuffer, pointer, length, constructor, name, maximumLength) {
  if (!Number.isSafeInteger(pointer) || pointer < 0) {
    throw new Error(`${name} pointer is invalid`);
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
    throw new Error(`${name} length is invalid`);
  }
  if (pointer % constructor.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`${name} pointer is misaligned`);
  }
  const byteLength = length * constructor.BYTES_PER_ELEMENT;
  const end = pointer + byteLength;
  if (!Number.isSafeInteger(end) || end > memoryBuffer.byteLength) {
    throw new Error(`${name} view exceeds WASM memory`);
  }
  return new constructor(memoryBuffer, pointer, length);
}

function checkDeadline(deadlineHook) {
  if (typeof deadlineHook !== 'function') {
    throw new Error('deadline check failed closed');
  }
  let shouldAbort;
  try {
    shouldAbort = deadlineHook();
  } catch {
    throw new Error('deadline check failed closed');
  }
  if (typeof shouldAbort !== 'boolean') {
    throw new Error('deadline check failed closed');
  }
  if (shouldAbort) {
    throw new Error('slice batch was cancelled at a deadline checkpoint');
  }
}

/**
 * Sole bounded contiguous owned-output allocator. JavaScript TypedArray
 * construction unavoidably initializes the complete allocation in one
 * synchronous primitive, so every allocation is hard-capped at 8 MiB and has
 * strict fail-closed checkpoints immediately before and after construction.
 * Copying and semantic validation remain independently chunked afterward.
 */
function allocateOwnedArray(constructor, length, deadlineHook) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('owned output allocation length is invalid');
  }
  const byteLength = length * constructor.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_OWNED_ARRAY_BYTES) {
    throw new Error('owned output allocation exceeds the 8 MiB hard cap');
  }

  checkDeadline(deadlineHook);
  let owned;
  try {
    owned = new constructor(length);
  } catch {
    throw new Error('owned output allocation failed closed');
  }
  checkDeadline(deadlineHook);
  return owned;
}

function copyView(rawView, constructor, interval, deadlineHook) {
  const copy = allocateOwnedArray(constructor, rawView.length, deadlineHook);
  for (let start = 0; start < rawView.length; start += interval) {
    checkDeadline(deadlineHook);
    const end = Math.min(start + interval, rawView.length);
    copy.set(rawView.subarray(start, end), start);
  }
  return copy;
}

function copyAndValidateResult(
  rawResult,
  memoryBuffer,
  planeCount,
  interval,
  deadlineHook,
) {
  if (rawResult.version !== RESULT_VERSION) {
    throw new Error(`unsupported slice result version ${String(rawResult.version)}`);
  }
  if (rawResult.statusCode !== STATUS_OK && rawResult.statusCode !== STATUS_GEOMETRY_EVIDENCE) {
    throw new Error(`unsupported slice result status ${String(rawResult.statusCode)}`);
  }

  const expectedOffsetLength = planeCount + 1;
  const rawPlaneOffsets = checkedView(
    memoryBuffer,
    rawResult.planeOffsetsPtr,
    rawResult.planeOffsetsLen,
    Uint32Array,
    'plane offsets',
    expectedOffsetLength,
  );
  if (rawPlaneOffsets.length !== expectedOffsetLength) {
    throw new Error('plane offset count does not match requested planes');
  }
  const rawEndpoints = checkedView(
    memoryBuffer,
    rawResult.endpointsPtr,
    rawResult.endpointsLen,
    Float64Array,
    'endpoints',
    MAX_ENDPOINT_VALUE_COUNT,
  );
  const rawDiagnostics = checkedView(
    memoryBuffer,
    rawResult.diagnosticCountersPtr,
    rawResult.diagnosticCountersLen,
    Uint32Array,
    'diagnostic counters',
    DIAGNOSTIC_COUNTER_COUNT,
  );
  if (rawDiagnostics.length !== DIAGNOSTIC_COUNTER_COUNT) {
    throw new Error('diagnostic counter count does not match the result contract');
  }

  const planeOffsets = copyView(rawPlaneOffsets, Uint32Array, interval, deadlineHook);
  const endpoints = copyView(rawEndpoints, Float64Array, interval, deadlineHook);
  const diagnosticCounters = copyView(rawDiagnostics, Uint32Array, interval, deadlineHook);

  if (planeOffsets[0] !== 0) {
    throw new Error('plane offsets must start at zero');
  }
  for (let start = 0; start < planeOffsets.length; start += interval) {
    checkDeadline(deadlineHook);
    const end = Math.min(start + interval, planeOffsets.length);
    for (let index = Math.max(1, start); index < end; index += 1) {
      if (planeOffsets[index] < planeOffsets[index - 1]) {
        throw new Error('plane offsets must be monotonic');
      }
    }
  }
  if (endpoints.length % 4 !== 0) {
    throw new Error('endpoint values must contain complete segments');
  }
  const segmentCount = endpoints.length / 4;
  if (planeOffsets.at(-1) !== segmentCount || diagnosticCounters[4] !== segmentCount) {
    throw new Error('slice result segment counts are inconsistent');
  }
  for (let start = 0; start < endpoints.length; start += interval) {
    checkDeadline(deadlineHook);
    const end = Math.min(start + interval, endpoints.length);
    for (let index = start; index < end; index += 1) {
      if (!Number.isFinite(endpoints[index])) {
        throw new Error('slice result endpoints must be finite');
      }
    }
  }

  return Object.freeze({
    version: rawResult.version,
    statusCode: rawResult.statusCode,
    planeOffsets,
    endpoints,
    diagnosticCounters,
  });
}

export function initializeSliceKernel(wasmBytes) {
  const runtime = generated.initSync({ module: wasmBytes });

  return Object.freeze({
    sliceLayerBatch(request, options = {}) {
      if (request === null || typeof request !== 'object') {
        throw new TypeError('slice request must be an object');
      }
      const { positions, indices, planes, deadlineCheckInterval } = request;
      requireTypedArray(positions, Float32Array, 'positions');
      requireTypedArray(indices, Uint32Array, 'indices');
      requireTypedArray(planes, Float64Array, 'planes');
      if (options === null || typeof options !== 'object') {
        throw new TypeError('slice options must be an object');
      }
      const { deadlineHook } = options;
      if (activeKernelCall) {
        throw new Error('slice kernel calls must not be reentrant');
      }
      activeKernelCall = true;

      const previousHookDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        DEADLINE_HOOK_NAME,
      );
      let rawResult;
      try {
        if (deadlineHook === undefined) {
          delete globalThis[DEADLINE_HOOK_NAME];
        } else {
          globalThis[DEADLINE_HOOK_NAME] = deadlineHook;
        }
        rawResult = generated.slice_layer_batch(
          positions,
          indices,
          planes,
          deadlineCheckInterval,
        );
        return copyAndValidateResult(
          rawResult,
          runtime.memory.buffer,
          planes.length,
          deadlineCheckInterval,
          deadlineHook,
        );
      } finally {
        try {
          rawResult?.free();
        } finally {
          try {
            if (previousHookDescriptor === undefined) {
              delete globalThis[DEADLINE_HOOK_NAME];
            } else {
              Object.defineProperty(globalThis, DEADLINE_HOOK_NAME, previousHookDescriptor);
            }
          } finally {
            activeKernelCall = false;
          }
        }
      }
    },
  });
}
