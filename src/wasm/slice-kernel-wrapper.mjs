import * as generated from './generated/geometry_wasm.js';

const RESULT_VERSION = 1;
const STATUS_OK = 0;
const STATUS_GEOMETRY_EVIDENCE = 1;
const DIAGNOSTIC_COUNTER_COUNT = 9;
const MAX_ENDPOINT_VALUE_COUNT = 262_144 * 4;
const MAX_OWNED_ARRAY_BYTES = 8 * 1024 * 1024;
const DEADLINE_HOOK_NAME = '__shapecut_geometry_should_abort';
let activeKernelCall = false;

const BOUNDARY_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_RESULT',
  'RESOURCE_LIMIT',
  'DEADLINE_CHECK_FAILED',
  'DEADLINE_EXCEEDED',
  'EXECUTION_FAILED',
]);
const BOUNDARY_PHASES = new Set(['request', 'execution', 'result']);

export class SliceKernelBoundaryError extends Error {
  constructor(code, phase, message) {
    super(message);
    this.name = 'SliceKernelBoundaryError';
    this.code = code;
    this.phase = phase;
  }
}

function boundaryError(code, phase, message) {
  return new SliceKernelBoundaryError(code, phase, message);
}

function normalizeGeneratedError(error) {
  const code = error?.code;
  const phase = error?.phase;
  if (BOUNDARY_CODES.has(code) && BOUNDARY_PHASES.has(phase)) {
    return boundaryError(code, phase, 'WASM geometry kernel rejected the operation');
  }
  return boundaryError('EXECUTION_FAILED', 'execution', 'WASM geometry kernel execution failed');
}

function requireTypedArray(value, constructor, name) {
  if (!(value instanceof constructor)) {
    throw boundaryError('INVALID_REQUEST', 'request', `${name} must be a ${constructor.name}`);
  }
}

function checkedView(memoryBuffer, pointer, length, constructor, name, maximumLength) {
  if (!Number.isSafeInteger(pointer) || pointer < 0) {
    throw boundaryError('INVALID_RESULT', 'result', `${name} pointer is invalid`);
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
    throw boundaryError('INVALID_RESULT', 'result', `${name} length is invalid`);
  }
  if (pointer % constructor.BYTES_PER_ELEMENT !== 0) {
    throw boundaryError('INVALID_RESULT', 'result', `${name} pointer is misaligned`);
  }
  const byteLength = length * constructor.BYTES_PER_ELEMENT;
  const end = pointer + byteLength;
  if (!Number.isSafeInteger(end) || end > memoryBuffer.byteLength) {
    throw boundaryError('INVALID_RESULT', 'result', `${name} view exceeds WASM memory`);
  }
  return new constructor(memoryBuffer, pointer, length);
}

function checkDeadline(deadlineHook) {
  if (typeof deadlineHook !== 'function') {
    throw boundaryError('DEADLINE_CHECK_FAILED', 'execution', 'deadline check failed closed');
  }
  let shouldAbort;
  try {
    shouldAbort = deadlineHook();
  } catch {
    throw boundaryError('DEADLINE_CHECK_FAILED', 'execution', 'deadline check failed closed');
  }
  if (typeof shouldAbort !== 'boolean') {
    throw boundaryError('DEADLINE_CHECK_FAILED', 'execution', 'deadline check failed closed');
  }
  if (shouldAbort) {
    throw boundaryError(
      'DEADLINE_EXCEEDED',
      'execution',
      'slice batch was cancelled at a deadline checkpoint',
    );
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
    throw boundaryError('INVALID_RESULT', 'result', 'owned output allocation length is invalid');
  }
  const byteLength = length * constructor.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_OWNED_ARRAY_BYTES) {
    throw boundaryError(
      'RESOURCE_LIMIT',
      'result',
      'owned output allocation exceeds the 8 MiB hard cap',
    );
  }

  checkDeadline(deadlineHook);
  let owned;
  try {
    owned = new constructor(length);
  } catch {
    throw boundaryError('RESOURCE_LIMIT', 'result', 'owned output allocation failed closed');
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
    throw boundaryError(
      'INVALID_RESULT',
      'result',
      `unsupported slice result version ${String(rawResult.version)}`,
    );
  }
  if (rawResult.statusCode !== STATUS_OK && rawResult.statusCode !== STATUS_GEOMETRY_EVIDENCE) {
    throw boundaryError(
      'INVALID_RESULT',
      'result',
      `unsupported slice result status ${String(rawResult.statusCode)}`,
    );
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
    throw boundaryError(
      'INVALID_RESULT',
      'result',
      'plane offset count does not match requested planes',
    );
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
    throw boundaryError(
      'INVALID_RESULT',
      'result',
      'diagnostic counter count does not match the result contract',
    );
  }

  const planeOffsets = copyView(rawPlaneOffsets, Uint32Array, interval, deadlineHook);
  const endpoints = copyView(rawEndpoints, Float64Array, interval, deadlineHook);
  const diagnosticCounters = copyView(rawDiagnostics, Uint32Array, interval, deadlineHook);

  if (planeOffsets[0] !== 0) {
    throw boundaryError('INVALID_RESULT', 'result', 'plane offsets must start at zero');
  }
  for (let start = 0; start < planeOffsets.length; start += interval) {
    checkDeadline(deadlineHook);
    const end = Math.min(start + interval, planeOffsets.length);
    for (let index = Math.max(1, start); index < end; index += 1) {
      if (planeOffsets[index] < planeOffsets[index - 1]) {
        throw boundaryError('INVALID_RESULT', 'result', 'plane offsets must be monotonic');
      }
    }
  }
  if (endpoints.length % 4 !== 0) {
    throw boundaryError(
      'INVALID_RESULT',
      'result',
      'endpoint values must contain complete segments',
    );
  }
  const segmentCount = endpoints.length / 4;
  if (planeOffsets.at(-1) !== segmentCount || diagnosticCounters[4] !== segmentCount) {
    throw boundaryError(
      'INVALID_RESULT',
      'result',
      'slice result segment counts are inconsistent',
    );
  }
  for (let start = 0; start < endpoints.length; start += interval) {
    checkDeadline(deadlineHook);
    const end = Math.min(start + interval, endpoints.length);
    for (let index = start; index < end; index += 1) {
      if (!Number.isFinite(endpoints[index])) {
        throw boundaryError('INVALID_RESULT', 'result', 'slice result endpoints must be finite');
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
        throw boundaryError('INVALID_REQUEST', 'request', 'slice request must be an object');
      }
      const { positions, indices, planes, deadlineCheckInterval } = request;
      requireTypedArray(positions, Float32Array, 'positions');
      requireTypedArray(indices, Uint32Array, 'indices');
      requireTypedArray(planes, Float64Array, 'planes');
      if (options === null || typeof options !== 'object') {
        throw boundaryError('INVALID_REQUEST', 'request', 'slice options must be an object');
      }
      const { deadlineHook } = options;
      if (activeKernelCall) {
        throw boundaryError(
          'EXECUTION_FAILED',
          'execution',
          'slice kernel calls must not be reentrant',
        );
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
        try {
          rawResult = generated.slice_layer_batch(
            positions,
            indices,
            planes,
            deadlineCheckInterval,
          );
        } catch (error) {
          throw normalizeGeneratedError(error);
        }
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
