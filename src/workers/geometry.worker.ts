import { expose, releaseProxy, transfer, wrap, type Remote } from 'comlink';
import { findAxisCandidates } from '../domain/axis/find-axis';
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
  type AutomaticOutlineProgress,
} from '../domain/pipeline/automatic-outline-pipeline';
import type { MeshRepairResult, TriangleMesh } from '../domain/mesh/types';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import { createOutlinePackage } from '../export/outline-package';
import type { GeometryApi, ImportRepairAnalysis, MeshAnalysis, OutlinePackageTransfer } from './geometry-api';

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
      return await convertAutomatically(request, progress);
    } catch (error) {
      if (error instanceof AutomaticOutlineError) {
        throw { name: error.name, code: error.code, message: error.message };
      }
      throw error;
    } finally {
      progressProxy?.[releaseProxy]();
    }
  },
  async packageOutline(result, deadline = Date.now() + 30_000) {
    let output: Awaited<ReturnType<typeof createOutlinePackage>>;
    try {
      output = await createOutlinePackage(result, deadline);
    } catch (error) {
      if (error instanceof Error && /deadline|runtime|time limit/i.test(error.message)) {
        throw { name: 'AutomaticOutlineError', code: 'TIME_LIMIT', message: '模型處理超出時間上限' };
      }
      throw error;
    }
    const packaged: OutlinePackageTransfer = {
      zip: output.zip,
      cutSvg: output.cutSvg,
      cutDxf: output.cutDxf,
      previewPdf: output.previewPdf,
      explodedViewPdf: output.explodedViewPdf,
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

function meshBuffers(...meshes: readonly TriangleMesh[]): Transferable[] {
  return meshes.flatMap((mesh) => [mesh.positions.buffer, mesh.indices.buffer]);
}

function transferRepairResult(result: MeshRepairResult): MeshRepairResult {
  return transfer(result, meshBuffers(result.mesh));
}

expose(geometryApi);
