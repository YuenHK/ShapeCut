import { describe, expect, it, vi } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import { projectMesh, type ProjectedMesh } from './raster';
import type { OutlineAxisSelection, OutlineLayerSpec } from './types';
import {
  ExactSegmentSourceError,
  TypeScriptExactSegmentSource,
  WasmExactSegmentSource,
  type ExactSegmentBatchRunner,
} from './segment-source';
import {
  SLICE_RESULT_VERSION,
  SLICE_STATUS_OK,
  type ReadonlySliceArray,
  type SliceBatchResult,
} from '../../wasm/slice-kernel-contract';

const selection: OutlineAxisSelection = {
  source: 'candidate',
  axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
};
const specs: readonly OutlineLayerSpec[] = [
  { index: 0, zStart: -0.5, zEnd: 0.5, zMid: 0 },
];

function mesh(positions: readonly number[], indices: readonly number[]): TriangleMesh {
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function box(): TriangleMesh {
  return mesh([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ], [
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7,
  ]);
}

class ArrayFacade implements ReadonlySliceArray {
  readonly elementType: 'uint32' | 'float64';
  readonly length: number;
  readonly byteLength: number;
  readonly #values: readonly number[];

  constructor(values: readonly number[], elementType: 'uint32' | 'float64') {
    this.#values = values;
    this.elementType = elementType;
    this.length = values.length;
    this.byteLength = values.length * (elementType === 'uint32' ? 4 : 8);
  }

  at(index: number): number | undefined { return this.#values.at(index); }
  *[Symbol.iterator](): IterableIterator<number> { yield* this.#values; }
}

function result(endpoints: readonly number[], offsets = [0, endpoints.length / 4]): SliceBatchResult {
  const diagnostics = new Array(9).fill(0) as number[];
  diagnostics[3] = 12;
  diagnostics[4] = endpoints.length / 4;
  return Object.freeze({
    version: SLICE_RESULT_VERSION,
    statusCode: SLICE_STATUS_OK,
    planeOffsets: new ArrayFacade(offsets, 'uint32'),
    endpoints: new ArrayFacade(endpoints, 'float64'),
    diagnosticCounters: new ArrayFacade(diagnostics, 'uint32'),
  });
}

function runner(
  output: SliceBatchResult | Error,
  fallbackEligible = false,
): ExactSegmentBatchRunner {
  return {
    run: vi.fn(async () => {
      if (output instanceof Error) throw output;
      return output;
    }),
    isFallbackEligible: (error) => fallbackEligible && error === output,
  };
}

describe('exact segment sources', () => {
  it('collects the existing TypeScript oracle in deterministic plane and endpoint order', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const source = new TypeScriptExactSegmentSource();

    const first = await source.collect(projected, specs, Infinity, () => undefined);
    const second = await source.collect(projected, specs, Infinity, () => undefined);

    expect(first).toEqual(second);
    expect(first.origin).toBe('typescript');
    expect(first.layers).toHaveLength(1);
    expect(first.layers[0].segments).toHaveLength(8);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.layers[0].segments)).toBe(true);
  });

  it('selects the TypeScript source before worker startup for a small batch', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const batchRunner = runner(result([]));
    const source = new WasmExactSegmentSource({
      runner: batchRunner,
      compareWithTypeScript: false,
    });

    const collected = await source.collect(projected, specs, Infinity, () => undefined);

    expect(collected.origin).toBe('typescript');
    expect(batchRunner.run).not.toHaveBeenCalled();
  });

  it('canonicalizes WASM segment direction and ordering before topology can consume it', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const batch = result([
      1, 1, 1, -1,
      -1, 1, 1, 1,
      1, -1, -1, -1,
      1, 1, 1, -1,
    ]);
    const source = new WasmExactSegmentSource({
      runner: runner(batch),
      compareWithTypeScript: false,
      minimumWasmWork: 0,
    });

    const collected = await source.collect(projected, specs, Infinity, () => undefined);

    expect(collected.origin).toBe('wasm');
    expect(collected.layers[0].segments).toEqual([
      [[-1, -1], [1, -1]],
      [[-1, 1], [1, 1]],
      [[1, -1], [1, 1]],
      [[1, -1], [1, 1]],
    ]);
  });

  it('does not run an implicit full TypeScript oracle when differential mode is omitted', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const source = new WasmExactSegmentSource({
      runner: runner(result([])),
      minimumWasmWork: 0,
    });

    await expect(source.collect(projected, specs, Infinity, () => undefined))
      .resolves.toMatchObject({ origin: 'wasm' });
  });

  it('routes a non-exact differential result to the original TypeScript mesh before publication', async () => {
    const projected: ProjectedMesh = Object.freeze({
      vertices: Object.freeze([
        Object.freeze([0.1, 0, -1] as const),
        Object.freeze([1.1, 0, 1] as const),
        Object.freeze([0.1, 1, 1] as const),
      ]),
      triangles: Object.freeze([Object.freeze([0, 1, 2] as const)]),
      minX: 0.1,
      minY: 0,
      maxX: 1.1,
      maxY: 1,
      planarDiameter: Math.SQRT2,
    });
    const x0 = Math.fround(0.1), x1 = Math.fround(1.1);
    const publication = vi.fn();
    const source = new WasmExactSegmentSource({
      runner: runner(result([
        x0 + (x1 - x0) * 0.5, 0, x0, 0.5,
      ])),
      compareWithTypeScript: true,
      minimumWasmWork: 0,
      onPublication: publication,
    });

    const collected = await source.collect(projected, specs, Infinity, () => undefined);

    expect(collected.origin).toBe('typescript');
    expect(collected.layers[0].segments).toEqual([
      [[0.6, 0], [0.1, 0.5]],
    ]);
    expect(publication).not.toHaveBeenCalled();
  });

  it('routes explicit differential topology mismatch to TypeScript before publication', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const publication = vi.fn();
    const source = new WasmExactSegmentSource({
      runner: runner(result([0, 0, 1, 1])),
      compareWithTypeScript: true,
      minimumWasmWork: 0,
      onPublication: publication,
    });

    await expect(source.collect(projected, specs, Infinity, () => undefined))
      .resolves.toMatchObject({ origin: 'typescript' });
    expect(publication).not.toHaveBeenCalled();
  });

  it('preselects the original TypeScript source for Float32-unsafe coordinates without starting a worker', async () => {
    const projected: ProjectedMesh = Object.freeze({
      vertices: Object.freeze([
        Object.freeze([100_000_000.25, 0, -1] as const),
        Object.freeze([100_000_001.25, 0, 1] as const),
        Object.freeze([100_000_000.25, 1, 1] as const),
      ]),
      triangles: Object.freeze([Object.freeze([0, 1, 2] as const)]),
      minX: 100_000_000.25,
      minY: 0,
      maxX: 100_000_001.25,
      maxY: 1,
      planarDiameter: Math.SQRT2,
    });
    const batchRunner = runner(result([]));
    const source = new WasmExactSegmentSource({
      runner: batchRunner,
      compareWithTypeScript: false,
      minimumWasmWork: 0,
    });

    const collected = await source.collect(projected, specs, Infinity, () => undefined);

    expect(collected.origin).toBe('typescript');
    expect(batchRunner.run).not.toHaveBeenCalled();
  });

  it('uses the TypeScript source only for an eligible pre-publication worker failure', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const failure = new Error('trusted worker load failed');
    const source = new WasmExactSegmentSource({
      runner: runner(failure, true),
      compareWithTypeScript: false,
      minimumWasmWork: 0,
    });

    const collected = await source.collect(projected, specs, Infinity, () => undefined);

    expect(collected.origin).toBe('typescript-fallback');
    expect(collected.layers[0].segments).toHaveLength(8);
  });

  it.each(['CANCELLED', 'DEADLINE_EXCEEDED', 'PROTOCOL_ERROR', 'INVALID_REQUEST'] as const)(
    'does not fallback for %s',
    async (code) => {
      const projected = projectMesh(box(), selection, Infinity);
      const failure = new ExactSegmentSourceError(code, 'fail closed');
      const source = new WasmExactSegmentSource({
        runner: runner(failure, false),
        compareWithTypeScript: false,
        minimumWasmWork: 0,
      });

      await expect(source.collect(projected, specs, Infinity, () => undefined)).rejects.toBe(failure);
    },
  );

  it('does not fallback after a WASM batch has returned but publication validation fails', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    const invalid = result([0, 0, Number.NaN, 1]);
    const source = new WasmExactSegmentSource({
      runner: runner(invalid),
      compareWithTypeScript: false,
      minimumWasmWork: 0,
    });

    await expect(source.collect(projected, specs, Infinity, () => undefined)).rejects.toMatchObject({
      name: 'ExactSegmentSourceError', code: 'PROTOCOL_ERROR', fallbackEligible: false,
    });
  });

  it('cancels one generation without late publication and starts the replacement cleanly', async () => {
    const projected = projectMesh(box(), selection, Infinity);
    let resolveFirst!: (value: SliceBatchResult) => void;
    const cancel = vi.fn(async () => undefined);
    const batchRunner: ExactSegmentBatchRunner = {
      activeWorkerCount: 2,
      cancel,
      run: vi.fn()
        .mockImplementationOnce(() => new Promise<SliceBatchResult>((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce(result([])),
      isFallbackEligible: () => false,
    };
    const publication = vi.fn();
    const source = new WasmExactSegmentSource({
      runner: batchRunner,
      minimumWasmWork: 0,
      onPublication: publication,
    });

    const first = source.collect(projected, specs, Infinity, () => undefined);
    const firstGeneration = source.generation;
    expect(source.activeWorkerCount).toBe(2);
    await source.cancel();
    resolveFirst(result([]));

    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(publication).not.toHaveBeenCalled();
    const replacement = await source.collect(projected, specs, Infinity, () => undefined);
    expect(replacement.origin).toBe('wasm');
    expect(source.generation).toBeGreaterThan(firstGeneration);
    expect(publication).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
