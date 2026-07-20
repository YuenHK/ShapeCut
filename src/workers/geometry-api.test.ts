import { describe, expect, it, vi } from 'vitest';
import { proxyMarker } from 'comlink';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { tetrahedron } from '../test/mesh-builders';
import type { GeometryApi, ImportRepairAnalysis, MeshAnalysis } from './geometry-api';
import {
  isSerializedAutomaticOutlineError,
  makeGeometryClient,
  SupersededError,
} from './geometry-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function analysis(sourceHash: string): MeshAnalysis {
  return {
    sourceHash,
    mesh: { positions: new Float64Array(), indices: new Uint32Array() },
    previewMesh: { positions: new Float64Array(), indices: new Uint32Array() },
    inspection: {
      triangleCount: 0,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
      invertedVolume: false,
    },
  };
}

function inspectOnly(inspect: GeometryApi['inspect']): GeometryApi {
  return {
    inspect,
    convertAutomatically: vi.fn(),
    inspectAndFindAxes: vi.fn(),
    analyzeAndRepairForImport: vi.fn(),
    repairAdvanced: vi.fn(),
    serializeSTL: vi.fn(),
    findAxes: vi.fn(),
    decompose: vi.fn(),
    engrave: vi.fn(),
  };
}

function automaticResult(sourceHash: string): AutomaticOutlineResult {
  return {
    sourceHash,
    mode: 'exact',
    status: 'success',
    axis: {
      source: 'candidate',
      axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
    },
    layers: [],
    warnings: [],
    originalReport: importRepairAnalysis(sourceHash).originalReport,
    repairAccepted: true,
    removedComponentCount: 0,
    removalEvidenceFingerprint: '0'.repeat(32),
  };
}

function importRepairAnalysis(sourceHash: string): ImportRepairAnalysis {
  const originalMesh = tetrahedron();
  const originalPreview = tetrahedron();
  const report = {
    inspection: {
      triangleCount: 4,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
      invertedVolume: false,
    },
    duplicateTriangleCount: 0,
    inconsistentWindingEdgeCount: 0,
    selfIntersectionCount: 0,
    selfIntersectionAnalysisComplete: true,
    boundaryEdges: [],
    nonManifoldEdges: [],
    degenerateTriangles: [],
    duplicateTriangles: [],
    inconsistentWindingEdges: [],
    selfIntersections: [],
    markersTruncated: {
      boundaryEdges: false,
      nonManifoldEdges: false,
      degenerateTriangles: false,
      duplicateTriangles: false,
      inconsistentWindingEdges: false,
      selfIntersections: false,
    },
  } as const;
  return {
    sourceHash,
    originalMesh,
    originalPreview,
    originalReport: report,
    safeRepair: {
      mode: 'safe',
      mesh: tetrahedron(),
      before: report,
      after: report,
      changes: {
        removedDegenerate: 0,
        removedDuplicate: 0,
        weldedVertices: 0,
        splitVertices: 0,
        filledHoles: 0,
      },
      comparison: {
        beforeSize: [1, 1, 1],
        afterSize: [1, 1, 1],
        axisChangePercent: [0, 0, 0],
        beforeAbsoluteVolume: 1 / 6,
        afterAbsoluteVolume: 1 / 6,
        volumeChangePercent: 0,
      },
      accepted: true,
      blockingReasons: [],
    },
    candidates: [],
  };
}

describe('geometry worker client', () => {
  it('forwards automatic conversion progress without requiring a Comlink callback in unit mocks', async () => {
    const onProgress = vi.fn();
    const api = inspectOnly(vi.fn());
    api.convertAutomatically = vi.fn(async (_request, progress) => {
      progress?.('reading');
      progress?.('packaging');
      return automaticResult('automatic');
    });
    const client = makeGeometryClient(api);
    const bytes = new ArrayBuffer(4);

    await expect(client.convertAutomatically({ bytes }, onProgress)).resolves.toMatchObject({ sourceHash: 'automatic' });

    expect(api.convertAutomatically).toHaveBeenCalledWith({ bytes }, expect.any(Function));
    const forwardedProgress = vi.mocked(api.convertAutomatically).mock.calls[0][1];
    expect((forwardedProgress as typeof forwardedProgress & { [proxyMarker]?: true })?.[proxyMarker]).toBeUndefined();
    expect(onProgress.mock.calls).toEqual([['reading'], ['packaging']]);
  });

  it('supersedes an active automatic conversion before starting its replacement', async () => {
    const firstRemote = deferred<AutomaticOutlineResult>();
    const api = inspectOnly(vi.fn());
    api.convertAutomatically = vi.fn()
      .mockReturnValueOnce(firstRemote.promise)
      .mockResolvedValueOnce(automaticResult('replacement'));
    const abortExecution = vi.fn();
    const client = makeGeometryClient(api, { abortExecution });

    const first = client.convertAutomatically({ bytes: new ArrayBuffer(8) });
    await Promise.resolve();
    const second = client.convertAutomatically({ bytes: new ArrayBuffer(8) });

    await expect(first).rejects.toMatchObject({ code: 'SUPERSEDED', jobId: 1 });
    await expect(second).resolves.toMatchObject({ sourceHash: 'replacement' });
    expect(abortExecution).toHaveBeenCalledOnce();
    firstRemote.resolve(automaticResult('ignored'));
  });

  it('gates automatic progress from a superseded job', async () => {
    const firstRemote = deferred<AutomaticOutlineResult>();
    let staleProgress: Parameters<GeometryApi['convertAutomatically']>[1];
    const api = inspectOnly(vi.fn());
    api.convertAutomatically = vi.fn()
      .mockImplementationOnce((_request, progress) => {
        staleProgress = progress;
        return firstRemote.promise;
      })
      .mockResolvedValueOnce(automaticResult('replacement'));
    const onProgress = vi.fn();
    const client = makeGeometryClient(api);

    const first = client.convertAutomatically({ bytes: new ArrayBuffer(8) }, onProgress);
    await Promise.resolve();
    const second = client.convertAutomatically({ bytes: new ArrayBuffer(8) });
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    await expect(second).resolves.toMatchObject({ sourceHash: 'replacement' });

    if (typeof staleProgress === 'function') await staleProgress('packaging');
    expect(onProgress).not.toHaveBeenCalled();
    firstRemote.resolve(automaticResult('ignored'));
  });

  it('accepts only the four public automatic error codes for rehydration', () => {
    for (const code of ['INVALID_STL', 'NO_OUTLINE', 'RESOURCE_LIMIT', 'TIME_LIMIT']) {
      expect(isSerializedAutomaticOutlineError({ name: 'AutomaticOutlineError', code, message: code })).toBe(true);
    }
    expect(isSerializedAutomaticOutlineError({
      name: 'AutomaticOutlineError', code: 'SUPERSEDED', message: 'forged',
    })).toBe(false);
    expect(isSerializedAutomaticOutlineError({
      name: 'AutomaticOutlineError', code: '__proto__', message: 'forged',
    })).toBe(false);
  });

  it('drops a stale result as soon as a newer job starts', async () => {
    const firstRemote = deferred<MeshAnalysis>();
    const secondRemote = deferred<MeshAnalysis>();
    const inspect = vi.fn()
      .mockReturnValueOnce(firstRemote.promise)
      .mockReturnValueOnce(secondRemote.promise);
    const client = makeGeometryClient(inspectOnly(inspect));

    const first = client.analyze(new ArrayBuffer(1));
    await Promise.resolve();
    const second = client.analyze(new ArrayBuffer(2));

    await expect(first).rejects.toEqual(expect.objectContaining({ name: 'SupersededError', code: 'SUPERSEDED', jobId: 1 }));
    secondRemote.resolve(analysis('mesh-b'));
    await expect(second).resolves.toMatchObject({ sourceHash: 'mesh-b' });

    firstRemote.resolve(analysis('mesh-a'));
  });

  it('cancels the active logical job when the UI leaves the step', async () => {
    const remote = deferred<MeshAnalysis>();
    const abortExecution = vi.fn();
    const client = makeGeometryClient(inspectOnly(() => remote.promise), { abortExecution });

    const pending = client.analyze(new ArrayBuffer(8));
    await Promise.resolve();
    client.cancelActive();

    await expect(pending).rejects.toBeInstanceOf(SupersededError);
    expect(abortExecution).toHaveBeenCalledOnce();
    remote.resolve(analysis('ignored'));
  });

  it('checks cancellation before a deferred operation begins and never calls the remote API', async () => {
    const inspect = vi.fn().mockResolvedValue(analysis('should-not-run'));
    const abortExecution = vi.fn();
    const client = makeGeometryClient(inspectOnly(inspect), { abortExecution });

    const pending = client.analyze(new ArrayBuffer(8));
    client.cancelActive();

    await expect(pending).rejects.toBeInstanceOf(SupersededError);
    await Promise.resolve();
    expect(inspect).not.toHaveBeenCalled();
    expect(abortExecution).toHaveBeenCalledOnce();
  });

  it('aborts the executing backend before a superseding job is submitted', async () => {
    const firstRemote = deferred<MeshAnalysis>();
    const inspect = vi.fn()
      .mockReturnValueOnce(firstRemote.promise)
      .mockResolvedValueOnce(analysis('replacement'));
    const abortExecution = vi.fn();
    const client = makeGeometryClient(inspectOnly(inspect), { abortExecution });

    const first = client.analyze(new ArrayBuffer(8));
    await Promise.resolve();
    const second = client.analyze(new ArrayBuffer(8));

    await expect(first).rejects.toBeInstanceOf(SupersededError);
    expect(abortExecution).toHaveBeenCalledOnce();
    await expect(second).resolves.toMatchObject({ sourceHash: 'replacement' });
    firstRemote.resolve(analysis('ignored'));
  });

  it('uses monotonically increasing job IDs after cancellation', async () => {
    const pending = deferred<MeshAnalysis>();
    const inspect = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(analysis('mesh-c'));
    const client = makeGeometryClient(inspectOnly(inspect));

    const first = client.analyze(new ArrayBuffer(1));
    await Promise.resolve();
    client.cancelActive();
    await expect(first).rejects.toMatchObject({ jobId: 1 });

    await expect(client.analyze(new ArrayBuffer(1))).resolves.toMatchObject({ sourceHash: 'mesh-c' });
    expect(client.latestJobId).toBe(2);
    pending.resolve(analysis('ignored'));
  });

  it('passes STL buffers through the supplied transferable adapter', async () => {
    const inspect = vi.fn().mockResolvedValue(analysis('mesh-a'));
    const transferred = new ArrayBuffer(4);
    const transferInput = vi.fn(() => transferred);
    const source = new ArrayBuffer(4);
    const client = makeGeometryClient(inspectOnly(inspect), { transferInput });

    await client.analyze(source);

    expect(transferInput).toHaveBeenCalledWith(source);
    expect(inspect).toHaveBeenCalledWith(transferred);
  });

  it('returns original and safe results through the import repair API', async () => {
    const result = importRepairAnalysis('mesh-repaired');
    const analyzeAndRepairForImport = vi.fn().mockResolvedValue(result);
    const api = inspectOnly(vi.fn());
    api.analyzeAndRepairForImport = analyzeAndRepairForImport;
    const client = makeGeometryClient(api);

    await expect(client.analyzeAndRepairForImport(new ArrayBuffer(4))).resolves.toBe(result);
    expect(result.originalReport).toBeDefined();
    expect(result.safeRepair.mode).toBe('safe');
    expect(result.originalPreview.positions.length).toBeGreaterThan(0);
  });

  it('transfers clones for advanced repair so original and safe UI meshes stay intact', async () => {
    const api = inspectOnly(vi.fn());
    api.repairAdvanced = vi.fn().mockResolvedValue(importRepairAnalysis('advanced').safeRepair);
    const transferredMeshes: Array<ReturnType<typeof tetrahedron>> = [];
    const transferMesh = vi.fn((mesh: ReturnType<typeof tetrahedron>) => {
      transferredMeshes.push(mesh);
      return mesh;
    });
    const client = makeGeometryClient(api, { transferMesh });
    const original = tetrahedron();
    const safe = tetrahedron();

    await client.repairAdvanced(original, safe);

    expect(original.positions.length).toBe(12);
    expect(safe.positions.length).toBe(12);
    expect(transferredMeshes).toHaveLength(2);
    expect(transferredMeshes[0].positions).not.toBe(original.positions);
    expect(transferredMeshes[1].positions).not.toBe(safe.positions);
  });

  it('keeps cancellation semantics for repair and serialization jobs', async () => {
    const remote = deferred<ImportRepairAnalysis>();
    const api = inspectOnly(vi.fn());
    api.analyzeAndRepairForImport = vi.fn(() => remote.promise);
    api.serializeSTL = vi.fn().mockResolvedValue(new ArrayBuffer(84));
    const client = makeGeometryClient(api);

    const repair = client.analyzeAndRepairForImport(new ArrayBuffer(1));
    const serialization = client.serializeSTL(tetrahedron(), 'safe');

    await expect(repair).rejects.toMatchObject({ code: 'SUPERSEDED', jobId: 1 });
    await expect(serialization).resolves.toHaveProperty('byteLength', 84);
    expect(client.latestJobId).toBe(2);
    remote.resolve(importRepairAnalysis('ignored'));
  });
});
