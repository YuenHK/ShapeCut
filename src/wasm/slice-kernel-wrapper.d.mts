import type { SliceBatchRequest } from './slice-kernel-contract';

export type SliceKernelBoundaryErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESULT'
  | 'RESOURCE_LIMIT'
  | 'DEADLINE_CHECK_FAILED'
  | 'DEADLINE_EXCEEDED'
  | 'EXECUTION_FAILED';
export type SliceKernelBoundaryPhase = 'request' | 'execution' | 'result';

export class SliceKernelBoundaryError extends Error {
  readonly code: SliceKernelBoundaryErrorCode;
  readonly phase: SliceKernelBoundaryPhase;
}

export interface ControlledSliceBatchResult {
  readonly version: unknown;
  readonly statusCode: unknown;
  readonly planeOffsets: unknown;
  readonly endpoints: unknown;
  readonly diagnosticCounters: unknown;
}

export interface ControlledSliceKernel {
  sliceLayerBatch(
    request: SliceBatchRequest,
    options: { readonly deadlineHook: () => boolean },
  ): ControlledSliceBatchResult;
}

export function initializeSliceKernel(wasmBytes: BufferSource): ControlledSliceKernel;
