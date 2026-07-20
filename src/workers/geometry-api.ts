import type { AxisCandidate } from '../domain/axis/find-axis';
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

export type SerializedMesh = TriangleMesh;

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
    onProgress?: AutomaticOutlineProgress,
  ): Promise<AutomaticOutlineResult>;
  inspectAndFindAxes(input: ArrayBuffer): Promise<ImportAnalysis>;
  analyzeAndRepairForImport(input: ArrayBuffer): Promise<ImportRepairAnalysis>;
  repairAdvanced(original: SerializedMesh, safeMesh: SerializedMesh): Promise<MeshRepairResult>;
  serializeSTL(mesh: SerializedMesh, mode: STLRepairMode): Promise<ArrayBuffer>;
  findAxes(mesh: SerializedMesh): Promise<AxisCandidate[]>;
  decompose(request: DecompositionRequest): Promise<SpinnerKit>;
  engrave(request: EngravingRequest): Promise<EngravingMap>;
};
