/* tslint:disable */
/* eslint-disable */

export class SliceBatchResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly diagnosticCountersLen: number;
    readonly diagnosticCountersPtr: number;
    readonly endpointsLen: number;
    readonly endpointsPtr: number;
    readonly planeOffsetsLen: number;
    readonly planeOffsetsPtr: number;
    readonly statusCode: number;
    readonly version: number;
}

export function slice_layer_batch(positions: Float32Array, indices: Uint32Array, planes: Float64Array, deadline_check_interval: any): SliceBatchResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_slicebatchresult_free: (a: number, b: number) => void;
    readonly slice_layer_batch: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly slicebatchresult_diagnosticCountersLen: (a: number) => number;
    readonly slicebatchresult_diagnosticCountersPtr: (a: number) => number;
    readonly slicebatchresult_endpointsLen: (a: number) => number;
    readonly slicebatchresult_endpointsPtr: (a: number) => number;
    readonly slicebatchresult_planeOffsetsLen: (a: number) => number;
    readonly slicebatchresult_planeOffsetsPtr: (a: number) => number;
    readonly slicebatchresult_statusCode: (a: number) => number;
    readonly slicebatchresult_version: (a: number) => number;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
