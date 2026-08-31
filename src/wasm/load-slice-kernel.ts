import {
  SliceKernelError,
  parseSliceBatchResult,
  validateSliceBatchRequest,
  type SliceBatchRequest,
  type SliceBatchResult,
  type SliceKernel,
  type SliceKernelCheckpoint,
  type SliceKernelErrorCode,
} from './slice-kernel-contract';
import { initializeSliceKernel } from './slice-kernel-wrapper.mjs';

const WASM_ASSET_URL = new URL('./generated/geometry_wasm_bg.wasm', import.meta.url);

function mappedError(code: SliceKernelErrorCode, message: string): SliceKernelError {
  return new SliceKernelError(code, message);
}

function mapExecutionError(error: unknown): SliceKernelError {
  if (error instanceof SliceKernelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled at a deadline checkpoint/i.test(message)) {
    return mappedError('DEADLINE_EXCEEDED', 'WASM geometry deadline was exceeded');
  }
  if (/deadline check failed closed/i.test(message)) {
    return mappedError('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
  }
  if (/limit|allocation|overflow/i.test(message)) {
    return mappedError('RESOURCE_LIMIT', 'WASM geometry resource limit was exceeded');
  }
  if (/positions|indices|triangle|vertex|planes|checkpoint interval/i.test(message)) {
    return mappedError('INVALID_REQUEST', 'WASM geometry request was rejected');
  }
  return mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
}

class BrowserSliceKernel implements SliceKernel {
  #disposed = false;
  #controlled: ReturnType<typeof initializeSliceKernel> | undefined;

  constructor(controlled: ReturnType<typeof initializeSliceKernel>) {
    this.#controlled = controlled;
  }

  async sliceLayerBatch(
    requestValue: SliceBatchRequest,
    checkpoint: SliceKernelCheckpoint,
  ): Promise<SliceBatchResult> {
    if (this.#disposed) {
      throw mappedError('DISPOSED', 'WASM geometry kernel has been disposed');
    }

    let request: SliceBatchRequest;
    try {
      request = validateSliceBatchRequest(requestValue, checkpoint);
      const controlled = this.#controlled;
      if (!controlled) throw mappedError('DISPOSED', 'WASM geometry kernel has been disposed');
      const encoded = controlled.sliceLayerBatch(request, { deadlineHook: checkpoint });
      return parseSliceBatchResult(encoded, request, checkpoint);
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#controlled = undefined;
  }
}

let activeKernel: SliceKernel | undefined;
let activeLoad: Promise<SliceKernel> | undefined;
let generation = 0;

async function createBrowserSliceKernel(expectedGeneration: number): Promise<SliceKernel> {
  try {
    const response = await fetch(WASM_ASSET_URL);
    if (!response.ok) throw new Error('WASM asset request failed');
    const bytes = await response.arrayBuffer();
    const kernel: SliceKernel = new BrowserSliceKernel(initializeSliceKernel(bytes));
    if (generation !== expectedGeneration) {
      kernel.dispose();
      throw mappedError('DISPOSED', 'WASM geometry kernel load was disposed');
    }
    activeKernel = kernel;
    return kernel;
  } catch (error) {
    if (error instanceof SliceKernelError && error.code === 'DISPOSED') throw error;
    throw mappedError('LOAD_FAILED', 'WASM geometry kernel could not be loaded');
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
  generation += 1;
  activeKernel?.dispose();
  activeKernel = undefined;
  activeLoad = undefined;
}
