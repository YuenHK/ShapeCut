export type Point2 = readonly [number, number];

/** Simple closed polygon. The first point is not repeated. */
export type Polygon2 = { readonly points: readonly Point2[] };

export type PartKind = 'hub-layer' | 'rib' | 'outer-ring' | 'spacer';
export type Fit = 'loose' | 'slip' | 'snug' | 'press';

export type HoleMetadata = {
  readonly purpose: 'shaft';
  readonly center: Point2;
  readonly radiusMm: number;
  readonly polygonIndex: number;
};

export type Part2D = {
  readonly id: string;
  readonly kind: PartKind;
  readonly outline: Polygon2;
  readonly holes: readonly Polygon2[];
  readonly quantity: number;
  readonly angleRad?: number;
  readonly holeMetadata?: readonly HoleMetadata[];
};

export type DecompositionOptions = {
  readonly ribCount: 4 | 6 | 8 | 10 | 12;
  readonly ringLayers: number;
  readonly shaftMm: number;
  readonly fit: Fit;
};

export type MaterialInput = {
  readonly thicknessMm: number;
  /** Applied to material thickness to obtain the physical slot width. */
  readonly fitAllowanceMm: number | Readonly<Record<Fit, number>>;
};

export type LathedProfile = {
  readonly samples: readonly { readonly z: number; readonly radius: number }[];
};

export type JointFeature = {
  readonly id: string;
  readonly partId: string;
  readonly role: 'slot' | 'tab';
  readonly widthMm: number;
  readonly depthMm: number;
  readonly position: Point2;
  readonly direction: Point2;
  readonly polygon: Polygon2;
  readonly matePartId: string;
};

export type AssemblyEdge = {
  readonly fromPartId: string;
  readonly toPartId: string;
  readonly jointId: string;
  readonly order: number;
  readonly instanceId?: 'negative-z' | 'positive-z';
};

/** Static ideal-symmetry estimate only; it is not a dynamic balance analysis. */
export type BalanceResult = {
  readonly kind: 'ideal-static-estimate';
  readonly status: 'pass' | 'fail';
  readonly centroidOffsetMm: number;
  readonly assumptions: readonly string[];
};

export type SpinnerKit = {
  readonly parts: readonly Part2D[];
  readonly joints: readonly JointFeature[];
  readonly assembly: readonly AssemblyEdge[];
  readonly estimatedBalance: BalanceResult;
};

export type DecompositionErrorCode = 'PROFILE' | 'MATERIAL' | 'OPTIONS' | 'SHAFT' | 'JOINT' | 'HASH_COLLISION';

export class DecompositionError extends Error {
  readonly name = 'DecompositionError';
  constructor(readonly code: DecompositionErrorCode, message: string) {
    super(message);
  }
}
