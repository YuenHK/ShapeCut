import { expose, releaseProxy, transfer, wrap, type Remote } from 'comlink';
import { DEFAULT_OUTLINE_BUDGETS } from '../domain/outline-2.5d/types';
import { findAxisCandidates } from '../domain/axis/find-axis';
import { validateManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { validateLauncherFitOffsetMm } from '../domain/outline-assembly/launcher-fit';
import { generateParts } from '../domain/decomposition/generate-parts';
import { quantizeHeightField } from '../domain/engraving/quantize';
import { repairMeshAdvanced } from '../domain/mesh/advanced-repair';
import { inspectMesh } from '../domain/mesh/inspect-mesh';
import { parseSTL } from '../domain/mesh/parse-stl';
import { analyzeMeshProblems } from '../domain/mesh/problem-report';
import { repairMeshSafe } from '../domain/mesh/repair-mesh';
import {
  AutomaticOutlineError,
  convertAutomatically,
  stripAutomaticOutlineInternalEvidence,
  type AutomaticOutlineProgress,
} from '../domain/pipeline/automatic-outline-pipeline';
import type { MeshRepairResult, TriangleMesh } from '../domain/mesh/types';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import { createOutlinePackage } from '../export/outline-package';
import { nearLimitColoredResult } from '../export/colored-outline-test-fixture';
import { setHoleCandidateProbeForTesting } from '../domain/outline-2.5d/extract';
import { createStlPresentationPayload } from '../preview/stl-presentation';
import { WasmExactSegmentSource } from '../domain/outline-2.5d/segment-source';
import {
  OutlineArtifactError,
  type GeometryAccelerationProbe,
  type GeometryApi,
  type ImportRepairAnalysis,
  type MeshAnalysis,
  type OutlineArtifactId,
  type OutlinePackageTransfer,
} from './geometry-api';
import { InternalAutomaticResultCache } from './internal-automatic-result-cache';

let nearLimitPackageWorkload: ReturnType<typeof nearLimitColoredResult> | undefined;
const internalResultCache = new InternalAutomaticResultCache();
const acceptanceProbeEnabled = new URL(globalThis.location.href).searchParams.get('shapecut-acceptance') === '1';
const exactSegmentSource = new WasmExactSegmentSource({
  minimumWasmWork: acceptanceProbeEnabled ? 0 : undefined,
  onPublication: (collection, generation) => {
    if (!acceptanceProbeEnabled || collection.origin !== 'wasm') return;
    const message: GeometryAccelerationProbe = {
      type: 'SHAPECUT_WASM_SEGMENTS_PUBLISHED',
      origin: 'wasm',
      layerCount: collection.layers.length,
      generation,
      activeWorkerCount: exactSegmentSource.activeWorkerCount,
    };
    globalThis.postMessage(message);
  },
});

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!acceptanceProbeEnabled) return;
  const message = typeof event.data === 'object' && event.data !== null
    ? event.data as Record<string, unknown>
    : undefined;
  if (message?.type === 'SHAPECUT_TEST_HOLE_PROBE_ENABLE') {
    setHoleCandidateProbeForTesting((evidence) => {
      globalThis.postMessage({ type: 'SHAPECUT_HOLE_CANDIDATES', evidence });
    });
  }
  if ((message?.type === 'SHAPECUT_WASM_STATE_REQUEST'
      || message?.type === 'SHAPECUT_WASM_CANCEL_REQUEST')
    && Number.isSafeInteger(message.requestId)) {
    const respond = (): void => {
      globalThis.postMessage({
        type: 'SHAPECUT_WASM_STATE',
        requestId: message.requestId,
        generation: exactSegmentSource.generation,
        activeWorkerCount: exactSegmentSource.activeWorkerCount,
      });
    };
    if (message.type === 'SHAPECUT_WASM_CANCEL_REQUEST') {
      void exactSegmentSource.cancel().then(respond);
    } else {
      respond();
    }
  }
  if (message?.type === 'SHAPECUT_TEST_NEAR_LIMIT_PACKAGE') {
    nearLimitPackageWorkload = nearLimitColoredResult();
    const contourPoints = nearLimitPackageWorkload.coloredLayers.flatMap((layer) => [
      layer.exterior, layer.centralHole,
      ...layer.launcherCuts, ...layer.fastenerHoles, ...layer.deepFeatures, ...layer.lightFeatures,
    ].flatMap((contour) => contour ? [contour.outer.length] : []));
    globalThis.postMessage({
      type: 'SHAPECUT_PACKAGE_WORKLOAD_READY',
      evidence: {
        layers: nearLimitPackageWorkload.coloredLayers.length,
        contoursPerLayer: contourPoints.length / nearLimitPackageWorkload.coloredLayers.length,
        minimumPointsPerContour: Math.min(...contourPoints),
        maximumPointsPerContour: Math.max(...contourPoints),
        totalPoints: contourPoints.reduce((sum, count) => sum + count, 0),
      },
    });
  }
});

function previewMesh(mesh: TriangleMesh, maximumTriangles = 2_000): TriangleMesh {
  const indexLimit = Math.min(mesh.indices.length, maximumTriangles * 3);
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(indexLimit);
  for (let offset = 0; offset < indexLimit; offset += 1) {
    const source = mesh.indices[offset];
    let target = remap.get(source);
    if (target === undefined) {
      target = remap.size;
      remap.set(source, target);
      positions.push(mesh.positions[source * 3], mesh.positions[source * 3 + 1], mesh.positions[source * 3 + 2]);
    }
    indices[offset] = target;
  }
  return { positions: new Float64Array(positions), indices };
}

function hashBuffer(input: ArrayBuffer): string {
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  const bytes = new Uint8Array(input);
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let hash = lanes[lane];
    for (const byte of bytes) hash = Math.imul(hash ^ (byte + lane * 131), 16777619 + lane * 2) >>> 0;
    lanes[lane] = hash;
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

const geometryApi: GeometryApi = {
  async createStlPresentation(input) {
    const presentation = createStlPresentationPayload(input);
    return transfer(presentation, [
      presentation.mesh.positions.buffer,
      presentation.mesh.indices.buffer,
    ]);
  },
  async convertAutomatically(request, onProgress) {
    let progressProxy: Remote<AutomaticOutlineProgress> | undefined;
    let progress: AutomaticOutlineProgress | undefined;
    if (onProgress instanceof MessagePort) {
      progressProxy = wrap<AutomaticOutlineProgress>(onProgress);
      progress = progressProxy;
    } else {
      progress = onProgress;
    }
    try {
      const internalResult = await convertAutomatically({
        bytes: request.bytes,
        material: validateManufacturingGeometryProfile(request.material),
        launcherFitOffsetMm: validateLauncherFitOffsetMm(request.launcherFitOffsetMm),
      }, progress, { exactSegmentSource });
      internalResultCache.store(internalResult);
      return stripAutomaticOutlineInternalEvidence(internalResult);
    } catch (error) {
      if (error instanceof AutomaticOutlineError) {
        throw { name: error.name, code: error.code, message: error.message };
      }
      throw error;
    } finally {
      progressProxy?.[releaseProxy]();
    }
  },
  async packageOutline(result, deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs) {
    let output: Awaited<ReturnType<typeof createOutlinePackage>>;
    let acknowledgedPdfStart = false;
    let activeArtifact: OutlineArtifactId = 'colored-outline-document';
    try {
      if ('internalValidationEvidence' in result) {
        throw new RangeError('Public package transfer must not contain internal validation evidence');
      }
      const cached = internalResultCache.resolve(result);
      if (!nearLimitPackageWorkload && !cached) {
        throw new RangeError('Internal validation evidence is unavailable for this public package request');
      }
      const packageInput = nearLimitPackageWorkload ?? {
        ...result,
        centralHoleSourceEvidence: cached!.centralHoleSourceEvidence,
        decorationOmissionSourceEvidence: cached!.decorationOmissionSourceEvidence,
        internalValidationEvidence: cached!.internalValidationEvidence,
      };
      nearLimitPackageWorkload = undefined;
      output = await createOutlinePackage(packageInput, deadline, {
        onCheckpoint: (label) => {
          activeArtifact = artifactForPackageCheckpoint(label, activeArtifact);
          if (acknowledgedPdfStart || label !== 'pdf:create:before') return;
          acknowledgedPdfStart = true;
          globalThis.postMessage({ type: 'SHAPECUT_PACKAGE_CHECKPOINT', label });
        },
      });
    } catch (error) {
      if (error instanceof Error && /deadline|runtime|time limit/i.test(error.message)) {
        throw { name: 'AutomaticOutlineError', code: 'TIME_LIMIT', message: '模型處理超出時間上限' };
      }
      const artifactError = new OutlineArtifactError(activeArtifact, { cause: error });
      throw {
        name: artifactError.name,
        code: artifactError.code,
        artifact: artifactError.artifact,
        message: artifactError.message,
      };
    }
    const packaged: OutlinePackageTransfer = {
      zip: output.zip,
      cutSvg: output.cutSvg,
      cutDxf: output.cutDxf,
      previewPdf: output.previewPdf,
      explodedViewPdf: output.explodedViewPdf,
      launcherCouponSvg: output.launcherCouponSvg,
    };
    return transfer(packaged, [
      packaged.zip.buffer,
      packaged.previewPdf.buffer,
      packaged.explodedViewPdf.buffer,
    ]);
  },
  async inspect(input) {
    const sourceHash = hashBuffer(input);
    const mesh = parseSTL(input);
    const preview = previewMesh(mesh);
    const result: MeshAnalysis = { sourceHash, mesh, previewMesh: preview, inspection: inspectMesh(mesh) };
    return transfer(result, [mesh.positions.buffer, mesh.indices.buffer, preview.positions.buffer, preview.indices.buffer]);
  },
  async inspectAndFindAxes(input) {
    const sourceHash = hashBuffer(input);
    const mesh = parseSTL(input);
    const inspection = inspectMesh(mesh);
    const preview = previewMesh(mesh);
    const problems = analyzeMeshProblems(mesh, 0);
    const invalidTopology = inspection.boundaryEdgeCount > 0
      || inspection.nonManifoldEdgeCount > 0
      || problems.inconsistentWindingEdgeCount > 0
      || problems.selfIntersectionCount > 0
      || !problems.selfIntersectionAnalysisComplete;
    const candidates = invalidTopology ? [] : findAxisCandidates(mesh, { sampleCount: 4096 });
    return transfer({ sourceHash, previewMesh: preview, inspection, candidates }, [preview.positions.buffer, preview.indices.buffer]);
  },
  async analyzeAndRepairForImport(input) {
    const sourceHash = hashBuffer(input);
    const originalMesh = parseSTL(input);
    const originalPreview = previewMesh(originalMesh);
    const originalReport = analyzeMeshProblems(originalMesh);
    const safeRepair = repairMeshSafe(originalMesh, { beforeReport: originalReport });
    const candidates = safeRepair.accepted
      ? findAxisCandidates(safeRepair.mesh, { sampleCount: 4096 })
      : [];
    const result: ImportRepairAnalysis = {
      sourceHash,
      originalMesh,
      originalPreview,
      originalReport,
      safeRepair,
      candidates,
    };
    return transfer(result, meshBuffers(originalMesh, originalPreview, safeRepair.mesh));
  },
  async repairAdvanced(original, safeMesh) {
    return transferRepairResult(repairMeshAdvanced(original, safeMesh));
  },
  async serializeSTL(mesh, mode) {
    const bytes = writeBinarySTL(mesh, mode);
    const expectedTriangleCount = mesh.indices.length / 3;
    const expectedByteLength = 84 + expectedTriangleCount * 50;
    const reparsed = parseSTL(bytes);
    const declaredTriangleCount = new DataView(bytes).getUint32(80, true);
    if (
      bytes.byteLength !== expectedByteLength
      || declaredTriangleCount !== expectedTriangleCount
      || reparsed.indices.length / 3 !== expectedTriangleCount
    ) {
      throw new Error('Serialized STL validation failed');
    }
    return transfer(bytes, [bytes]);
  },
  async findAxes(mesh) {
    return findAxisCandidates(mesh, { sampleCount: 4096 });
  },
  async decompose({ profile, material, options }) {
    return generateParts(profile, material, options);
  },
  async engrave({ field, levels, options }) {
    return quantizeHeightField(field, levels, options);
  },
};

function artifactForPackageCheckpoint(
  label: string,
  current: OutlineArtifactId,
): OutlineArtifactId {
  if (label.startsWith('colored-package:verify')) return 'package-verification';
  if (label === 'colored-package:svg:before') return 'cut-and-engrave.svg';
  if (label === 'colored-package:dxf:before') return 'cut-and-engrave.dxf';
  if (label === 'colored-package:preview-pdf:before') return 'preview.pdf';
  if (label === 'colored-package:exploded-pdf:before') return 'exploded-view.pdf';
  if (label === 'colored-package:launcher-coupon:before') return 'launcher-fit-coupon.svg';
  if (label === 'colored-package:zip:before') return 'shapecut-files.zip';
  if (label === 'colored-package:create:start' || label.startsWith('canonical:')) {
    return 'colored-outline-document';
  }
  return current;
}

function meshBuffers(...meshes: readonly TriangleMesh[]): Transferable[] {
  return meshes.flatMap((mesh) => [mesh.positions.buffer, mesh.indices.buffer]);
}

function transferRepairResult(result: MeshRepairResult): MeshRepairResult {
  return transfer(result, meshBuffers(result.mesh));
}

expose(geometryApi);
