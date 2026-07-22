import { describe, expect, it, vi } from 'vitest';
import { proxyMarker } from 'comlink';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, validateAutomaticColoredResult } from '../domain/outline-features/types';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';
import { tetrahedron } from '../test/mesh-builders';
import { validateManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import {
  OUTLINE_ARTIFACT_IDS,
  OutlineArtifactError,
  type GeometryApi,
  type ImportRepairAnalysis,
  type MeshAnalysis,
} from './geometry-api';
import {
  isSerializedOutlineArtifactError,
  isSerializedAutomaticOutlineError,
  makeGeometryClient,
  SupersededError,
} from './geometry-client';

const testMaterial = { id: 'test-material', name: 'Test material', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
function convertAutomatically(client: ReturnType<typeof makeGeometryClient>, request: { readonly bytes: ArrayBuffer }, onProgress?: Parameters<ReturnType<typeof makeGeometryClient>['convertAutomatically']>[1]) {
  return client.convertAutomatically({ ...request, material: testMaterial }, onProgress);
}

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
    packageOutline: vi.fn(),
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
  const coloredLayers = Array.from({ length: 6 }, (_, index) => ({
    id: `outline-layer-${index}`, index, zStart: index, zEnd: index + 1,
    exterior: {
      id: `outline-layer-${index}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const,
      boundsMm: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, areaMm2: 4,
    },
    removedComponentCount: 0,
    diagnostics: {
      hole: { status: 'omitted' as const },
      depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
    },
  }));
  const previewSource = tetrahedron();
  const result: Omit<AutomaticOutlineResult, 'featureEvidenceFingerprint'> = {
    sourceHash,
    mode: 'exact',
    status: 'warning',
    axis: {
      source: 'candidate',
      axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
    },
    layers: coloredLayers.map((layer) => ({
      id: layer.id, index: layer.index, zStart: layer.zStart, zEnd: layer.zEnd,
      contour: { outer: layer.exterior.outer, holes: [] },
      sourceAreaMm2: 4, simplifiedAreaMm2: 4,
      sourceBoundsMm: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
      simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0,
      removedComponentCount: 0,
    })),
    coloredLayers,
    featureWarnings: [CENTRAL_HOLE_OMISSION_WARNING],
    preview: {
      mesh: {
        positions: Float32Array.from(previewSource.positions),
        indices: previewSource.indices.slice(),
      },
      axis: {
        origin: [0, 0, 0] as const,
        direction: [0, 0, 1] as const,
        planeX: [0, 1, 0] as const,
        planeY: [-1, 0, 0] as const,
      },
      layers: coloredLayers,
    },
    warnings: [],
    originalReport: importRepairAnalysis(sourceHash).originalReport,
    repairAccepted: true,
    removedComponentCount: 0,
    removalEvidenceFingerprint: '0'.repeat(32),
    diagnostics: { topology: { triangleCount: 4, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true }, repairDecision: 'accepted', rasterCellSizeMm: null, layers: [] },
  };
  return { ...result, featureEvidenceFingerprint: featureEvidenceFingerprint(result) };
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
  it.each([
    ['unknown keys', { id: 'birch', name: 'Birch', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 }, operatorName: 'private' }],
    ['non-finite dimensions', { id: 'birch', name: 'Birch', thicknessMm: Number.NaN, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } }],
    ['forbidden evidence strings', { id: 'birch', name: 'Birch', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 }, manufacturer: 'private' }],
    ['overlong identifiers', { id: 'i'.repeat(501), name: 'n'.repeat(501), thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } }],
  ])('rejects %s from a structured-clone material request', (_reason, material) => {
    expect(() => validateManufacturingGeometryProfile(structuredClone(material))).toThrow();
  });

  it('accepts only the bounded structured non-timeout artifact error contract', () => {
    expect(OUTLINE_ARTIFACT_IDS).toEqual([
      'colored-outline-document',
      'cut-and-engrave.svg',
      'cut-and-engrave.dxf',
      'preview.pdf',
      'exploded-view.pdf',
      'shapecut-files.zip',
      'package-verification',
    ]);
    for (const artifact of OUTLINE_ARTIFACT_IDS) {
      const error = new OutlineArtifactError(artifact);
      expect(isSerializedOutlineArtifactError({
        name: error.name, code: error.code, artifact: error.artifact, message: error.message,
      })).toBe(true);
    }
    expect(isSerializedOutlineArtifactError({
      name: 'OutlineArtifactError', code: 'ARTIFACT_FAILURE', artifact: 'private.stl', message: 'forged',
    })).toBe(false);
    expect(isSerializedOutlineArtifactError({
      name: 'OutlineArtifactError', code: 'ARTIFACT_FAILURE', artifact: 'preview.pdf', message: '/Users/private/source.stl',
    })).toBe(false);
  });

  it('keeps the colored result and preview contract stable across structured clone', () => {
    const cloned = structuredClone(automaticResult('automatic'));

    expect(() => validateAutomaticColoredResult(cloned)).not.toThrow();
    expect(cloned).toMatchObject({
      coloredLayers: expect.any(Array),
      featureWarnings: expect.any(Array),
      featureEvidenceFingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      preview: {
        layers: expect.any(Array),
        axis: {
          planeX: [0, 1, 0],
          planeY: [-1, 0, 0],
        },
      },
    });
    expect(Object.prototype.toString.call(cloned.preview.mesh.positions)).toBe('[object Float32Array]');
    expect(Object.prototype.toString.call(cloned.preview.mesh.indices)).toBe('[object Uint32Array]');
  });

  it('forwards automatic conversion progress without requiring a Comlink callback in unit mocks', async () => {
    const onProgress = vi.fn();
    const api = inspectOnly(vi.fn());
    api.convertAutomatically = vi.fn(async (_request, progress) => {
      progress?.({ stage: 'reading' });
      progress?.({ stage: 'packaging' });
      return automaticResult('automatic');
    });
    const client = makeGeometryClient(api);
    const bytes = new ArrayBuffer(4);

    await expect(convertAutomatically(client, { bytes }, onProgress)).resolves.toMatchObject({ sourceHash: 'automatic' });

    expect(api.convertAutomatically).toHaveBeenCalledWith({ bytes, material: testMaterial }, expect.any(Function));
    const forwardedProgress = vi.mocked(api.convertAutomatically).mock.calls[0][1];
    expect((forwardedProgress as typeof forwardedProgress & { [proxyMarker]?: true })?.[proxyMarker]).toBeUndefined();
    expect(onProgress.mock.calls).toEqual([[{ stage: 'reading' }], [{ stage: 'packaging' }]]);
  });

  it('supersedes an active automatic conversion before starting its replacement', async () => {
    const firstRemote = deferred<AutomaticOutlineResult>();
    const api = inspectOnly(vi.fn());
    api.convertAutomatically = vi.fn()
      .mockReturnValueOnce(firstRemote.promise)
      .mockResolvedValueOnce(automaticResult('replacement'));
    const abortExecution = vi.fn();
    const client = makeGeometryClient(api, { abortExecution });

    const first = convertAutomatically(client, { bytes: new ArrayBuffer(8) });
    await Promise.resolve();
    const second = convertAutomatically(client, { bytes: new ArrayBuffer(8) });

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

    const first = convertAutomatically(client, { bytes: new ArrayBuffer(8) }, onProgress);
    await Promise.resolve();
    const second = convertAutomatically(client, { bytes: new ArrayBuffer(8) });
    await expect(first).rejects.toBeInstanceOf(SupersededError);
    await expect(second).resolves.toMatchObject({ sourceHash: 'replacement' });

    if (typeof staleProgress === 'function') await staleProgress({ stage: 'packaging' });
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

  it('supersedes in-flight outline packaging before starting the replacement job', async () => {
    const pending = deferred<never>();
    const api = inspectOnly(vi.fn());
    api.packageOutline = vi.fn(() => pending.promise);
    api.convertAutomatically = vi.fn().mockResolvedValue(automaticResult('replacement'));
    const client = makeGeometryClient(api);

    const first = client.packageOutline(automaticResult('first'));
    const replacement = convertAutomatically(client, { bytes: new ArrayBuffer(1) });

    await expect(first).rejects.toBeInstanceOf(SupersededError);
    await expect(replacement).resolves.toMatchObject({ sourceHash: 'replacement' });
  });
});
