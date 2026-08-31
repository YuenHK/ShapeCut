import {
  SliceKernelError,
  parseSliceBatchResult,
  readSliceKernelAbort,
  sliceKernelAbortError,
  validateSliceBatchRequest,
  type SliceKernelAbort,
  type SliceBatchRequest,
  type SliceBatchResult,
  type SliceKernel,
  type SliceKernelCheckpoint,
  type SliceKernelErrorCode,
} from './slice-kernel-contract';
import {
  SliceKernelBoundaryError,
  initializeSliceKernel,
} from './slice-kernel-wrapper.mjs';

const WASM_ASSET_URL = new URL('./generated/geometry_wasm_bg.wasm', import.meta.url);

function mappedError(code: SliceKernelErrorCode, message: string): SliceKernelError {
  return new SliceKernelError(code, message);
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
    return mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
  }
  switch (error.code) {
    case 'INVALID_REQUEST':
      return error.phase === 'request'
        ? mappedError('INVALID_REQUEST', 'WASM geometry request was rejected')
        : mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'INVALID_RESULT':
      return error.phase === 'result'
        ? mappedError('INVALID_RESULT', 'WASM geometry result was rejected')
        : mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'RESOURCE_LIMIT':
      return mappedError('RESOURCE_LIMIT', 'WASM geometry resource limit was exceeded');
    case 'DEADLINE_CHECK_FAILED':
      return error.phase === 'execution'
        ? mappedError('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed')
        : mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'DEADLINE_EXCEEDED':
      return error.phase === 'execution'
        ? mappedError('DEADLINE_EXCEEDED', 'WASM geometry deadline was exceeded')
        : mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
    case 'EXECUTION_FAILED':
      return mappedError('EXECUTION_FAILED', 'WASM geometry execution failed');
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
    const operationToken = Object.freeze({ kernel: this, generation: this.generation });
    this.#assertCurrent(operationToken);

    let request: SliceBatchRequest;
    let observedAbort: SliceKernelAbort | undefined;
    let checkpointFailure: SliceKernelError | undefined;
    try {
      request = validateSliceBatchRequest(requestValue, checkpoint);
      this.#assertCurrent(operationToken);
      const controlled = this.#controlled;
      if (!controlled) throw mappedError('DISPOSED', 'WASM geometry kernel has been disposed');
      const controlledCheckpoint = (): boolean => {
        try {
          const abort = readSliceKernelAbort(checkpoint);
          if (!abort) return false;
          observedAbort = abort;
          return true;
        } catch (error) {
          checkpointFailure = error instanceof SliceKernelError
            ? error
            : mappedError('DEADLINE_CHECK_FAILED', 'WASM geometry checkpoint failed closed');
          throw checkpointFailure;
        }
      };
      const encoded = controlled.sliceLayerBatch(request, { deadlineHook: controlledCheckpoint });
      this.#assertCurrent(operationToken);
      const result = parseSliceBatchResult(encoded, request, checkpoint);
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
      throw mappedError('DISPOSED', 'WASM geometry kernel has been disposed');
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
  const kernel = activeKernel;
  generation += 1;
  activeKernel = undefined;
  activeLoad = undefined;
  kernel?.dispose();
}
