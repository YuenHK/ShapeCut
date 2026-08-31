import type { SliceBatchRequest } from './slice-kernel-contract';

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
