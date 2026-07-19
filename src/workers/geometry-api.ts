import type { AxisCandidate } from '../domain/axis/find-axis';
import type { DecompositionOptions, LathedProfile, MaterialInput, SpinnerKit } from '../domain/decomposition/types';
import type { EngravingLevelCount, EngravingMap, HeightField } from '../domain/engraving/height-field';
import type { QuantizeOptions } from '../domain/engraving/quantize';
import type { MeshInspection, TriangleMesh } from '../domain/mesh/types';

export type SerializedMesh = TriangleMesh;

export type MeshAnalysis = {
  readonly sourceHash: string;
  readonly mesh: SerializedMesh;
  readonly inspection: MeshInspection;
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
  findAxes(mesh: SerializedMesh): Promise<AxisCandidate[]>;
  decompose(request: DecompositionRequest): Promise<SpinnerKit>;
  engrave(request: EngravingRequest): Promise<EngravingMap>;
};
