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
  type OutlineBlackCutPlanningContext,
  type OutlineLayer,
} from '../outline-2.5d/extract';
import {
  LauncherCompatibilityError,
  planFixedLauncherClearance,
  type FixedLauncherPlan,
} from '../outline-assembly/launcher';
import { LauncherExteriorExpansionExceededError } from '../outline-assembly/launcher-exterior-expansion';
import { validateLauncherFitOffsetMm } from '../outline-assembly/launcher-fit';
import {
  materializeFastenerHoles,
  planFastenerHoles,
  type FastenerPlan,
} from '../outline-assembly/fasteners';
import {
  createPhysicalCutProtection,
  finishedRemovalEnvelope,
} from '../outline-assembly/physical-cut-envelope';
import { createOutlineAxisBasis, projectMesh } from '../outline-2.5d/raster';
import type { ExactSegmentCollection, ExactSegmentSource } from '../outline-2.5d/segment-source';
import { scheduleOutlineLayers } from '../outline-2.5d/layer-schedule';
import {
  featureEvidenceFingerprint,
  validateAutomaticColoredResult,
  type ColoredOutlineLayer,
  type AutomaticOutlineAssembly,
  type DecorationOmission,
  type DecorationOmissionSourceEvidence,
  type OutlinePreviewPayload,
  type SharedCentralHoleLayerEvidence,
} from '../outline-features/types';
import {
  CENTRAL_HOLE_OMISSION_WARNING,
  type CentralHoleSelection,
} from '../outline-features/hole';
import {
  copyInternalLauncherDecorationEvidence,
  type InternalLauncherDecorationEvidence,
} from '../outline-features/launcher-decoration-evidence';
import {
  DEFAULT_OUTLINE_BUDGETS,
  type OutlineAxisSelection,
  type OutlineMode,
  type OutlineResultStatus,
} from '../outline-2.5d/types';
import type { GeometryLiveByteReporter } from '../../performance/geometry-memory';

export type AutomaticOutlineProgressStage = 'reading' | 'analyzing' | 'simplifying' | 'slicing' | 'packaging';
export type AutomaticOutlineProgressEvent =
  | { readonly stage: AutomaticOutlineProgressStage }
  | { readonly stage: 'analyzing' | 'slicing'; readonly preview: OutlinePreviewPayload };
export type AutomaticOutlineResult = {
  readonly sourceHash: string;
  /** Bounded material evidence required to verify the feature fingerprint during packaging. */
  readonly material?: ManufacturingGeometryProfile;
  readonly assembly: AutomaticOutlineAssembly;
  readonly mode: OutlineMode;
  readonly status: OutlineResultStatus;
  readonly axis: OutlineAxisSelection;
  readonly layers: readonly OutlineLayer[];
  /** Bounded pre-colorization evidence used to preserve the extracted shared central hole exactly. */
  readonly centralHoleSourceEvidence: readonly SharedCentralHoleLayerEvidence[];
  /** Bounded public evidence derived before colorization from protected-work depth omissions. */
  readonly decorationOmissionSourceEvidence: readonly DecorationOmissionSourceEvidence[];
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
  /** Internal-only evidence. Strip before any worker/public/package transfer. */
  readonly internalValidationEvidence?: {
    readonly launcherDecoration: InternalLauncherDecorationEvidence;
  };
};
export type PublicAutomaticOutlineResult = Omit<
  AutomaticOutlineResult,
  | 'centralHoleSourceEvidence'
  | 'decorationOmissionSourceEvidence'
  | 'internalValidationEvidence'
>;

export function stripAutomaticOutlineInternalEvidence(
  result: AutomaticOutlineResult,
): PublicAutomaticOutlineResult {
  const {
    centralHoleSourceEvidence: _centralHoleSourceEvidence,
    decorationOmissionSourceEvidence: _decorationOmissionSourceEvidence,
    internalValidationEvidence: _internalValidationEvidence,
    ...publicResult
  } = result;
  return publicResult;
}
export type AutomaticOutlineDiagnostics = {
  readonly topology: Readonly<Pick<MeshProblemReport['inspection'], 'triangleCount' | 'boundaryEdgeCount' | 'nonManifoldEdgeCount' | 'degenerateTriangleCount'>> & Readonly<Pick<MeshProblemReport, 'duplicateTriangleCount' | 'inconsistentWindingEdgeCount' | 'selfIntersectionCount' | 'selfIntersectionAnalysisComplete'>>;
  readonly repairDecision: 'accepted' | 'projected-original';
  readonly rasterCellSizeMm: number | null;
  readonly layers: readonly { readonly id: string; readonly simplificationToleranceMm: number; readonly boundsDriftRatio: number; readonly areaDriftRatio: number; readonly areaEvidenceBasis: 'exact-slice-pre-simplification' | 'retained-raster-pre-simplification' }[];
};
export type AutomaticOutlineRequest = {
  readonly bytes: ArrayBuffer;
  readonly material: ManufacturingGeometryProfile;
  readonly launcherFitOffsetMm: number;
};
export type AutomaticOutlineProgress = (event: AutomaticOutlineProgressEvent) => void | Promise<void>;
export type AutomaticOutlineExecutionOptions = Readonly<{
  exactSegmentSource?: ExactSegmentSource;
  observeLiveBytes?: GeometryLiveByteReporter;
}>;
export type AutomaticOutlineErrorCode =
  | 'INVALID_STL'
  | 'NO_OUTLINE'
  | 'RESOURCE_LIMIT'
  | 'TIME_LIMIT'
  | 'LAUNCHER_INCOMPATIBLE'
  | 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED';

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
const MAX_PREVIEW_VERTICES = MAX_PREVIEW_TRIANGLES * 3;

export const GEOMETRY_PREVIEW_LIMITS = Object.freeze({
  maxTriangles: MAX_PREVIEW_TRIANGLES,
  maxVertices: MAX_PREVIEW_VERTICES,
});

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

function copyCentralHoleSourceEvidence(
  holeSelections: OutlineExtraction['holeSelections'],
): readonly SharedCentralHoleLayerEvidence[] {
  return holeSelections.map((selection) => selection.hole ? {
    status: 'retained',
    contour: {
      outer: selection.hole.outer.map(([x, y]) => [x, y] as const),
      boundsMm: { ...selection.hole.boundsMm },
      areaMm2: selection.hole.areaMm2,
    },
    equivalentDiameterMm: selection.hole.equivalentDiameterMm,
    axisDistanceMm: selection.hole.axisDistanceMm,
  } : { status: 'omitted' });
}

function withResultEvidence(
  result: Omit<AutomaticOutlineResult, 'assembly' | 'centralHoleSourceEvidence' | 'decorationOmissionSourceEvidence' | 'coloredLayers' | 'featureWarnings' | 'featureEvidenceFingerprint' | 'preview' | 'removalEvidenceFingerprint' | 'internalValidationEvidence'>,
  previewMesh: TriangleMesh,
  deadline: number,
  extraction: Pick<OutlineExtraction, 'holeSelections' | 'depthFeatures' | 'blackCuts' | 'featureWarnings' | 'launcherDecorationOverlap' | 'launcherDecorationEvidence'>,
  material: ManufacturingGeometryProfile,
  assembly: Omit<AutomaticOutlineAssembly, 'topFeatures' | 'decorationOmissions'>,
): AutomaticOutlineResult {
  const decorationOmissionSourceEvidence = extraction.depthFeatures.flatMap(
    (feature, index): DecorationOmissionSourceEvidence[] => {
      if (feature.omissionCode !== 'PROTECTED_CUT_WORK_BUDGET') return [];
      const diagnostics = feature.diagnostics;
      if (!result.layers[index]
        || diagnostics.omissionCode !== 'PROTECTED_CUT_WORK_BUDGET'
        || feature.red.length !== 0
        || feature.blue.length !== 0
        || diagnostics.contrastMm !== 0
        || diagnostics.redThresholdMm !== 0
        || diagnostics.blueThresholdMm !== 0
        || diagnostics.retained.red !== 0
        || diagnostics.retained.blue !== 0
        || diagnostics.omitted.red !== 0
        || diagnostics.omitted.blue !== 0) {
        throw new RangeError('Protected-cut work source omission evidence must contain exact zero diagnostics');
      }
      return [{
        layerId: result.layers[index].id,
        omissionCode: 'PROTECTED_CUT_WORK_BUDGET',
        diagnostics: {
          contrastMm: 0,
          redThresholdMm: 0,
          blueThresholdMm: 0,
          retained: { red: 0, blue: 0 },
          omitted: { red: 0, blue: 0 },
        },
      }];
    },
  );
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
    centralHoleSourceEvidence: copyCentralHoleSourceEvidence(extraction.holeSelections),
    decorationOmissionSourceEvidence,
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
    const decorationOmissions = decorationOmissionSourceEvidence.map((source): DecorationOmission => {
      const coloredLayer = coloredLayers.find((layer) => layer.id === source.layerId);
      if (!coloredLayer
        || coloredLayer.deepFeatures.length !== 0
        || coloredLayer.lightFeatures.length !== 0
        || coloredLayer.diagnostics.depth.omissionCode !== 'PROTECTED_CUT_WORK_BUDGET') {
        throw new RangeError('Depth decoration omission evidence does not match canonical colored layers');
      }
      return {
        layerId: source.layerId,
        reason: 'protected-cut-work-budget',
        roles: ['DEEP_RED', 'LIGHT_BLUE'],
      };
    });
    const assemblyEvidence: AutomaticOutlineAssembly = {
      ...assembly,
      decorationOmissions,
      topFeatures: {
        retained: {
          red: coloredLayers.at(-1)?.deepFeatures.length ?? 0,
          blue: coloredLayers.at(-1)?.lightFeatures.length ?? 0,
        },
        omitted: coloredLayers.at(-1)?.diagnostics.depth.omitted ?? { red: 0, blue: 0 },
        launcherOverlap: extraction.launcherDecorationOverlap,
      },
    };
    const completeEvidence = {
      ...coloredResult,
      material,
      assembly: assemblyEvidence,
      internalValidationEvidence: {
        launcherDecoration: copyInternalLauncherDecorationEvidence(extraction.launcherDecorationEvidence),
      },
    };
    const complete: AutomaticOutlineResult = {
      ...completeEvidence,
      removalEvidenceFingerprint: removalEvidenceFingerprint(result),
      featureEvidenceFingerprint: featureEvidenceFingerprint(completeEvidence, deadline, () => undefined, material),
    };
    validateAutomaticColoredResult(complete, deadline, () => undefined, material);
    return complete;
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
}

type PlannedAssembly = {
  readonly summary: Omit<AutomaticOutlineAssembly, 'topFeatures' | 'decorationOmissions'>;
  readonly cuts: OutlineExtraction['blackCuts'];
  readonly warnings: readonly string[];
  readonly holeSelections: readonly CentralHoleSelection[];
};

function materializeLauncherCuts(
  plan: FixedLauncherPlan,
  layers: readonly ColoredOutlineLayer[],
): readonly (readonly import('../outline-features/types').FeatureContour[])[] {
  return layers.map((layer, index) => index < layers.length - 2
    ? []
    : plan.cuts.map((cut, cutIndex) => ({
      ...cut,
      id: `${layer.id}-launcher-clearance-${cutIndex + 1}`,
    })));
}

type FixedLauncherPlanningContext = OutlineBlackCutPlanningContext & {
  readonly launcherFitOffsetMm: number;
};

function isUnsafeOptionalHoleEnvelope(error: unknown): boolean {
  if (!(error instanceof RangeError)) return false;
  return /Offset collapsed or self-intersected the polygon|Offset cannot resolve a folded or numerically unstable polygon vertex|Offset miter exceeds the bounded geometry limit|Physical cut toolpath must produce one finite simple removal envelope/.test(error.message);
}

function materialAwareHoleSelections(
  selections: readonly CentralHoleSelection[],
  material: ManufacturingGeometryProfile,
  deadline: number,
  checkpoint: (label?: string) => void,
): readonly CentralHoleSelection[] {
  const selected = selections.find((selection) => selection.hole !== undefined);
  if (!selected?.hole) return selections;
  try {
    finishedRemovalEnvelope(selected.hole.outer, material.kerfMm, deadline, checkpoint);
    return selections;
  } catch (error) {
    if (!isUnsafeOptionalHoleEnvelope(error)) throw error;
    return selections.map(() => ({
      hole: undefined,
      omissionReason: 'NO_RELIABLE_CENTRAL_HOLE' as const,
      warning: CENTRAL_HOLE_OMISSION_WARNING,
    }));
  }
}

function planAssemblyBlackCuts(
  context: FixedLauncherPlanningContext,
  material: ManufacturingGeometryProfile,
): PlannedAssembly {
  const checkpoint = () => checkEvidenceDeadline(context.deadline);
  const holeSelections = materialAwareHoleSelections(
    context.holeSelections, material, context.deadline, checkpoint,
  );
  const bareLayers = colorizeExteriorLayers(
    context.layers, context.cellSizeMm, context.deadline, checkpoint, holeSelections,
  );
  const top = bareLayers.at(-1), second = bareLayers.at(-2);
  if (!top || !second) throw new RangeError('Assembly planning requires at least two ordered layers');
  const launcher = planFixedLauncherClearance({
    axisPoint: [0, 0],
    topExterior: top.exterior,
    secondExterior: second.exterior,
    topCentralHole: top.centralHole,
    secondCentralHole: second.centralHole,
    material,
    fitOffsetMm: context.launcherFitOffsetMm,
    decorationContours: context.decorationContours,
    deadline: context.deadline,
    checkpoint,
  });
  const expandedLayers = bareLayers.map((layer, index) => ({
    ...layer,
    exterior: index === bareLayers.length - 1
      ? launcher.expandedTopExterior
      : index === bareLayers.length - 2
        ? launcher.expandedSecondExterior
        : layer.exterior,
  }));
  const launcherByLayer = materializeLauncherCuts(launcher, expandedLayers);
  const fastenerPlan = planFastenerHoles({
    layers: expandedLayers.map((layer, index) => ({
      id: layer.id,
      exterior: layer.exterior,
      centralHole: layer.centralHole,
      launcherCuts: launcherByLayer[index],
    })),
    axisPoint: [0, 0],
    material,
    deadline: context.deadline,
    checkpoint,
  });
  const layersWithLauncher = expandedLayers.map((layer, index) => ({
    ...layer,
    launcherCuts: launcherByLayer[index],
  }));
  const fastenerByLayer = materializeFastenerHoles(
    fastenerPlan, layersWithLauncher, context.deadline, checkpoint,
  );
  const cuts = expandedLayers.map((layer, index) => ({
    launcherCuts: launcherByLayer[index],
    fastenerHoles: fastenerByLayer[index],
    ...(index >= expandedLayers.length - 2 ? { exteriorOverride: layer.exterior } : {}),
    engravingProtection: createPhysicalCutProtection({
      centralHole: layer.centralHole,
      launcherCuts: launcherByLayer[index],
      fastenerHoles: fastenerByLayer[index],
      material,
      deadline: context.deadline,
      checkpoint,
    }),
  }));
  const warnings = [
    ...(fastenerPlan.warning ? [fastenerPlan.warning] : []),
  ];
  return {
    cuts,
    warnings,
    holeSelections,
    summary: {
      material,
      launcher: {
        status: 'fixed',
        cutCount: 3,
        templateVersion: launcher.templateVersion,
        templateFingerprint: launcher.templateFingerprint,
        rotationRad: launcher.rotationRad,
        fitOffsetMm: launcher.fitOffsetMm,
        finishedAllowanceMm: launcher.finishedAllowanceMm,
        exteriorExpansion: {
          ...launcher.exteriorExpansion,
          affectedLayerIds: [second.id, top.id],
        },
      },
      fastener: fastenerSummary(fastenerPlan),
    },
  };
}

function fastenerSummary(plan: FastenerPlan): AutomaticOutlineAssembly['fastener'] {
  return {
    count: plan.count,
    centers: plan.centers.map(([x, y]) => [x, y] as const),
    finishedDiameterMm: plan.finishedDiameterMm,
    pathDiameterMm: plan.pathDiameterMm,
    ...(plan.radiusMm === undefined ? {} : { radiusMm: plan.radiusMm }),
    ...(plan.rotationRad === undefined ? {} : { rotationRad: plan.rotationRad }),
  };
}

function extractionOptions(
  material: ManufacturingGeometryProfile,
  launcherFitOffsetMm: number,
  receive: (assembly: PlannedAssembly) => void,
): { readonly planBlackCuts: (context: OutlineBlackCutPlanningContext) => {
  readonly cuts: OutlineExtraction['blackCuts'];
  readonly warnings: readonly string[];
  readonly holeSelections: readonly CentralHoleSelection[];
} } {
  return {
    planBlackCuts: (context) => {
      const assembly = planAssemblyBlackCuts({ ...context, launcherFitOffsetMm }, material);
      receive(assembly);
      return {
        cuts: assembly.cuts,
        warnings: assembly.warnings,
        holeSelections: assembly.holeSelections,
      };
    },
  };
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
  if (error instanceof LauncherExteriorExpansionExceededError) {
    return new AutomaticOutlineError(
      'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
      error.message,
      { cause: error },
    );
  }
  if (error instanceof LauncherCompatibilityError) {
    return new AutomaticOutlineError('LAUNCHER_INCOMPATIBLE', error.message, { cause: error });
  }
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
  execution: AutomaticOutlineExecutionOptions = {},
): Promise<AutomaticOutlineResult> {
  const material = validateManufacturingGeometryProfile(request.material);
  const launcherFitOffsetMm = validateLauncherFitOffsetMm(request.launcherFitOffsetMm);
  if (request.bytes.byteLength > MAX_STL_BYTES) {
    throw new AutomaticOutlineError('RESOURCE_LIMIT', '模型超出安全處理資源上限');
  }
  const deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs;
  const observeLiveBytes = execution.observeLiveBytes;
  observeLiveBytes?.('pipeline:input', [{ owner: 'worker-stl', buffers: [request.bytes] }]);
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
  observeLiveBytes?.('pipeline:parsed', [{
    owner: 'parsed-mesh',
    buffers: [originalMesh.positions, originalMesh.indices],
  }]);

  const provisionalBasis = createOutlineAxisBasis({ origin: [0, 0, 0], direction: [0, 0, 1] });
  let analyzingPreviewMesh: OutlinePreviewPayload['mesh'];
  let analyzingOrigin: readonly [number, number, number];
  try {
    analyzingPreviewMesh = copyPreviewMesh(originalMesh, deadline);
    analyzingOrigin = meshBoundsCenter(originalMesh, deadline);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'TIME_LIMIT');
  }
  observeLiveBytes?.('pipeline:analyzing-preview', [{
    owner: 'analyzing-preview',
    buffers: [analyzingPreviewMesh.positions, analyzingPreviewMesh.indices],
  }]);
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
  observeLiveBytes?.('pipeline:repair-ready', [{
    owner: 'safe-repair-mesh',
    buffers: [safeRepair.mesh.positions, safeRepair.mesh.indices],
  }]);

  await emit({ stage: 'simplifying' });
  const extractionMesh = safeRepair.accepted ? safeRepair.mesh : originalMesh;
  observeLiveBytes?.('pipeline:extraction-mesh', [
    { owner: safeRepair.accepted ? 'safe-repair-mesh' : 'parsed-mesh', buffers: [] },
    { owner: 'extraction-mesh', buffers: [extractionMesh.positions, extractionMesh.indices] },
  ]);
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
    let exactAssembly: PlannedAssembly | undefined;
    let suppliedSegments: ExactSegmentCollection | undefined;
    try {
      const suppliedProjection = execution.exactSegmentSource
        ? projectMesh(extractionMesh, axis, deadline, () => checkEvidenceDeadline(deadline))
        : undefined;
      suppliedSegments = suppliedProjection
        ? await execution.exactSegmentSource!.collect(
          suppliedProjection, specs, deadline, () => checkEvidenceDeadline(deadline),
        ) : undefined;
      exactExtraction = extractExactContours(
        extractionMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline,
        extractionOptions(material, launcherFitOffsetMm, (assembly) => { exactAssembly = assembly; }),
        suppliedSegments,
        suppliedProjection,
      );
    } catch (exactError) {
      const mappedExactError = asAutomaticOutlineError(exactError, 'NO_OUTLINE');
      if (mappedExactError.code !== 'NO_OUTLINE'
        || !(exactError instanceof ExactContourAmbiguityError)
        || suppliedSegments?.origin === 'wasm') {
        throw mappedExactError;
      }
      let projectedExtraction: ReturnType<typeof extractProjectedContours>;
      let projectedAssembly: PlannedAssembly | undefined;
      try {
        projectedExtraction = extractProjectedContours(
          extractionMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline,
          extractionOptions(material, launcherFitOffsetMm, (assembly) => { projectedAssembly = assembly; }),
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
      }, extractionMesh, deadline, projectedExtraction, material, projectedAssembly!.summary);
      await emit({ stage: 'slicing', preview: clonePreviewPayload(result.preview) });
      await emit({ stage: 'packaging' });
      observeLiveBytes?.('pipeline:result-retained', [
        { owner: 'worker-stl', buffers: [] },
        { owner: 'parsed-mesh', buffers: [] },
        { owner: 'safe-repair-mesh', buffers: [] },
        { owner: 'extraction-mesh', buffers: [] },
        { owner: 'analyzing-preview', buffers: [] },
        { owner: 'result-preview', buffers: [result.preview.mesh.positions, result.preview.mesh.indices] },
      ]);
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
    }, extractionMesh, deadline, exactExtraction, material, exactAssembly!.summary);
    await emit({ stage: 'slicing', preview: clonePreviewPayload(result.preview) });
    await emit({ stage: 'packaging' });
    observeLiveBytes?.('pipeline:result-retained', [
      { owner: 'worker-stl', buffers: [] },
      { owner: 'parsed-mesh', buffers: [] },
      { owner: 'safe-repair-mesh', buffers: [] },
      { owner: 'extraction-mesh', buffers: [] },
      { owner: 'analyzing-preview', buffers: [] },
      { owner: 'result-preview', buffers: [result.preview.mesh.positions, result.preview.mesh.indices] },
    ]);
    return result;
  }

  let projectedExtraction: ReturnType<typeof extractProjectedContours>;
  let projectedAssembly: PlannedAssembly | undefined;
  try {
    projectedExtraction = extractProjectedContours(
      originalMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline,
      extractionOptions(material, launcherFitOffsetMm, (assembly) => { projectedAssembly = assembly; }),
    );
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
  }, originalMesh, deadline, projectedExtraction, material, projectedAssembly!.summary);
  await emit({ stage: 'slicing', preview: clonePreviewPayload(result.preview) });
  await emit({ stage: 'packaging' });
  observeLiveBytes?.('pipeline:result-retained', [
    { owner: 'worker-stl', buffers: [] },
    { owner: 'parsed-mesh', buffers: [] },
    { owner: 'safe-repair-mesh', buffers: [] },
    { owner: 'extraction-mesh', buffers: [] },
    { owner: 'analyzing-preview', buffers: [] },
    { owner: 'result-preview', buffers: [result.preview.mesh.positions, result.preview.mesh.indices] },
  ]);
  return result;
}
