import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizer, releaseProxy, wrap, type Remote } from 'comlink';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import {
  removalEvidenceFingerprint,
  stripAutomaticOutlineInternalEvidence,
  type AutomaticOutlineResult,
  type AutomaticOutlineProgressEvent,
} from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import { coloredResult, nearLimitColoredResult } from '../export/colored-outline-test-fixture';
import type { TriangleMesh } from '../domain/mesh/types';
import {
  interpenetratingTetrahedra,
  openTetrahedron,
  separatedClosedCylinders,
  tetrahedron,
  tetrahedronWithOneReversedFace,
} from '../test/mesh-builders';
import type { GeometryClient } from './geometry-client';
import { createGeometryWorkerClient as createActualGeometryWorkerClient } from './geometry-client';
import type { GeometryApi } from './geometry-api';
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
const scaledOpenTetrahedron = () => {
  const mesh = openTetrahedron();
  return { ...mesh, positions: new Float64Array(Array.from(mesh.positions, (value) => value * 20)) };
};
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
    ['over-500-character ID and name bounds', { ...testMaterial, id: 'i'.repeat(501), name: 'n'.repeat(501) }, /500|too big/i],
  ])('rejects %s from a structured-clone material payload in the real worker', async (_label, material, error) => {
    const api = createRawGeometryWorkerApi();

    await expect(api.convertAutomatically({
      bytes: writeBinarySTL(tetrahedron(), 'safe'),
      material,
    } as unknown as Parameters<GeometryApi['convertAutomatically']>[0])).rejects.toThrow(error);
  });

  it('proxies automatic progress monotonically across Comlink and transfers the STL bytes', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(scaledOpenTetrahedron(), 'safe');
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

    await expect(client.convertAutomatically({ bytes: writeBinarySTL(tetrahedron(), 'safe') }, onProgress))
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

    const replacement = client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });

    await expect(first).resolves.toBeInstanceOf(Error);
    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED', jobId: 1 });
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(terminate).toHaveBeenCalled();
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('terminates in-flight outline packaging when a replacement conversion starts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(256), 'safe') });
    for (const [layerIndex, coloredLayer] of runtime.coloredLayers.entries()) {
      const layer = runtime.layers[layerIndex];
      const clockwise = coloredLayer.exterior.outer.reduce((sum, point, index) => {
        const next = coloredLayer.exterior.outer[(index + 1) % coloredLayer.exterior.outer.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) < 0;
      const originalBounds = coloredLayer.exterior.boundsMm;
      const centerX = (originalBounds.minX + originalBounds.maxX) / 2;
      const centerY = (originalBounds.minY + originalBounds.maxY) / 2;
      const radiusX = (originalBounds.maxX - originalBounds.minX) / 2;
      const radiusY = (originalBounds.maxY - originalBounds.minY) / 2;
      const points = Array.from({ length: 4096 }, (_, index) => {
        const angle = (clockwise ? -1 : 1) * index / 4096 * Math.PI * 2;
        return [centerX + radiusX * Math.cos(angle), centerY + radiusY * Math.sin(angle)] as const;
      });
      const area = Math.abs(points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) / 2);
      Object.assign(coloredLayer.exterior, { outer: points, areaMm2: area });
      Object.assign(layer, {
        contour: { outer: points, holes: [] }, sourceAreaMm2: area, simplifiedAreaMm2: area,
        sourceBoundsMm: { ...originalBounds },
      });
    }
    Object.assign(runtime.preview, { layers: runtime.coloredLayers });
    Object.assign(runtime, {
      removalEvidenceFingerprint: removalEvidenceFingerprint(runtime),
      featureEvidenceFingerprint: featureEvidenceFingerprint(runtime),
    });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const priorApplyCount = postMessage.mock.calls.length;
    const first = client.packageOutline(runtime).catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.length).toBeGreaterThan(priorApplyCount));

    const replacement = client.convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(), 'safe') });

    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(terminate).toHaveBeenCalled();
  });

  it('transfers exactly the four colored artifacts plus ZIP across the worker boundary', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(launcherCompatibleCylinder(), 'safe') });
    expect(runtime).not.toHaveProperty('internalValidationEvidence');

    const packaged = await client.packageOutline(runtime);

    expect(Object.keys(packaged).sort()).toEqual([
      'cutDxf', 'cutSvg', 'explodedViewPdf', 'previewPdf', 'zip',
    ]);
    expect(packaged.cutSvg).toContain('CUT_BLACK');
    expect(packaged.cutDxf).toContain('DEEP_RED');
    expect(packaged.previewPdf.byteLength).toBeGreaterThan(0);
    expect(packaged.explodedViewPdf.byteLength).toBeGreaterThan(0);
    expect(packaged.zip.byteLength).toBeGreaterThan(0);
  });

  it('returns a typed TIME_LIMIT when the shared packaging deadline is exhausted', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });

    await expect(client.packageOutline(runtime, 0)).rejects.toMatchObject({
      name: 'AutomaticOutlineError', code: 'TIME_LIMIT', message: '模型處理超出時間上限',
    });
  });

  it('returns a bounded artifact identity for a non-timeout packaging failure', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });
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
      replacement = client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });
    }).not.toThrow();

    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
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
      { bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') },
      (event) => { observed.push(`old:${event.stage}`); },
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(queuedMessages.length).toBeGreaterThan(0));
    const replacement = client.convertAutomatically(
      { bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') },
      (event) => { observed.push(`new:${event.stage}`); },
    );
    addEventListener.mockRestore();
    for (const deliver of queuedMessages) deliver();

    await first;
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
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
