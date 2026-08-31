import {
  SliceKernelError,
  loadSliceKernel,
  type SliceKernelAbort,
} from '../wasm/slice-kernel-contract';
import type {
  SliceWorkerErrorMessage,
  SliceWorkerRequestMessage,
  SliceWorkerResultMessage,
} from './slice-worker-pool';

let busy = false;

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (busy) return;
  busy = true;
  void execute(event.data);
});

async function execute(value: unknown): Promise<void> {
  let request: SliceWorkerRequestMessage | undefined;
  try {
    request = validateRequest(value);
    const kernel = await loadSliceKernel();
    const checkpoint = (): SliceKernelAbort | undefined => (
      Date.now() >= request!.deadlineAt
        ? Object.freeze({ reason: 'deadline', source: 'runtime-deadline' })
        : undefined
    );
    const result = await kernel.sliceLayerBatch({
      positions: request.positions,
      indices: request.indices,
      planes: request.planes,
      deadlineCheckInterval: request.deadlineCheckInterval,
    }, checkpoint);
    const planeOffsets = Uint32Array.from(result.planeOffsets);
    const endpoints = Float64Array.from(result.endpoints);
    const diagnosticCounters = Uint32Array.from(result.diagnosticCounters);
    const response: SliceWorkerResultMessage = {
      type: 'slice-result',
      generation: request.generation,
      partitionIndex: request.partitionIndex,
      version: result.version,
      statusCode: result.statusCode,
      planeOffsets,
      endpoints,
      diagnosticCounters,
    };
    globalThis.postMessage(response, {
      transfer: [planeOffsets.buffer, endpoints.buffer, diagnosticCounters.buffer],
    });
  } catch (error) {
    if (!request) return;
    const response: SliceWorkerErrorMessage = {
      type: 'slice-error',
      generation: request.generation,
      partitionIndex: request.partitionIndex,
      code: mapWorkerError(error),
    };
    globalThis.postMessage(response);
  }
}

function validateRequest(value: unknown): SliceWorkerRequestMessage {
  if (value === null || typeof value !== 'object') throw new TypeError('invalid worker request');
  const request = value as Partial<SliceWorkerRequestMessage>;
  if (request.type !== 'slice'
    || !Number.isSafeInteger(request.generation)
    || !Number.isSafeInteger(request.partitionIndex)
    || request.partitionIndex! < 0
    || Object.getPrototypeOf(request.positions) !== Float32Array.prototype
    || Object.getPrototypeOf(request.indices) !== Uint32Array.prototype
    || Object.getPrototypeOf(request.planes) !== Float64Array.prototype
    || !Number.isSafeInteger(request.deadlineCheckInterval)
    || request.deadlineCheckInterval! < 1
    || request.deadlineCheckInterval! > 4_096
    || !Number.isSafeInteger(request.deadlineAt)) {
    throw new TypeError('invalid worker request');
  }
  return request as SliceWorkerRequestMessage;
}

function mapWorkerError(error: unknown): SliceWorkerErrorMessage['code'] {
  if (!(error instanceof SliceKernelError)) return 'EXECUTION_FAILED';
  switch (error.code) {
    case 'LOAD_FAILED':
    case 'EXECUTION_FAILED':
    case 'INVALID_REQUEST':
    case 'INVALID_RESULT':
    case 'RESOURCE_LIMIT':
    case 'DEADLINE_CHECK_FAILED':
    case 'DEADLINE_EXCEEDED':
    case 'CANCELLED':
    case 'DISPOSED':
      return error.code;
    case 'FALLBACK_NOT_ALLOWED':
    case 'PUBLICATION_CONFLICT':
      return 'EXECUTION_FAILED';
  }
}
