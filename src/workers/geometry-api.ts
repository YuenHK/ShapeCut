import type { AxisCandidate } from '../domain/axis/find-axis';
export type { ManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import type { DecompositionOptions, LathedProfile, MaterialInput, SpinnerKit } from '../domain/decomposition/types';
import type { EngravingLevelCount, EngravingMap, HeightField } from '../domain/engraving/height-field';
import type { QuantizeOptions } from '../domain/engraving/quantize';
import type {
  AutomaticOutlineProgress,
  AutomaticOutlineRequest,
  AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import type { MeshInspection, TriangleMesh } from '../domain/mesh/types';
import type { MeshProblemReport, MeshRepairResult } from '../domain/mesh/types';
import type { STLRepairMode } from '../domain/mesh/write-stl';

export const OUTLINE_ARTIFACT_IDS = Object.freeze([
  'colored-outline-document',
  'cut-and-engrave.svg',
  'cut-and-engrave.dxf',
  'preview.pdf',
  'exploded-view.pdf',
  'shapecut-files.zip',
  'package-verification',
] as const);

export type OutlineArtifactId = typeof OUTLINE_ARTIFACT_IDS[number];

export function outlineArtifactFailureMessage(artifact: OutlineArtifactId): string {
  return `Outline artifact ${artifact} could not be created.`;
}

export class OutlineArtifactError extends Error {
  readonly name = 'OutlineArtifactError';
  readonly code = 'ARTIFACT_FAILURE';

  constructor(readonly artifact: OutlineArtifactId, options?: ErrorOptions) {
    if (!(OUTLINE_ARTIFACT_IDS as readonly string[]).includes(artifact)) {
      throw new RangeError('Outline artifact identity is outside the bounded public contract');
    }
    super(outlineArtifactFailureMessage(artifact), options);
  }
}

export type SerializedMesh = TriangleMesh;
export type AutomaticOutlineProgressTransport = AutomaticOutlineProgress | MessagePort;
export type OutlinePackageTransfer = {
  readonly zip: Uint8Array;
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly explodedViewPdf: Uint8Array;
};

export type MeshAnalysis = {
  readonly sourceHash: string;
  readonly mesh: SerializedMesh;
  readonly previewMesh: SerializedMesh;
  readonly inspection: MeshInspection;
};
export type ImportAnalysis = Omit<MeshAnalysis, 'mesh'> & { readonly candidates: readonly AxisCandidate[] };

export type ImportRepairAnalysis = {
  readonly sourceHash: string;
  readonly originalMesh: SerializedMesh;
  readonly originalPreview: SerializedMesh;
  readonly originalReport: MeshProblemReport;
  readonly safeRepair: MeshRepairResult;
  readonly candidates: readonly AxisCandidate[];
};

export type DecompositionRequest = {
  readonly profile: LathedProfile;
  readonly material: MaterialInput;
  readonly options: DecompositionOptions;
};

export type EngravingRequest = {
  readonly field: HeightField;
  readonly levels: EngravingLevelCount;
  readonly options?: QuantizeOptions;
};

/** Structured-clone-safe boundary for all CPU-heavy geometry operations. */
export type GeometryApi = {
  inspect(input: ArrayBuffer): Promise<MeshAnalysis>;
  convertAutomatically(
    request: AutomaticOutlineRequest,
    onProgress?: AutomaticOutlineProgressTransport,
  ): Promise<AutomaticOutlineResult>;
  packageOutline(result: AutomaticOutlineResult, deadline?: number): Promise<OutlinePackageTransfer>;
  inspectAndFindAxes(input: ArrayBuffer): Promise<ImportAnalysis>;
  analyzeAndRepairForImport(input: ArrayBuffer): Promise<ImportRepairAnalysis>;
  repairAdvanced(original: SerializedMesh, safeMesh: SerializedMesh): Promise<MeshRepairResult>;
  serializeSTL(mesh: SerializedMesh, mode: STLRepairMode): Promise<ArrayBuffer>;
  findAxes(mesh: SerializedMesh): Promise<AxisCandidate[]>;
  decompose(request: DecompositionRequest): Promise<SpinnerKit>;
  engrave(request: EngravingRequest): Promise<EngravingMap>;
};
