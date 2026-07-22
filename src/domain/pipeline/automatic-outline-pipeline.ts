import { findAxisCandidates } from '../axis/find-axis';
import {
  validateManufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from '../materials/manufacturing-profile';
import { MAX_STL_BYTES, parseSTL } from '../mesh/parse-stl';
import { analyzeMeshProblems } from '../mesh/problem-report';
import { repairMeshSafe } from '../mesh/repair-mesh';
import type { MeshProblemReport, TriangleMesh } from '../mesh/types';
import { selectOutlineAxis } from '../outline-2.5d/axis';
import {
  colorizeExteriorLayers,
  ExactContourAmbiguityError,
  extractExactContours,
  extractProjectedContours,
  type OutlineExtraction,
  type OutlineLayer,
} from '../outline-2.5d/extract';
import { createOutlineAxisBasis } from '../outline-2.5d/raster';
import { scheduleOutlineLayers } from '../outline-2.5d/layer-schedule';
import {
  featureEvidenceFingerprint,
  validateAutomaticColoredResult,
  type ColoredOutlineLayer,
  type OutlinePreviewPayload,
} from '../outline-features/types';
import {
  DEFAULT_OUTLINE_BUDGETS,
  type OutlineAxisSelection,
  type OutlineMode,
  type OutlineResultStatus,
} from '../outline-2.5d/types';

export type AutomaticOutlineProgressStage = 'reading' | 'analyzing' | 'simplifying' | 'slicing' | 'packaging';
export type AutomaticOutlineProgressEvent =
  | { readonly stage: AutomaticOutlineProgressStage }
  | { readonly stage: 'analyzing' | 'slicing'; readonly preview: OutlinePreviewPayload };
export type AutomaticOutlineResult = {
  readonly sourceHash: string;
  /** Bounded material evidence required to verify the feature fingerprint during packaging. */
  readonly material?: ManufacturingGeometryProfile;
  readonly mode: OutlineMode;
  readonly status: OutlineResultStatus;
  readonly axis: OutlineAxisSelection;
  readonly layers: readonly OutlineLayer[];
  readonly coloredLayers: readonly ColoredOutlineLayer[];
  readonly featureWarnings: readonly string[];
  readonly featureEvidenceFingerprint: string;
  readonly preview: OutlinePreviewPayload;
  readonly warnings: readonly string[];
  readonly originalReport: MeshProblemReport;
  readonly repairAccepted: boolean;
  readonly removedComponentCount: number;
  readonly removalEvidenceFingerprint: string;
  readonly diagnostics: AutomaticOutlineDiagnostics;
};
export type AutomaticOutlineDiagnostics = {
  readonly topology: Readonly<Pick<MeshProblemReport['inspection'], 'triangleCount' | 'boundaryEdgeCount' | 'nonManifoldEdgeCount' | 'degenerateTriangleCount'>> & Readonly<Pick<MeshProblemReport, 'duplicateTriangleCount' | 'inconsistentWindingEdgeCount' | 'selfIntersectionCount' | 'selfIntersectionAnalysisComplete'>>;
  readonly repairDecision: 'accepted' | 'projected-original';
  readonly rasterCellSizeMm: number | null;
  readonly layers: readonly { readonly id: string; readonly simplificationToleranceMm: number; readonly boundsDriftRatio: number; readonly areaDriftRatio: number; readonly areaEvidenceBasis: 'exact-slice-pre-simplification' | 'retained-raster-pre-simplification' }[];
};
export type AutomaticOutlineRequest = { readonly bytes: ArrayBuffer; readonly material: ManufacturingGeometryProfile };
export type AutomaticOutlineProgress = (event: AutomaticOutlineProgressEvent) => void | Promise<void>;
export type AutomaticOutlineErrorCode = 'INVALID_STL' | 'NO_OUTLINE' | 'RESOURCE_LIMIT' | 'TIME_LIMIT';

export class AutomaticOutlineError extends Error {
  readonly name = 'AutomaticOutlineError';

  constructor(readonly code: AutomaticOutlineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const PROJECTED_WARNINGS = Object.freeze([
  '已簡化模型',
  '原始內部細節、孔洞及細小分離零件已被忽略',
  '不同材料厚度會改變堆疊後高度',
  '輸出不包含雷射功率或速度',
  '正式製作前應先試切少量零件',
]);
const FALLBACK_AXIS_WARNING = '未找到可信旋轉軸，已使用模型最短包圍盒軸';

function sourceHash(input: ArrayBuffer): string {
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  const bytes = new Uint8Array(input);
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let hash = lanes[lane];
    for (const byte of bytes) hash = Math.imul(hash ^ (byte + lane * 131), 16777619 + lane * 2) >>> 0;
    lanes[lane] = hash;
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

export function removalEvidenceFingerprint(result: Pick<AutomaticOutlineResult, 'sourceHash' | 'mode' | 'layers'>): string {
  const value = JSON.stringify({ sourceHash: result.sourceHash, mode: result.mode, layers: result.layers.map(({ id, index, zStart, zEnd, removedComponentCount }) => ({ id, index, zStart, zEnd, removedComponentCount })) });
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let lane = 0; lane < lanes.length; lane += 1) for (const char of value) lanes[lane] = Math.imul(lanes[lane] ^ (char.charCodeAt(0) + lane * 131), 16777619 + lane * 2) >>> 0;
  return lanes.map((item) => item.toString(16).padStart(8, '0')).join('');
}

export function diagnosticsFingerprint(value: AutomaticOutlineDiagnostics): string {
  const serialized = JSON.stringify(value), lanes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let lane = 0; lane < lanes.length; lane += 1) for (const char of serialized) lanes[lane] = Math.imul(lanes[lane] ^ (char.charCodeAt(0) + lane * 131), 16777619 + lane * 2) >>> 0;
  return lanes.map((item) => item.toString(16).padStart(8, '0')).join('');
}

function checkEvidenceDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new RangeError('Automatic outline evidence exceeded the runtime budget');
}

const MAX_PREVIEW_TRIANGLES = 2_000;

function copyPreviewMesh(mesh: TriangleMesh, deadline: number): OutlinePreviewPayload['mesh'] {
  checkEvidenceDeadline(deadline);
  const triangleCount = Math.floor(mesh.indices.length / 3);
  const previewTriangleCount = Math.min(triangleCount, MAX_PREVIEW_TRIANGLES);
  const sourceToPreview = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(previewTriangleCount * 3);
  for (let previewTriangle = 0; previewTriangle < previewTriangleCount; previewTriangle += 1) {
    if ((previewTriangle & 1023) === 0) checkEvidenceDeadline(deadline);
    const sourceTriangle = previewTriangleCount === triangleCount || previewTriangleCount <= 1
      ? previewTriangle
      : Math.floor(previewTriangle * (triangleCount - 1) / (previewTriangleCount - 1));
    for (let corner = 0; corner < 3; corner += 1) {
      const sourceIndex = mesh.indices[sourceTriangle * 3 + corner];
      let previewIndex = sourceToPreview.get(sourceIndex);
      if (previewIndex === undefined) {
        previewIndex = sourceToPreview.size;
        sourceToPreview.set(sourceIndex, previewIndex);
        positions.push(
          mesh.positions[sourceIndex * 3],
          mesh.positions[sourceIndex * 3 + 1],
          mesh.positions[sourceIndex * 3 + 2],
        );
      }
      indices[previewTriangle * 3 + corner] = previewIndex;
    }
  }
  checkEvidenceDeadline(deadline);
  const previewPositions = Float32Array.from(positions);
  for (let index = 0; index < previewPositions.length; index += 1) {
    if ((index & 4095) === 0) checkEvidenceDeadline(deadline);
    if (!Number.isFinite(previewPositions[index])) {
      throw new AutomaticOutlineError('RESOURCE_LIMIT', '模型座標超出安全預覽範圍');
    }
  }
  checkEvidenceDeadline(deadline);
  return { positions: previewPositions, indices };
}

function meshBoundsCenter(mesh: TriangleMesh, deadline: number): readonly [number, number, number] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    if ((index & 4095) === 0) checkEvidenceDeadline(deadline);
    const x = mesh.positions[index], y = mesh.positions[index + 1], z = mesh.positions[index + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  checkEvidenceDeadline(deadline);
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

function clonePreviewPayload(preview: OutlinePreviewPayload): OutlinePreviewPayload {
  return {
    mesh: {
      positions: preview.mesh.positions.slice(),
      indices: preview.mesh.indices.slice(),
    },
    axis: preview.axis,
    layers: preview.layers,
  };
}

function withResultEvidence(
  result: Omit<AutomaticOutlineResult, 'coloredLayers' | 'featureWarnings' | 'featureEvidenceFingerprint' | 'preview' | 'removalEvidenceFingerprint'>,
  previewMesh: TriangleMesh,
  deadline: number,
  extraction: Pick<OutlineExtraction, 'holeSelections' | 'depthFeatures' | 'blackCuts' | 'featureWarnings'>,
  material: ManufacturingGeometryProfile,
): AutomaticOutlineResult {
  let coloredLayers: readonly ColoredOutlineLayer[];
  let previewMeshCopy: OutlinePreviewPayload['mesh'];
  try {
    coloredLayers = colorizeExteriorLayers(
      result.layers,
      result.diagnostics.rasterCellSizeMm ?? 0,
      deadline,
      () => undefined,
      extraction.holeSelections,
      extraction.depthFeatures,
      extraction.blackCuts,
    );
    previewMeshCopy = copyPreviewMesh(previewMesh, deadline);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
  const previewBasis = createOutlineAxisBasis(result.axis.axis);
  const coloredResult = {
    ...result,
    coloredLayers,
    featureWarnings: extraction.featureWarnings,
    preview: {
      mesh: previewMeshCopy,
      axis: {
        origin: result.axis.axis.origin,
        direction: result.axis.axis.direction,
        planeX: previewBasis.planeX,
        planeY: previewBasis.planeY,
      },
      layers: coloredLayers,
    },
  };
  try {
    const complete: AutomaticOutlineResult = {
      ...coloredResult,
      material,
      removalEvidenceFingerprint: removalEvidenceFingerprint(result),
      featureEvidenceFingerprint: featureEvidenceFingerprint(coloredResult, deadline, () => undefined, material),
    };
    validateAutomaticColoredResult(complete, deadline, () => undefined, material);
    return complete;
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
}

function diagnostics(extraction: { readonly layers: readonly OutlineLayer[]; readonly cellSizeMm?: number }, report: MeshProblemReport, repairAccepted: boolean): AutomaticOutlineDiagnostics {
  const { triangleCount, boundaryEdgeCount, nonManifoldEdgeCount, degenerateTriangleCount } = report.inspection;
  const { duplicateTriangleCount, inconsistentWindingEdgeCount, selfIntersectionCount, selfIntersectionAnalysisComplete } = report;
  return {
    topology: { triangleCount, boundaryEdgeCount, nonManifoldEdgeCount, degenerateTriangleCount, duplicateTriangleCount, inconsistentWindingEdgeCount, selfIntersectionCount, selfIntersectionAnalysisComplete },
    repairDecision: repairAccepted ? 'accepted' : 'projected-original',
    rasterCellSizeMm: extraction.cellSizeMm ?? null,
    layers: extraction.layers.map(({ id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio }) => ({ id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio, areaEvidenceBasis: extraction.cellSizeMm === undefined ? 'exact-slice-pre-simplification' as const : 'retained-raster-pre-simplification' as const })),
  };
}

function automaticAxis(mesh: TriangleMesh): OutlineAxisSelection {
  try {
    return selectOutlineAxis(mesh, findAxisCandidates(mesh, { sampleCount: 4096 }));
  } catch {
    return selectOutlineAxis(mesh, []);
  }
}

function asAutomaticOutlineError(error: unknown, fallbackCode: AutomaticOutlineErrorCode): AutomaticOutlineError {
  if (error instanceof AutomaticOutlineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/runtime|deadline|time limit|timed out/i.test(message)) {
    return new AutomaticOutlineError('TIME_LIMIT', '模型處理超出時間上限', { cause: error });
  }
  if (/budget|resource|too many|exceeds?.*limit|maximum/i.test(message)) {
    return new AutomaticOutlineError('RESOURCE_LIMIT', '模型超出安全處理資源上限', { cause: error });
  }
  const userMessage = fallbackCode === 'INVALID_STL'
    ? '無法讀取 STL 檔案'
    : '模型沒有足夠的有效投影外形';
  return new AutomaticOutlineError(fallbackCode, userMessage, { cause: error });
}

export async function convertAutomatically(
  request: AutomaticOutlineRequest,
  onProgress?: AutomaticOutlineProgress,
): Promise<AutomaticOutlineResult> {
  const material = validateManufacturingGeometryProfile(request.material);
  if (request.bytes.byteLength > MAX_STL_BYTES) {
    throw new AutomaticOutlineError('RESOURCE_LIMIT', '模型超出安全處理資源上限');
  }
  const deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs;
  let lastStage = -1;
  const previewStages = new Set<AutomaticOutlineProgressEvent['stage']>();
  const stages: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
  const emit = async (event: AutomaticOutlineProgressEvent): Promise<void> => {
    const index = stages.indexOf(event.stage);
    const hasPreview = 'preview' in event;
    if (index < lastStage || (index === lastStage && (!hasPreview || previewStages.has(event.stage)))) return;
    lastStage = index;
    if (hasPreview) previewStages.add(event.stage);
    await onProgress?.(event);
    try {
      checkEvidenceDeadline(deadline);
    } catch (error) {
      throw asAutomaticOutlineError(error, 'TIME_LIMIT');
    }
  };

  await emit({ stage: 'reading' });
  const hash = sourceHash(request.bytes);
  let originalMesh: TriangleMesh;
  try {
    originalMesh = parseSTL(request.bytes);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'INVALID_STL');
  }

  const provisionalBasis = createOutlineAxisBasis({ origin: [0, 0, 0], direction: [0, 0, 1] });
  let analyzingPreviewMesh: OutlinePreviewPayload['mesh'];
  let analyzingOrigin: readonly [number, number, number];
  try {
    analyzingPreviewMesh = copyPreviewMesh(originalMesh, deadline);
    analyzingOrigin = meshBoundsCenter(originalMesh, deadline);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'TIME_LIMIT');
  }
  await emit({
    stage: 'analyzing',
    preview: {
      mesh: analyzingPreviewMesh,
      axis: {
        origin: analyzingOrigin, direction: [0, 0, 1],
        planeX: provisionalBasis.planeX, planeY: provisionalBasis.planeY,
      },
      layers: [],
    },
  });
  let originalReport: MeshProblemReport;
  let safeRepair: ReturnType<typeof repairMeshSafe>;
  try {
    originalReport = analyzeMeshProblems(originalMesh);
    safeRepair = repairMeshSafe(originalMesh, { beforeReport: originalReport });
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }

  await emit({ stage: 'simplifying' });
  const extractionMesh = safeRepair.accepted ? safeRepair.mesh : originalMesh;
  let axis: OutlineAxisSelection;
  let specs: ReturnType<typeof scheduleOutlineLayers>;
  try {
    axis = automaticAxis(extractionMesh);
    specs = scheduleOutlineLayers(extractionMesh, axis.axis, DEFAULT_OUTLINE_BUDGETS);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
  const axisWarnings = axis.source === 'shortest-bounds' ? [FALLBACK_AXIS_WARNING] : [];

  await emit({ stage: 'slicing' });
  if (safeRepair.accepted) {
    let exactExtraction: ReturnType<typeof extractExactContours>;
    try {
      exactExtraction = extractExactContours(extractionMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline);
    } catch (exactError) {
      const mappedExactError = asAutomaticOutlineError(exactError, 'NO_OUTLINE');
      if (mappedExactError.code !== 'NO_OUTLINE' || !(exactError instanceof ExactContourAmbiguityError)) {
        throw mappedExactError;
      }
      let projectedExtraction: ReturnType<typeof extractProjectedContours>;
      try {
        projectedExtraction = extractProjectedContours(
          extractionMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline,
        );
      } catch (projectedError) {
        throw asAutomaticOutlineError(projectedError, 'NO_OUTLINE');
      }
      const result = withResultEvidence({
        sourceHash: hash,
        mode: 'outline-2.5d',
        status: 'warning',
        axis,
        layers: projectedExtraction.layers,
        warnings: [...PROJECTED_WARNINGS, ...axisWarnings, '精確切片失敗，已改用 2.5D 外形模式'],
        originalReport,
        repairAccepted: true,
        removedComponentCount: projectedExtraction.removedComponentCount,
        diagnostics: diagnostics(projectedExtraction, originalReport, true),
      }, extractionMesh, deadline, projectedExtraction, material);
      await emit({ stage: 'slicing', preview: clonePreviewPayload(result.preview) });
      await emit({ stage: 'packaging' });
      return result;
    }
    const result = withResultEvidence({
      sourceHash: hash,
      mode: 'exact',
      status: axisWarnings.length === 0 && exactExtraction.featureWarnings.length === 0 ? 'success' : 'warning',
      axis,
      layers: exactExtraction.layers,
      warnings: axisWarnings,
      originalReport,
      repairAccepted: true,
      removedComponentCount: 0,
      diagnostics: diagnostics(exactExtraction, originalReport, true),
    }, extractionMesh, deadline, exactExtraction, material);
    await emit({ stage: 'slicing', preview: clonePreviewPayload(result.preview) });
    await emit({ stage: 'packaging' });
    return result;
  }

  let projectedExtraction: ReturnType<typeof extractProjectedContours>;
  try {
    projectedExtraction = extractProjectedContours(originalMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
  const result = withResultEvidence({
    sourceHash: hash,
    mode: 'outline-2.5d',
    status: 'warning',
    axis,
    layers: projectedExtraction.layers,
    warnings: [...PROJECTED_WARNINGS, ...axisWarnings],
    originalReport,
    repairAccepted: false,
    removedComponentCount: projectedExtraction.removedComponentCount,
    diagnostics: diagnostics(projectedExtraction, originalReport, false),
  }, originalMesh, deadline, projectedExtraction, material);
  await emit({ stage: 'slicing', preview: clonePreviewPayload(result.preview) });
  await emit({ stage: 'packaging' });
  return result;
}
