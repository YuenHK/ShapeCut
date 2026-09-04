import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizer, releaseProxy, wrap, type Remote } from 'comlink';
import JSZip from 'jszip';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import {
  convertAutomatically as convertAutomaticOutline,
  stripAutomaticOutlineInternalEvidence,
  type AutomaticOutlineResult,
  type AutomaticOutlineProgressEvent,
} from '../domain/pipeline/automatic-outline-pipeline';
import { createOutlinePackage } from '../export/outline-package';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import { coloredResult, nearLimitColoredResult } from '../export/colored-outline-test-fixture';
import type { TriangleMesh } from '../domain/mesh/types';
import {
  interpenetratingTetrahedra,
  openTetrahedron,
  tetrahedron,
  tetrahedronWithOneReversedFace,
} from '../test/mesh-builders';
import type { GeometryClient } from './geometry-client';
import { createGeometryWorkerClient as createActualGeometryWorkerClient } from './geometry-client';
import type { GeometryAccelerationProbe, GeometryApi } from './geometry-api';
import { InternalAutomaticResultCache } from './internal-automatic-result-cache';

const clients: Array<Pick<GeometryClient, 'dispose'>> = [];
const rawWorkerApis: Array<Remote<GeometryApi>> = [];
const rawWorkers: Worker[] = [];
const testMaterial = { id: 'test-material', name: 'Test material', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
type TestGeometryClient = Omit<GeometryClient, 'convertAutomatically'> & {
  convertAutomatically(request: { readonly bytes: ArrayBuffer }, onProgress?: (event: AutomaticOutlineProgressEvent) => void | Promise<void>): ReturnType<GeometryClient['convertAutomatically']>;
};
function createGeometryWorkerClient(): TestGeometryClient {
  const client = createActualGeometryWorkerClient();
  return {
    ...client,
    convertAutomatically: (request, onProgress) => client.convertAutomatically({
      ...request,
      material: testMaterial,
      launcherFitOffsetMm: 0,
    }, onProgress),
  };
}
function createRawGeometryWorkerApi(): Remote<GeometryApi> {
  const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
  const api = wrap<GeometryApi>(worker);
  rawWorkers.push(worker);
  rawWorkerApis.push(api);
  return api;
}
function createAcceptanceGeometryWorker(): { readonly worker: Worker; readonly api: Remote<GeometryApi> } {
  const url = new URL('./geometry.worker.ts', import.meta.url);
  url.searchParams.set('shapecut-acceptance', '1');
  const worker = new Worker(url, { type: 'module' });
  const api = wrap<GeometryApi>(worker);
  rawWorkers.push(worker);
  rawWorkerApis.push(api);
  return { worker, api };
}
type WasmAccelerationState = Readonly<{
  type: 'SHAPECUT_WASM_STATE';
  requestId: number;
  generation: number;
  activeWorkerCount: number;
}>;
let wasmStateRequestId = 0;
function requestWasmAccelerationState(
  worker: Worker,
  action: 'SHAPECUT_WASM_STATE_REQUEST' | 'SHAPECUT_WASM_CANCEL_REQUEST',
): Promise<WasmAccelerationState> {
  const requestId = ++wasmStateRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', listener);
      reject(new Error(`Missing ${action} response`));
    }, 500);
    const listener = (event: MessageEvent<unknown>): void => {
      const state = event.data as Partial<WasmAccelerationState> | undefined;
      if (state?.type !== 'SHAPECUT_WASM_STATE' || state.requestId !== requestId) return;
      clearTimeout(timeout);
      worker.removeEventListener('message', listener);
      resolve(state as WasmAccelerationState);
    };
    worker.addEventListener('message', listener);
    worker.postMessage({ type: action, requestId });
  });
}
function startWasmCancellationWork(worker: Worker): Promise<'fulfilled' | 'rejected'> {
  const requestId = ++wasmStateRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', listener);
      reject(new Error('Missing SHAPECUT_WASM_START_OUTCOME response'));
    }, 10_000);
    const listener = (event: MessageEvent<unknown>): void => {
      const outcome = event.data as { readonly type?: unknown; readonly requestId?: unknown; readonly outcome?: unknown };
      if (outcome?.type !== 'SHAPECUT_WASM_START_OUTCOME' || outcome.requestId !== requestId) return;
      clearTimeout(timeout);
      worker.removeEventListener('message', listener);
      if (outcome.outcome === 'fulfilled' || outcome.outcome === 'rejected') resolve(outcome.outcome);
      else reject(new Error('Invalid SHAPECUT_WASM_START_OUTCOME response'));
    };
    worker.addEventListener('message', listener);
    worker.postMessage({ type: 'SHAPECUT_WASM_START_REQUEST', requestId });
  });
}
async function artifactSha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function canonicalZipMemberIdentities(zip: Uint8Array): Promise<readonly (readonly [string, string])[]> {
  const archive = await JSZip.loadAsync(zip);
  return Promise.all(Object.keys(archive.files).filter((name) => !archive.files[name].dir).sort()
    .map(async (name) => [name, await artifactSha256(await archive.files[name].async('uint8array'))] as const));
}
const launcherCompatibleCylinder = (segments = 32): TriangleMesh => {
  const positions: number[] = [0, 0, -1, 0, 0, 1];
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), -1);
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), 1);
  }
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = 2 + index * 2, top = bottom + 1;
    const nextBottom = 2 + next * 2, nextTop = nextBottom + 1;
    indices.push(0, bottom, nextBottom, 1, nextTop, top);
    indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
};
const launcherCompatibleOpenCylinder = (segments = 32): TriangleMesh => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), -1);
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), 1);
  }
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = index * 2, top = bottom + 1;
    const nextBottom = next * 2, nextTop = nextBottom + 1;
    indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
};

function cacheResult(index: number): AutomaticOutlineResult {
  const result = coloredResult();
  return {
    ...result,
    sourceHash: index.toString(16).padStart(32, '0'),
    featureEvidenceFingerprint: (15 - index).toString(16).repeat(32),
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const api of rawWorkerApis.splice(0)) api[releaseProxy]();
  for (const worker of rawWorkers.splice(0)) worker.terminate();
});

describe('geometry worker boundary', () => {
  it('uses verified WASM segments in production canonical extraction without changing launcher artifacts', async () => {
    const { worker, api } = createAcceptanceGeometryWorker();
    const source = writeBinarySTL(launcherCompatibleCylinder(12), 'safe');
    const publication = new Promise<unknown>((resolve) => {
      worker.addEventListener('message', (event) => {
        if (event.data?.type === 'SHAPECUT_WASM_SEGMENTS_PUBLISHED') resolve(event.data);
      });
    });
    const baseline = await convertAutomaticOutline({
      bytes: source.slice(0), material: testMaterial, launcherFitOffsetMm: 0,
    });
    const baselineArtifacts = await createOutlinePackage(baseline);

    const acceleratedPromise = api.convertAutomatically({
      bytes: source, material: testMaterial, launcherFitOffsetMm: 0,
    });
    await expect(publication).resolves.toEqual(expect.objectContaining({
      type: 'SHAPECUT_WASM_SEGMENTS_PUBLISHED',
      origin: 'wasm',
    }));
    const accelerated = await acceleratedPromise;
    const acceleratedArtifacts = await api.packageOutline(accelerated);

    expect(accelerated.layers).toEqual(baseline.layers);
    expect(accelerated.assembly.launcher).toMatchObject({ status: 'fixed' });
    expect(accelerated.assembly.launcher).toEqual(baseline.assembly.launcher);
    expect(accelerated.featureEvidenceFingerprint).toBe(baseline.featureEvidenceFingerprint);
    await expect(Promise.all([
      artifactSha256(acceleratedArtifacts.cutSvg),
      artifactSha256(acceleratedArtifacts.cutDxf),
      artifactSha256(acceleratedArtifacts.previewPdf),
      artifactSha256(acceleratedArtifacts.explodedViewPdf),
      artifactSha256(acceleratedArtifacts.launcherCouponSvg),
      canonicalZipMemberIdentities(acceleratedArtifacts.zip),
    ])).resolves.toEqual(await Promise.all([
      artifactSha256(baselineArtifacts.cutSvg),
      artifactSha256(baselineArtifacts.cutDxf),
      artifactSha256(baselineArtifacts.previewPdf),
      artifactSha256(baselineArtifacts.explodedViewPdf),
      artifactSha256(baselineArtifacts.launcherCouponSvg),
      canonicalZipMemberIdentities(baselineArtifacts.zip),
    ]));
  });

  it('cancels actual WASM singleton workers without late publication and replaces with a clean generation', async () => {
    const { worker, api } = createAcceptanceGeometryWorker();
    const publications: Array<GeometryAccelerationProbe & { readonly generation: number }> = [];
    worker.addEventListener('message', (event) => {
      if (event.data?.type === 'SHAPECUT_WASM_SEGMENTS_PUBLISHED') publications.push(event.data);
    });
    const firstOutcome = startWasmCancellationWork(worker);
    let active!: WasmAccelerationState;
    await vi.waitFor(async () => {
      active = await requestWasmAccelerationState(worker, 'SHAPECUT_WASM_STATE_REQUEST');
      expect(active.activeWorkerCount).toBeGreaterThan(0);
    }, { timeout: 5_000, interval: 10 });

    const cancelStarted = performance.now();
    const cancelled = await requestWasmAccelerationState(worker, 'SHAPECUT_WASM_CANCEL_REQUEST');
    expect(cancelled.activeWorkerCount).toBe(0);
    expect(performance.now() - cancelStarted).toBeLessThan(1_000);
    await expect(firstOutcome).resolves.toBe('rejected');
    expect(publications).toEqual([]);

    const replacementSource = writeBinarySTL(launcherCompatibleCylinder(12), 'safe');
    const replacement = await api.convertAutomatically({
      bytes: replacementSource.slice(0),
      material: testMaterial,
      launcherFitOffsetMm: 0,
    });
    const freshBaseline = await convertAutomaticOutline({
      bytes: replacementSource,
      material: testMaterial,
      launcherFitOffsetMm: 0,
    });
    expect(replacement.layers).toEqual(freshBaseline.layers);
    expect(replacement.assembly).toEqual(freshBaseline.assembly);
    expect(replacement.featureEvidenceFingerprint).toBe(freshBaseline.featureEvidenceFingerprint);
    const finalState = await requestWasmAccelerationState(worker, 'SHAPECUT_WASM_STATE_REQUEST');
    expect(finalState.activeWorkerCount).toBe(0);
    expect(finalState.generation).toBeGreaterThan(cancelled.generation);
    expect(publications).toEqual([
      expect.objectContaining({
        origin: 'wasm',
        generation: finalState.generation,
        activeWorkerCount: 0,
      }),
    ]);
  });

  it('evicts the oldest entry when a fifth internal result enters the max-four cache', () => {
    const cache = new InternalAutomaticResultCache(4);
    const results = Array.from({ length: 5 }, (_, index) => cacheResult(index));
    for (const result of results) cache.store(result);

    expect(cache.resolve(stripAutomaticOutlineInternalEvidence(results[0]))).toBeUndefined();
    expect(cache.size).toBe(4);
  });

  it('resolves the latest cache entry for worker-side packaging', () => {
    const cache = new InternalAutomaticResultCache(4);
    const results = Array.from({ length: 5 }, (_, index) => cacheResult(index));
    for (const result of results) cache.store(result);

    expect(cache.resolve(stripAutomaticOutlineInternalEvidence(results[4]))).toBe(results[4]);
  });

  it('replaces a same-key cache entry with its latest internal evidence', () => {
    const cache = new InternalAutomaticResultCache(4);
    const first = cacheResult(1);
    const replacement = {
      ...structuredClone(first),
      internalValidationEvidence: {
        launcherDecoration: {
          ...structuredClone(first.internalValidationEvidence!.launcherDecoration),
          protectedCutClearanceMm: 0.123456,
        },
      },
    };
    cache.store(first);
    cache.store(replacement);

    expect(cache.resolve(stripAutomaticOutlineInternalEvidence(first))).toBe(replacement);
    expect(cache.size).toBe(1);
  });

  it('rejects cross-key evidence confusion and an evicted-key replay', () => {
    const cache = new InternalAutomaticResultCache(4);
    const results = Array.from({ length: 5 }, (_, index) => cacheResult(index));
    cache.store(results[0]);
    cache.store(results[1]);
    const confused = {
      ...stripAutomaticOutlineInternalEvidence(results[0]),
      featureEvidenceFingerprint: results[1].featureEvidenceFingerprint,
    };
    expect(cache.resolve(confused)).toBeUndefined();

    for (const result of results.slice(2)) cache.store(result);
    expect(cache.resolve(stripAutomaticOutlineInternalEvidence(results[0]))).toBeUndefined();
  });

  it('derives presentation data behind the cancellable worker boundary without detaching caller-owned STL bytes', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(tetrahedron(), 'safe');
    const sourceLength = source.byteLength;

    const presentation = await client.createStlPresentation(source);

    expect(source.byteLength).toBe(sourceLength);
    expect(presentation).toMatchObject({
      mesh: {
        positions: expect.any(Float32Array),
        indices: expect.any(Uint32Array),
      },
      layers: [],
    });

    const largeSource = new ArrayBuffer(84 + 500_000 * 50);
    new DataView(largeSource).setUint32(80, 500_000, true);
    const workerMessages = vi.spyOn(Worker.prototype, 'postMessage');
    const messageCount = workerMessages.mock.calls.length;
    const pending = client.createStlPresentation(largeSource);
    await vi.waitFor(() => expect(workerMessages.mock.calls.length).toBeGreaterThan(messageCount));
    client.cancelActive();
    await expect(pending).rejects.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    workerMessages.mockRestore();

    const replacement = await client.createStlPresentation(source);
    expect(replacement.mesh.indices.length).toBe(12);
    expect(source.byteLength).toBe(sourceLength);
  });

  it.each([
    ['unknown keys', { ...testMaterial, operatorName: 'private operator' }, /unrecognized key/i],
    ['non-finite values', { ...testMaterial, kerfMm: Infinity }, /number|NaN/i],
    ['forbidden private strings', { ...testMaterial, manufacturer: 'private evidence' }, /unrecognized key/i],
    ['unsafe public material ID before conversion', { ...testMaterial, id: 'legacy material id' }, /material id.*1-80.*ASCII/i],
    ['over-500-character name bound', { ...testMaterial, name: 'n'.repeat(501) }, /500|too big/i],
  ])('rejects %s from a structured-clone material payload in the real worker', async (_label, material, error) => {
    const api = createRawGeometryWorkerApi();

    await expect(api.convertAutomatically({
      bytes: writeBinarySTL(tetrahedron(), 'safe'),
      material,
    } as unknown as Parameters<GeometryApi['convertAutomatically']>[0])).rejects.toThrow(error);
  });

  it.each([NaN, Infinity, -0.21, 0.21, 0.005])('rejects fit offset %s in the real worker before conversion', async (launcherFitOffsetMm) => {
    const api = createRawGeometryWorkerApi();

    await expect(api.convertAutomatically({
      bytes: writeBinarySTL(tetrahedron(), 'safe'),
      material: testMaterial,
      launcherFitOffsetMm,
    })).rejects.toMatchObject({
      name: 'RangeError',
      message: expect.stringMatching(/fit offset/i),
    });
  });

  it('normalizes a raw-worker fit offset without mutating the caller request', async () => {
    const api = createRawGeometryWorkerApi();
    const request = {
      bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe'),
      material: testMaterial,
      launcherFitOffsetMm: -0,
    };

    const result = await api.convertAutomatically(request);

    expect(result.assembly.launcher).toMatchObject({ status: 'fixed', fitOffsetMm: 0 });
    expect(Object.is(result.assembly.launcher.fitOffsetMm, -0)).toBe(false);
    expect(Object.is(request.launcherFitOffsetMm, -0)).toBe(true);
  });

  it('proxies automatic progress monotonically across Comlink and transfers the STL bytes', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(launcherCompatibleOpenCylinder(), 'safe');
    const progress: AutomaticOutlineProgressEvent[] = [];
    const released = vi.fn();
    const onProgress = Object.assign(
      (event: AutomaticOutlineProgressEvent) => { progress.push(event); },
      { [finalizer]: released },
    );

    const result = await client.convertAutomatically({ bytes: source }, onProgress);

    expect(source.byteLength).toBe(0);
    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(result.layers[0].sourceBoundsMm).toEqual(expect.objectContaining({
      minX: expect.any(Number), minY: expect.any(Number), maxX: expect.any(Number), maxY: expect.any(Number),
    }));
    expect(progress.map(({ stage }) => stage)).toEqual([
      'reading', 'analyzing', 'simplifying', 'slicing', 'slicing', 'packaging',
    ]);
    expect(progress.filter((event) => 'preview' in event).map(({ stage }) => stage)).toEqual(['analyzing', 'slicing']);
    expect(progress.every((event) => !('preview' in event)
      || (event.preview.mesh.positions instanceof Float32Array && event.preview.mesh.indices instanceof Uint32Array))).toBe(true);
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('observes progress callback rejection and releases its Comlink proxy', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const released = vi.fn();
    const onProgress = Object.assign(
      async (event: AutomaticOutlineProgressEvent) => { if (event.stage === 'packaging') throw new Error('progress receiver closed'); },
      { [finalizer]: released },
    );

    await expect(client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') }, onProgress))
      .rejects.toThrow('progress receiver closed');
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('preserves typed automatic failure codes across Comlink', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);

    await expect(client.convertAutomatically({ bytes: new ArrayBuffer(1) })).rejects.toMatchObject({
      name: 'AutomaticOutlineError',
      code: 'INVALID_STL',
    });
  });

  it('parses and inspects an STL through Comlink with transferred input ownership', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = new TextEncoder().encode(`solid triangle
      facet normal 0 0 1
        outer loop
          vertex 0 0 0
          vertex 1 0 0
          vertex 0 1 0
        endloop
      endfacet
    endsolid triangle`).buffer;

    const result = await client.analyze(source);

    expect(source.byteLength).toBe(0);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.inspection).toMatchObject({ triangleCount: 1, boundaryEdgeCount: 3 });
    expect(result.mesh.positions).toBeInstanceOf(Float64Array);
    expect(result.mesh.indices).toBeInstanceOf(Uint32Array);
  });

  it('returns independently backed original, preview, and safe repair meshes', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(tetrahedron(), 'safe');

    const result = await client.analyzeAndRepairForImport(source);

    expect(source.byteLength).toBe(0);
    expect(result.originalReport.inspection.triangleCount).toBe(4);
    expect(result.safeRepair.mode).toBe('safe');
    expect(result.safeRepair.accepted).toBe(true);
    expect(result.originalPreview.positions.length).toBeGreaterThan(0);
    expect(result.originalMesh.positions.buffer).not.toBe(result.originalPreview.positions.buffer);
    expect(result.originalMesh.positions.buffer).not.toBe(result.safeRepair.mesh.positions.buffer);
    expect(result.originalPreview.positions.buffer).not.toBe(result.safeRepair.mesh.positions.buffer);
  });

  it('preserves original and safe meshes when advanced repair rejects', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const result = await client.analyzeAndRepairForImport(writeBinarySTL(openTetrahedron(), 'safe'));
    const oversizedSafeMesh = {
      positions: result.safeRepair.mesh.positions.slice(),
      indices: new Uint32Array([...result.safeRepair.mesh.indices, 0, 1, 2]),
    };
    const originalLength = result.originalMesh.positions.length;
    const safeLength = oversizedSafeMesh.positions.length;

    await expect(client.repairAdvanced(result.originalMesh, oversizedSafeMesh)).rejects.toThrow(/triangle.*limit/i);

    expect(result.originalMesh.positions.length).toBe(originalLength);
    expect(result.originalMesh.indices.length).toBe(9);
    expect(oversizedSafeMesh.positions.length).toBe(safeLength);
    expect(oversizedSafeMesh.indices.length).toBe(12);
  });

  it('caps each problem marker collection at 2,000 while retaining complete counts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(disconnectedTriangles(2_001), 'safe');

    const result = await client.analyzeAndRepairForImport(source);

    expect(result.originalReport.inspection.boundaryEdgeCount).toBe(6_003);
    expect(result.originalReport.boundaryEdges).toHaveLength(2_000);
    expect(result.originalReport.markersTruncated.boundaryEdges).toBe(true);
  });

  it('serializes repaired meshes and reparses the exact binary STL before transfer', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const mesh = tetrahedron();

    const bytes = await client.serializeSTL(mesh, 'advanced');

    expect(mesh.positions.length).toBe(12);
    expect(mesh.indices.length).toBe(12);
    expect(bytes.byteLength).toBe(84 + 4 * 50);
    expect(new TextDecoder().decode(bytes.slice(0, 80))).toContain('advanced');
    expect(new DataView(bytes).getUint32(80, true)).toBe(4);
  });

  it.each([
    ['inconsistent winding', tetrahedronWithOneReversedFace(), 'inconsistentWindingEdgeCount'],
    ['3D self-intersection', interpenetratingTetrahedra(), 'selfIntersectionCount'],
  ] as const)('keeps %s counterexamples locked across the real worker boundary', async (_label, mesh, countKey) => {
    const client = createGeometryWorkerClient();
    clients.push(client);

    const result = await client.analyzeAndRepairForImport(writeBinarySTL(mesh, 'safe'));

    expect(result.safeRepair.after[countKey]).toBeGreaterThan(0);
    expect(result.safeRepair.accepted).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('terminates an automatic conversion on supersede and completes the replacement on a fresh worker', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const client = createGeometryWorkerClient();
    clients.push(client);
    const released = vi.fn();
    const onProgress = Object.assign(
      () => undefined,
      { [finalizer]: released },
    );
    const first = client.convertAutomatically(
      { bytes: writeBinarySTL(disconnectedTriangles(20_000), 'safe') },
      onProgress,
    )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ type: 'APPLY' }),
    ));

    const replacement = client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });

    await expect(first).resolves.toBeInstanceOf(Error);
    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED', jobId: 1 });
    await expect(replacement).resolves.toMatchObject({ mode: 'exact', status: 'warning' });
    expect(terminate).toHaveBeenCalled();
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('terminates in-flight outline packaging when a replacement conversion starts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(256), 'safe') });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const priorApplyCount = postMessage.mock.calls.length;
    const first = client.packageOutline(runtime).catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.length).toBeGreaterThan(priorApplyCount));

    const replacement = client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });

    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    await expect(replacement).resolves.toMatchObject({ mode: 'exact', status: 'warning' });
    expect(terminate).toHaveBeenCalled();
  });

  it('strips private source evidence while packaging the canonical omission decision from the worker cache', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });
    expect(runtime).not.toHaveProperty('internalValidationEvidence');
    expect(runtime).not.toHaveProperty('centralHoleSourceEvidence');
    expect(runtime).not.toHaveProperty('decorationOmissionSourceEvidence');
    expect(runtime.assembly.decorationOmissions).toEqual([]);

    const packaged = await client.packageOutline(runtime);

    expect(Object.keys(packaged).sort()).toEqual([
      'cutDxf', 'cutSvg', 'explodedViewPdf', 'launcherCouponSvg', 'previewPdf', 'zip',
    ]);
    expect(packaged.cutSvg).toContain('CUT_BLACK');
    expect(packaged.cutDxf).toContain('DEEP_RED');
    expect(packaged.previewPdf.byteLength).toBeGreaterThan(0);
    expect(packaged.explodedViewPdf.byteLength).toBeGreaterThan(0);
    expect(packaged.launcherCouponSvg).toContain('data-template-fingerprint=');
    expect(packaged.zip.byteLength).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(packaged.zip);
    const project = JSON.parse(await zip.file('project.json')!.async('string')) as {
      readonly assembly: { readonly decorationOmissions: unknown };
    };
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      readonly decisions: { readonly decorationOmissions: unknown };
    };
    expect(project.assembly.decorationOmissions).toEqual(runtime.assembly.decorationOmissions);
    expect(manifest.decisions.decorationOmissions).toEqual(runtime.assembly.decorationOmissions);
  });

  it('returns a typed TIME_LIMIT when the shared packaging deadline is exhausted', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });

    await expect(client.packageOutline(runtime, 0)).rejects.toMatchObject({
      name: 'AutomaticOutlineError', code: 'TIME_LIMIT', message: '模型處理超出時間上限',
    });
  });

  it('returns a bounded artifact identity for a non-timeout packaging failure', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });
    Object.assign(runtime, { featureEvidenceFingerprint: 'f'.repeat(32) });

    await expect(client.packageOutline(runtime)).rejects.toMatchObject({
      name: 'OutlineArtifactError',
      code: 'ARTIFACT_FAILURE',
      artifact: 'colored-outline-document',
    });
  });

  it('rejects internal validation evidence presented across the public package transfer', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);

    await expect(client.packageOutline(nearLimitColoredResult(1_024))).rejects.toMatchObject({
      name: 'OutlineArtifactError', code: 'ARTIFACT_FAILURE', artifact: 'colored-outline-document',
    });
  });

  it('still terminates and recreates when progress finalization throws during cancel', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const client = createGeometryWorkerClient();
    clients.push(client);
    const released = vi.fn(() => { throw new Error('cleanup observer failed'); });
    const first = client.convertAutomatically(
      { bytes: writeBinarySTL(disconnectedTriangles(20_000), 'safe') },
      Object.assign(() => undefined, { [finalizer]: released }),
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ type: 'APPLY' }),
    ));

    let replacement!: ReturnType<GeometryClient['convertAutomatically']>;
    expect(() => {
      replacement = client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });
    }).not.toThrow();

    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    await expect(replacement).resolves.toMatchObject({ mode: 'exact', status: 'warning' });
    expect(released).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalled();
  });

  it('does not publish queued progress from an old worker after its replacement starts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const observed: string[] = [];
    const queuedMessages: Array<() => void> = [];
    const originalAddEventListener = MessagePort.prototype.addEventListener;
    let interceptNextMessageListener = true;
    const addEventListener = vi.spyOn(MessagePort.prototype, 'addEventListener').mockImplementation(function (
      this: MessagePort,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== 'message' || !interceptNextMessageListener) {
        return originalAddEventListener.call(this, type, listener, options);
      }
      interceptNextMessageListener = false;
      return originalAddEventListener.call(this, type, (event) => {
        queuedMessages.push(() => {
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        });
      }, options);
    } as typeof MessagePort.prototype.addEventListener);
    const first = client.convertAutomatically(
      { bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') },
      (event) => { observed.push(`old:${event.stage}`); },
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(queuedMessages.length).toBeGreaterThan(0));
    const replacement = client.convertAutomatically(
      { bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') },
      (event) => { observed.push(`new:${event.stage}`); },
    );
    addEventListener.mockRestore();
    for (const deliver of queuedMessages) deliver();

    await first;
    await expect(replacement).resolves.toMatchObject({ mode: 'exact', status: 'warning' });
    expect(observed).toEqual([
      'new:reading',
      'new:analyzing',
      'new:simplifying',
      'new:slicing',
      'new:slicing',
      'new:packaging',
    ]);
  });
});

function disconnectedTriangles(count: number): TriangleMesh {
  const positions = new Float64Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const positionOffset = triangle * 9;
    const indexOffset = triangle * 3;
    const x = triangle * 2;
    positions.set([x, 0, 0, x + 1, 0, 0, x, 1, 0], positionOffset);
    indices.set([indexOffset, indexOffset + 1, indexOffset + 2], indexOffset);
  }
  return { positions, indices };
}
