import type { Point2 } from '../decomposition/types';
import type { ManufacturingGeometryProfile } from '../materials/manufacturing-profile';
import type { OutlineLayer } from '../outline-2.5d/extract';
import { createOutlineAxisBasis } from '../outline-2.5d/raster';
import { contourBounds, signedArea as contourSignedArea, type Bounds2 } from '../outline-2.5d/simplify';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineMode } from '../outline-2.5d/types';
import { validateOutlineLayer } from '../outline-2.5d/validate';
import { validatePolygon } from '../engraving/geometry';
import type { Vec3 } from '../types';
import { CENTRAL_HOLE_OMISSION_WARNING, isStrictlyContainedLoop } from './hole';
import type { DepthFeatureOmissionCode } from './depth-field';
import { validateDepthFeatureContours } from './validate';

export type FeatureRole = 'CUT_BLACK' | 'DEEP_RED' | 'LIGHT_BLUE';
export type FeatureContour = {
  readonly id: string;
  readonly role: FeatureRole;
  readonly outer: readonly Point2[];
  readonly boundsMm: Bounds2;
  readonly areaMm2: number;
};
export type LayerFeatureDiagnostics = {
  readonly hole:
    | { readonly status: 'retained'; readonly equivalentDiameterMm: number; readonly axisDistanceMm: number }
    | { readonly status: 'omitted' };
  readonly depth: {
    readonly cellSizeMm: number;
    readonly contrastMm: number;
    readonly redThresholdMm: number;
    readonly blueThresholdMm: number;
    readonly retained?: { readonly red: number; readonly blue: number };
    readonly omitted?: { readonly red: number; readonly blue: number };
    readonly omissionCode?: DepthFeatureOmissionCode;
  };
};
export type ColoredOutlineLayer = {
  readonly id: string;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly exterior: FeatureContour;
  readonly centralHole?: FeatureContour;
  readonly launcherCuts: readonly FeatureContour[];
  readonly fastenerHoles: readonly FeatureContour[];
  readonly deepFeatures: readonly FeatureContour[];
  readonly lightFeatures: readonly FeatureContour[];
  readonly removedComponentCount: number;
  readonly diagnostics: LayerFeatureDiagnostics;
};
export type OutlinePreviewAxis = {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly planeX: Vec3;
  readonly planeY: Vec3;
};
export type OutlinePreviewPayload = {
  readonly mesh: { readonly positions: Float32Array; readonly indices: Uint32Array };
  readonly axis: OutlinePreviewAxis;
  readonly layers: readonly ColoredOutlineLayer[];
};

export type AutomaticOutlineAssembly = {
  readonly material: ManufacturingGeometryProfile;
  readonly launcher:
    | { readonly status: 'detected' | 'fallback'; readonly cutCount: 3; readonly assemblyAllowanceMm: 0.2 }
    | { readonly status: 'omitted'; readonly cutCount: 0 };
  readonly fastener: {
    readonly count: 0 | 1 | 2 | 3;
    readonly centers: readonly Point2[];
    readonly finishedDiameterMm: 3;
    readonly pathDiameterMm: number;
    readonly radiusMm?: number;
    readonly rotationRad?: number;
  };
  readonly topFeatures: {
    readonly retained: { readonly red: number; readonly blue: number };
    readonly omitted: { readonly red: number; readonly blue: number };
  };
};

export type ColoredLayerValidation = { readonly ok: boolean; readonly reasons: readonly string[] };
type FeatureFingerprintSource = {
  readonly sourceHash: string;
  readonly material?: ManufacturingGeometryProfile;
  readonly assembly?: AutomaticOutlineAssembly;
  readonly mode: OutlineMode;
  readonly coloredLayers: readonly ColoredOutlineLayer[];
  readonly preview: { readonly axis: OutlinePreviewAxis };
};
type UnknownRecord = Record<string, unknown>;
type ValidationBudget = {
  readonly deadline: number;
  readonly checkpoint: () => void;
};

const FEATURE_ROLES = new Set<FeatureRole>(['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE']);
const DEPTH_OMISSION_CODES = new Set<DepthFeatureOmissionCode>([
  'INSUFFICIENT_CONTRAST', 'INSUFFICIENT_DEPTH_DATA', 'UNRELIABLE_DEPTH_GEOMETRY',
]);
const DEPTH_OMISSION_WARNINGS: Readonly<Record<DepthFeatureOmissionCode, string>> = Object.freeze({
  INSUFFICIENT_CONTRAST: '表面深度差不足，已省略雕刻特徵',
  INSUFFICIENT_DEPTH_DATA: '表面深度資料不足，已省略雕刻特徵',
  UNRELIABLE_DEPTH_GEOMETRY: '雕刻特徵不可靠，已局部省略',
});
const LAYER_KEYS = new Set([
  'id', 'index', 'zStart', 'zEnd', 'exterior', 'centralHole',
  'launcherCuts', 'fastenerHoles', 'deepFeatures', 'lightFeatures',
  'removedComponentCount', 'diagnostics',
]);
const CONTOUR_KEYS = new Set(['id', 'role', 'outer', 'boundsMm', 'areaMm2']);
const RUNTIME_REASON = 'Colored feature validation exceeded the runtime budget';
const DEFAULT_VALIDATION_RUNTIME_MS = 30_000;
const MAX_SHARED_HOLE_POINT_COUNT = 4096;
const MAX_ENGRAVING_FEATURES = 12;
const MAX_BLACK_FEATURES = 3;

/** Explicit structured-clone/import boundary for pre-array colored geometry. */
export function migrateColoredOutlineLayer(value: unknown): ColoredOutlineLayer {
  if (!isRecord(value)) throw new RangeError('Legacy colored layer must be an object');
  const hasLegacyDeep = Object.hasOwn(value, 'deepFeature');
  const hasLegacyLight = Object.hasOwn(value, 'lightFeature');
  const hasLegacyEngraving = hasLegacyDeep || hasLegacyLight;
  const hasCanonicalEngraving = Object.hasOwn(value, 'deepFeatures') || Object.hasOwn(value, 'lightFeatures');
  if (hasLegacyEngraving && hasCanonicalEngraving) {
    throw new RangeError('Legacy and canonical colored feature fields must not be mixed');
  }
  for (const key of ['launcherCuts', 'fastenerHoles', 'deepFeatures', 'lightFeatures'] as const) {
    if (Object.hasOwn(value, key) && !Array.isArray(value[key])) {
      throw new RangeError(`Canonical ${key} must be an array when present`);
    }
  }
  const { deepFeature, lightFeature, ...withoutLegacy } = value;
  return {
    ...withoutLegacy,
    launcherCuts: Array.isArray(withoutLegacy.launcherCuts) ? withoutLegacy.launcherCuts : [],
    fastenerHoles: Array.isArray(withoutLegacy.fastenerHoles) ? withoutLegacy.fastenerHoles : [],
    deepFeatures: hasLegacyDeep ? deepFeature === undefined ? [] : [deepFeature]
      : Array.isArray(withoutLegacy.deepFeatures) ? withoutLegacy.deepFeatures : [],
    lightFeatures: hasLegacyLight ? lightFeature === undefined ? [] : [lightFeature]
      : Array.isArray(withoutLegacy.lightFeatures) ? withoutLegacy.lightFeatures : [],
  } as unknown as ColoredOutlineLayer;
}

function validLayerCount(count: number): boolean {
  return count >= DEFAULT_OUTLINE_BUDGETS.minLayers && count <= DEFAULT_OUTLINE_BUDGETS.maxLayers;
}

function checkRuntimeBudget(deadline: number, checkpoint: (label?: string) => void, label?: string): void {
  checkpoint(label);
  if (Date.now() > deadline) throw new RangeError(RUNTIME_REASON);
}

export type SharedCentralHoleLayerEvidence = {
  readonly status: 'retained' | 'omitted';
  readonly contour?: Pick<FeatureContour, 'outer' | 'boundsMm' | 'areaMm2'>;
  readonly equivalentDiameterMm?: number;
  readonly axisDistanceMm?: number;
};

function sharedHoleGeometryMatches(
  reference: SharedCentralHoleLayerEvidence,
  candidate: SharedCentralHoleLayerEvidence,
  deadline: number,
  checkpoint: (label?: string) => void,
): boolean {
  const left = reference.contour!, right = candidate.contour!;
  if (left.outer.length !== right.outer.length
    || left.areaMm2 !== right.areaMm2
    || left.boundsMm.minX !== right.boundsMm.minX
    || left.boundsMm.minY !== right.boundsMm.minY
    || left.boundsMm.maxX !== right.boundsMm.maxX
    || left.boundsMm.maxY !== right.boundsMm.maxY
    || reference.equivalentDiameterMm !== candidate.equivalentDiameterMm
    || reference.axisDistanceMm !== candidate.axisDistanceMm) return false;
  for (let index = 0; index < left.outer.length; index += 1) {
    if ((index & 63) === 0) checkRuntimeBudget(deadline, checkpoint);
    if (left.outer[index][0] !== right.outer[index][0]
      || left.outer[index][1] !== right.outer[index][1]) return false;
  }
  return true;
}

export function validateSharedCentralHoleDecision(
  layers: readonly SharedCentralHoleLayerEvidence[],
  featureWarnings: readonly string[],
  deadline = Date.now() + DEFAULT_VALIDATION_RUNTIME_MS,
  checkpoint: () => void = () => undefined,
  context = 'Shared central hole',
): void {
  checkRuntimeBudget(deadline, checkpoint);
  if (!validLayerCount(layers.length)) {
    throw new RangeError(`${context} evidence requires 6 to 24 ordered layers`);
  }
  const retained: SharedCentralHoleLayerEvidence[] = [];
  for (const layer of layers) {
    checkRuntimeBudget(deadline, checkpoint);
    const hasContour = layer.contour !== undefined;
    if ((layer.status === 'retained') !== hasContour) {
      throw new RangeError(`${context} status must match its contour evidence`);
    }
    if (!hasContour) continue;
    const contour = layer.contour!;
    if (!Array.isArray(contour.outer)
      || contour.outer.length < 3
      || contour.outer.length > MAX_SHARED_HOLE_POINT_COUNT
      || !Number.isFinite(contour.areaMm2)
      || contour.areaMm2 <= 0
      || ![contour.boundsMm.minX, contour.boundsMm.minY, contour.boundsMm.maxX, contour.boundsMm.maxY].every(Number.isFinite)) {
      throw new RangeError(`${context} evidence exceeds the bounded point geometry contract`);
    }
    for (let index = 0; index < contour.outer.length; index += 1) {
      if ((index & 63) === 0) checkRuntimeBudget(deadline, checkpoint);
      const point = contour.outer[index];
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
        throw new RangeError(`${context} evidence exceeds the bounded point geometry contract`);
      }
    }
    retained.push(layer);
  }
  if (retained.length !== 0 && retained.length !== layers.length) {
    throw new RangeError(`${context} decision must retain every layer or omit every layer`);
  }
  const omissionWarningCount = featureWarnings.reduce((count, warning) => {
    checkRuntimeBudget(deadline, checkpoint);
    return count + Number(warning === CENTRAL_HOLE_OMISSION_WARNING);
  }, 0);
  if ((retained.length === 0 && omissionWarningCount !== 1)
    || (retained.length !== 0 && omissionWarningCount !== 0)) {
    throw new RangeError(`${context} omission warning provenance must exactly match the all-layer decision`);
  }
  if (retained.length === 0) return;
  const reference = retained[0];
  for (let index = 1; index < retained.length; index += 1) {
    checkRuntimeBudget(deadline, checkpoint);
    if (!sharedHoleGeometryMatches(reference, retained[index], deadline, checkpoint)) {
      throw new RangeError(`${context}s must be geometrically identical in model space`);
    }
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unexpectedKeys(value: UnknownRecord, permitted: ReadonlySet<string>, label: string): string[] {
  return Object.keys(value)
    .filter((key) => !permitted.has(key))
    .map((key) => `${label} has unexpected enumerable field ${key}`);
}

function finiteTuple(value: unknown, length: number): value is readonly number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function isFloat32Array(value: unknown): value is Float32Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Float32Array]';
}

function isUint32Array(value: unknown): value is Uint32Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint32Array]';
}

function hasRuntimeBudget(budget: ValidationBudget): boolean {
  budget.checkpoint();
  return Date.now() <= budget.deadline;
}

function signedArea(points: readonly (readonly number[])[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return twiceArea / 2;
}

function cross(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(
  a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[],
  areaTolerance: number, lengthTolerance: number,
): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const onSegment = (p: readonly number[], q: readonly number[], r: readonly number[]) => Math.abs(cross(p, q, r)) <= areaTolerance
    && r[0] >= Math.min(p[0], q[0]) - lengthTolerance && r[0] <= Math.max(p[0], q[0]) + lengthTolerance
    && r[1] >= Math.min(p[1], q[1]) - lengthTolerance && r[1] <= Math.max(p[1], q[1]) + lengthTolerance;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function contourReasons(
  value: unknown,
  expectedRole: FeatureRole,
  label: string,
  budget: ValidationBudget,
): string[] {
  if (!hasRuntimeBudget(budget)) return [RUNTIME_REASON];
  if (!isRecord(value)) return [`${label} must be a feature contour`];
  const reasons = unexpectedKeys(value, CONTOUR_KEYS, label);
  if (typeof value.id !== 'string' || value.id.trim().length === 0) reasons.push(`${label} ID must be non-empty`);
  if (!FEATURE_ROLES.has(value.role as FeatureRole)) reasons.push(`${label} role is invalid`);
  if (value.role !== expectedRole) reasons.push(`${label} role must be ${expectedRole}`);

  if (!Array.isArray(value.outer)) {
    reasons.push(`${label} outer contour must be an array`);
    return reasons;
  }
  if (value.outer.length < 3 || value.outer.length > 4096) {
    reasons.push(`${label} outer contour requires 3 to 4096 points`);
  }
  const points = value.outer;
  let finite = true, adjacentDuplicate = false;
  const unique = new Set<string>();
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0 && !hasRuntimeBudget(budget)) return [...reasons, RUNTIME_REASON];
    const point = points[index];
    if (!finiteTuple(point, 2)) {
      finite = false;
      continue;
    }
    unique.add(`${point[0]}:${point[1]}`);
    const next = points[(index + 1) % points.length];
    if (finiteTuple(next, 2) && point[0] === next[0] && point[1] === next[1]) adjacentDuplicate = true;
  }
  if (!finite) reasons.push(`${label} coordinates must be finite point pairs`);
  if (unique.size < 3) reasons.push(`${label} requires at least three unique points`);
  if (adjacentDuplicate) reasons.push(`${label} has a zero-length edge`);

  let geometricArea = NaN;
  if (finite && points.length >= 3) {
    geometricArea = Math.abs(signedArea(points as readonly (readonly number[])[]));
    if (!Number.isFinite(geometricArea) || geometricArea <= 0) reasons.push(`${label} must have positive geometric area`);
    if (points.length <= 4096 && !adjacentDuplicate) {
      let scale = 1;
      for (const point of points as readonly (readonly number[])[]) scale = Math.max(scale, Math.abs(point[0]), Math.abs(point[1]));
      const areaTolerance = scale * scale * 64 * Number.EPSILON;
      const lengthTolerance = scale * 64 * Number.EPSILON;
      let simple = true;
      for (let first = 0; first < points.length && simple; first += 1) {
        if ((first & 63) === 0 && !hasRuntimeBudget(budget)) return [...reasons, RUNTIME_REASON];
        const firstNext = (first + 1) % points.length;
        for (let second = first + 1; second < points.length; second += 1) {
          if ((second & 63) === 0 && !hasRuntimeBudget(budget)) return [...reasons, RUNTIME_REASON];
          const secondNext = (second + 1) % points.length;
          if (firstNext === second || secondNext === first) continue;
          if (segmentsIntersect(
            points[first] as readonly number[], points[firstNext] as readonly number[],
            points[second] as readonly number[], points[secondNext] as readonly number[],
            areaTolerance, lengthTolerance,
          )) {
            simple = false;
            break;
          }
        }
      }
      if (!simple) reasons.push(`${label} has a self-intersection`);
    }
  }

  if (!isRecord(value.boundsMm)) {
    reasons.push(`${label} bounds must be present`);
  } else {
    const bounds = value.boundsMm;
    reasons.push(...unexpectedKeys(bounds, new Set(['minX', 'minY', 'maxX', 'maxY']), `${label} bounds`));
    const values = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
    if (!values.every(Number.isFinite) || (bounds.maxX as number) <= (bounds.minX as number)
      || (bounds.maxY as number) <= (bounds.minY as number)) {
      reasons.push(`${label} bounds must be finite and positive`);
    } else if (finite && points.length > 0) {
      const numericPoints = points as readonly (readonly number[])[];
      const actual = {
        minX: Math.min(...numericPoints.map((point) => point[0])),
        minY: Math.min(...numericPoints.map((point) => point[1])),
        maxX: Math.max(...numericPoints.map((point) => point[0])),
        maxY: Math.max(...numericPoints.map((point) => point[1])),
      };
      const tolerance = Math.max(1e-9, Math.max(...values.map((item) => Math.abs(item as number))) * 1e-9);
      if (Object.entries(actual).some(([key, item]) => Math.abs(item - (bounds[key] as number)) > tolerance)) {
        reasons.push(`${label} bounds metadata does not match its geometry`);
      }
    }
  }
  if (!Number.isFinite(value.areaMm2) || (value.areaMm2 as number) <= 0) {
    reasons.push(`${label} area must be finite and positive`);
  } else if (Number.isFinite(geometricArea)) {
    const tolerance = Math.max(1e-9, geometricArea * 1e-9);
    if (Math.abs((value.areaMm2 as number) - geometricArea) > tolerance) {
      reasons.push(`${label} area metadata does not match its geometry`);
    }
  }
  return reasons;
}

function diagnosticsReasons(value: unknown): string[] {
  if (!isRecord(value)) return ['Layer diagnostics must be present'];
  const reasons = unexpectedKeys(value, new Set(['hole', 'depth']), 'Layer diagnostics');
  if (!isRecord(value.hole)) {
    reasons.push('Hole diagnostics must be present');
  } else if (value.hole.status === 'retained') {
    reasons.push(...unexpectedKeys(value.hole, new Set(['status', 'equivalentDiameterMm', 'axisDistanceMm']), 'Hole diagnostics'));
    if (!Number.isFinite(value.hole.equivalentDiameterMm) || (value.hole.equivalentDiameterMm as number) <= 0
      || !Number.isFinite(value.hole.axisDistanceMm) || (value.hole.axisDistanceMm as number) < 0) {
      reasons.push('Retained hole diagnostics must contain finite positive diameter and non-negative axis distance');
    }
  } else if (value.hole.status === 'omitted') {
    reasons.push(...unexpectedKeys(value.hole, new Set(['status']), 'Hole diagnostics'));
  } else {
    reasons.push('Hole diagnostics status must be retained or omitted');
  }
  if (!isRecord(value.depth)) {
    reasons.push('Depth diagnostics must be present');
  } else {
    reasons.push(...unexpectedKeys(value.depth, new Set([
      'cellSizeMm', 'contrastMm', 'redThresholdMm', 'blueThresholdMm', 'retained', 'omitted', 'omissionCode',
    ]), 'Depth diagnostics'));
    const depth = value.depth;
    if (![depth.cellSizeMm, depth.contrastMm, depth.redThresholdMm, depth.blueThresholdMm].every(Number.isFinite)
      || (depth.cellSizeMm as number) < 0 || (depth.contrastMm as number) < 0
      || (depth.redThresholdMm as number) < 0 || (depth.blueThresholdMm as number) < 0
      || (depth.redThresholdMm as number) < (depth.blueThresholdMm as number)) {
      reasons.push('Depth diagnostics must be finite, non-negative, and ordered red over blue');
    }
    if (depth.omissionCode !== undefined && !DEPTH_OMISSION_CODES.has(depth.omissionCode as DepthFeatureOmissionCode)) {
      reasons.push('Depth diagnostics omission code is invalid');
    }
    for (const [label, counts] of [['retained', depth.retained], ['omitted', depth.omitted]] as const) {
      if (counts === undefined) continue;
      if (!isRecord(counts) || !Number.isSafeInteger(counts.red) || (counts.red as number) < 0
        || !Number.isSafeInteger(counts.blue) || (counts.blue as number) < 0) {
        reasons.push(`Depth diagnostics ${label} counts must be non-negative safe integers`);
      }
    }
  }
  return reasons;
}

function validateColoredLayerWithBudget(value: unknown, budget: ValidationBudget): ColoredLayerValidation {
  if (!hasRuntimeBudget(budget)) return { ok: false, reasons: [RUNTIME_REASON] };
  if (!isRecord(value)) return { ok: false, reasons: ['Colored layer must be an object'] };
  const reasons = unexpectedKeys(value, LAYER_KEYS, 'Colored layer');
  if (typeof value.id !== 'string' || value.id.trim().length === 0) reasons.push('Layer ID must be non-empty');
  if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) reasons.push('Layer index must be a non-negative safe integer');
  if (!Number.isFinite(value.zStart) || !Number.isFinite(value.zEnd) || (value.zEnd as number) <= (value.zStart as number)) {
    reasons.push('Layer Z interval must be finite and positive');
  }
  if (!Number.isSafeInteger(value.removedComponentCount) || (value.removedComponentCount as number) < 0) {
    reasons.push('Removed component count must be a non-negative safe integer');
  }
  const roles = [
    ['Exterior', value.exterior, 'CUT_BLACK'],
    ['Central hole', value.centralHole, 'CUT_BLACK'],
  ] as const;
  const ids = new Set<string>();
  let exteriorValid = false, centralHoleValid = false;
  for (const [label, feature, role] of roles) {
    if (feature === undefined && label !== 'Exterior') continue;
    const featureReasons = contourReasons(feature, role, label, budget);
    reasons.push(...featureReasons);
    if (label === 'Exterior') exteriorValid = featureReasons.length === 0;
    if (label === 'Central hole') centralHoleValid = featureReasons.length === 0;
    if (isRecord(feature) && typeof feature.id === 'string') {
      if (ids.has(feature.id)) reasons.push(`Duplicate feature ID ${feature.id}`);
      ids.add(feature.id);
    }
  }
  const arrays = [
    ['Launcher cut', value.launcherCuts, 'CUT_BLACK', MAX_BLACK_FEATURES],
    ['Fastener hole', value.fastenerHoles, 'CUT_BLACK', MAX_BLACK_FEATURES],
    ['Deep feature', value.deepFeatures, 'DEEP_RED', MAX_ENGRAVING_FEATURES],
    ['Light feature', value.lightFeatures, 'LIGHT_BLUE', MAX_ENGRAVING_FEATURES],
  ] as const;
  let deepFeaturesValid = false, lightFeaturesValid = false;
  for (const [label, features, role, maximum] of arrays) {
    if (!Array.isArray(features)) {
      reasons.push(`${label} array must be present`);
      continue;
    }
    if (features.length > maximum) reasons.push(`${label} array permits at most ${maximum} contours`);
    let valid = features.length <= maximum;
    for (const [index, feature] of features.entries()) {
      const featureReasons = contourReasons(feature, role, `${label} ${index + 1}`, budget);
      reasons.push(...featureReasons);
      valid = valid && featureReasons.length === 0;
      if (isRecord(feature) && typeof feature.id === 'string') {
        if (ids.has(feature.id)) reasons.push(`Duplicate feature ID ${feature.id}`);
        ids.add(feature.id);
      }
    }
    if (label === 'Deep feature') deepFeaturesValid = valid;
    if (label === 'Light feature') lightFeaturesValid = valid;
  }
  const diagnosticReasons = diagnosticsReasons(value.diagnostics);
  reasons.push(...diagnosticReasons);
  if (exteriorValid && centralHoleValid && diagnosticReasons.length === 0
    && isRecord(value.exterior) && Array.isArray(value.exterior.outer)
    && isRecord(value.centralHole) && Array.isArray(value.centralHole.outer)
    && isRecord(value.exterior.boundsMm) && isRecord(value.diagnostics)
    && isRecord(value.diagnostics.depth)) {
    const exteriorBounds = value.exterior.boundsMm;
    const planarDiameterMm = Math.hypot(
      (exteriorBounds.maxX as number) - (exteriorBounds.minX as number),
      (exteriorBounds.maxY as number) - (exteriorBounds.minY as number),
    );
    const minimumClearance = Math.max(
      value.diagnostics.depth.cellSizeMm as number,
      planarDiameterMm * 0.001,
    );
    try {
      if (!isStrictlyContainedLoop(
        value.exterior.outer as readonly Point2[],
        value.centralHole.outer as readonly Point2[],
        minimumClearance,
        budget.deadline,
        budget.checkpoint,
      )) reasons.push('Central hole must be strictly contained by the exterior with required clearance');
    } catch (error) {
      if (error instanceof RangeError && /runtime budget/i.test(error.message)) {
        return { ok: false, reasons: [...reasons, RUNTIME_REASON] };
      }
      reasons.push('Central hole containment could not be validated');
    }
  }
  if (exteriorValid && diagnosticReasons.length === 0
    && (Array.isArray(value.deepFeatures) && value.deepFeatures.length > 0
      || Array.isArray(value.lightFeatures) && value.lightFeatures.length > 0)
    && deepFeaturesValid
    && lightFeaturesValid
    && (value.centralHole === undefined || centralHoleValid)
    && isRecord(value.exterior) && Array.isArray(value.exterior.outer)
    && isRecord(value.diagnostics) && isRecord(value.diagnostics.depth)) {
    const exteriorBounds = value.exterior.boundsMm;
    if (isRecord(exteriorBounds)) {
      const planarDiameterMm = Math.hypot(
        (exteriorBounds.maxX as number) - (exteriorBounds.minX as number),
        (exteriorBounds.maxY as number) - (exteriorBounds.minY as number),
      );
      const clearanceMm = Math.max(value.diagnostics.depth.cellSizeMm as number, planarDiameterMm * 0.001);
      try {
        const validation = validateDepthFeatureContours({
          exterior: value.exterior.outer as readonly Point2[],
          centralHole: isRecord(value.centralHole) && Array.isArray(value.centralHole.outer)
            ? value.centralHole.outer as readonly Point2[]
            : undefined,
          red: value.deepFeatures as readonly FeatureContour[],
          blue: value.lightFeatures as readonly FeatureContour[],
          clearanceMm,
          deadline: budget.deadline,
          checkpoint: budget.checkpoint,
        });
        reasons.push(...validation.reasons);
      } catch (error) {
        if (error instanceof RangeError && /runtime budget/i.test(error.message)) {
          return { ok: false, reasons: [...reasons, RUNTIME_REASON] };
        }
        reasons.push('Depth feature relationships could not be validated');
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function validateColoredLayerShape(
  value: unknown,
  deadline = Date.now() + DEFAULT_VALIDATION_RUNTIME_MS,
  checkpoint: () => void = () => undefined,
): ColoredLayerValidation {
  return validateColoredLayerWithBudget(value, {
    deadline,
    checkpoint,
  });
}

function contourRecord(
  contourValue: FeatureContour | undefined,
  deadline: number,
  checkpoint: (label?: string) => void,
): unknown {
  if (contourValue === undefined) return null;
  const outer: number[][] = [];
  for (let index = 0; index < contourValue.outer.length; index += 1) {
    if ((index & 63) === 0) checkRuntimeBudget(deadline, checkpoint);
    const [x, y] = contourValue.outer[index];
    outer.push([x, y]);
  }
  checkRuntimeBudget(deadline, checkpoint);
  return {
    id: contourValue.id,
    role: contourValue.role,
    outer,
    boundsMm: {
      minX: contourValue.boundsMm.minX, minY: contourValue.boundsMm.minY,
      maxX: contourValue.boundsMm.maxX, maxY: contourValue.boundsMm.maxY,
    },
    areaMm2: contourValue.areaMm2,
  };
}

function contourRecords(
  contours: readonly FeatureContour[],
  deadline: number,
  checkpoint: () => void,
): readonly unknown[] {
  return contours.map((contour, index) => {
    if ((index & 63) === 0) checkRuntimeBudget(deadline, checkpoint);
    return contourRecord(contour, deadline, checkpoint);
  });
}

function orderedLayerRecords(
  layers: readonly ColoredOutlineLayer[],
  deadline: number,
  checkpoint: () => void,
): unknown {
  const records: unknown[] = [];
  for (let index = 0; index < layers.length; index += 1) {
    checkRuntimeBudget(deadline, checkpoint);
    const layer = layers[index];
    records.push({
      id: layer.id,
      index: layer.index,
      zStart: layer.zStart,
      zEnd: layer.zEnd,
      removedComponentCount: layer.removedComponentCount,
      roles: [
        ['exterior', contourRecord(layer.exterior, deadline, checkpoint)],
        ['centralHole', contourRecord(layer.centralHole, deadline, checkpoint)],
        ['launcherCuts', contourRecords(layer.launcherCuts, deadline, checkpoint)],
        ['fastenerHoles', contourRecords(layer.fastenerHoles, deadline, checkpoint)],
        ['deepFeatures', contourRecords(layer.deepFeatures, deadline, checkpoint)],
        ['lightFeatures', contourRecords(layer.lightFeatures, deadline, checkpoint)],
      ],
      diagnostics: {
        hole: layer.diagnostics.hole.status === 'retained'
          ? {
            status: 'retained',
            equivalentDiameterMm: layer.diagnostics.hole.equivalentDiameterMm,
            axisDistanceMm: layer.diagnostics.hole.axisDistanceMm,
          }
          : { status: 'omitted' },
        depth: {
          cellSizeMm: layer.diagnostics.depth.cellSizeMm,
          contrastMm: layer.diagnostics.depth.contrastMm,
          redThresholdMm: layer.diagnostics.depth.redThresholdMm,
          blueThresholdMm: layer.diagnostics.depth.blueThresholdMm,
          retained: layer.diagnostics.depth.retained,
          omitted: layer.diagnostics.depth.omitted,
          omissionCode: layer.diagnostics.depth.omissionCode,
        },
      },
    });
  }
  checkRuntimeBudget(deadline, checkpoint);
  return records;
}

function hashText(value: string, deadline: number, checkpoint: () => void): string {
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    checkRuntimeBudget(deadline, checkpoint);
    for (let index = 0; index < value.length; index += 1) {
      if ((index & 1023) === 0) checkRuntimeBudget(deadline, checkpoint);
      lanes[lane] = Math.imul(lanes[lane] ^ (value.charCodeAt(index) + lane * 131), 16777619 + lane * 2) >>> 0;
    }
  }
  const result = lanes.map((item) => item.toString(16).padStart(8, '0')).join('');
  checkRuntimeBudget(deadline, checkpoint);
  return result;
}

export function featureEvidenceFingerprint(
  result: FeatureFingerprintSource,
  deadline = Date.now() + DEFAULT_VALIDATION_RUNTIME_MS,
  checkpoint: () => void = () => undefined,
  material?: ManufacturingGeometryProfile,
): string {
  checkRuntimeBudget(deadline, checkpoint);
  const fingerprintMaterial = material ?? result.material;
  const serialized = JSON.stringify({
    sourceHash: result.sourceHash,
    ...(fingerprintMaterial ? { material: fingerprintMaterial } : {}),
    ...(result.assembly ? { assembly: result.assembly } : {}),
    mode: result.mode,
    previewAxis: result.preview.axis,
    layers: orderedLayerRecords(result.coloredLayers, deadline, checkpoint),
  });
  checkRuntimeBudget(deadline, checkpoint);
  return hashText(serialized, deadline, checkpoint);
}

function previewReasons(
  value: unknown,
  coloredLayers: readonly ColoredOutlineLayer[],
  coloredLayersValid: boolean,
  selectedAxis: { readonly origin: readonly number[]; readonly direction: readonly number[] } | undefined,
  validateLayer: (value: unknown) => ColoredLayerValidation,
  budget: ValidationBudget,
): string[] {
  checkRuntimeBudget(budget.deadline, budget.checkpoint);
  if (!isRecord(value)) return ['Preview must be present'];
  const reasons = unexpectedKeys(value, new Set(['mesh', 'axis', 'layers']), 'Preview');
  if (!isRecord(value.mesh)) {
    reasons.push('Preview mesh must be present');
  } else {
    reasons.push(...unexpectedKeys(value.mesh, new Set(['positions', 'indices']), 'Preview mesh'));
    checkRuntimeBudget(budget.deadline, budget.checkpoint);
    const positions = value.mesh.positions;
    checkRuntimeBudget(budget.deadline, budget.checkpoint);
    if (!isFloat32Array(positions)) {
      reasons.push('Preview mesh positions must be a Float32Array');
    } else {
      let positionsValid = positions.length >= 9 && positions.length % 3 === 0;
      for (let index = 0; index < positions.length && positionsValid; index += 1) {
        if ((index & 4095) === 0) checkRuntimeBudget(budget.deadline, budget.checkpoint);
        if (!Number.isFinite(positions[index])) positionsValid = false;
      }
      checkRuntimeBudget(budget.deadline, budget.checkpoint);
      if (!positionsValid) reasons.push('Preview mesh requires finite preview positions in XYZ triples');
    }
    checkRuntimeBudget(budget.deadline, budget.checkpoint);
    const indices = value.mesh.indices;
    checkRuntimeBudget(budget.deadline, budget.checkpoint);
    if (!isUint32Array(indices)) {
      reasons.push('Preview mesh indices must be a Uint32Array');
    } else {
      let indicesValid = indices.length >= 3 && indices.length % 3 === 0 && isFloat32Array(positions);
      const vertexCount = isFloat32Array(positions) ? positions.length / 3 : 0;
      for (let index = 0; index < indices.length && indicesValid; index += 1) {
        if ((index & 4095) === 0) checkRuntimeBudget(budget.deadline, budget.checkpoint);
        if (indices[index] >= vertexCount) indicesValid = false;
      }
      checkRuntimeBudget(budget.deadline, budget.checkpoint);
      if (!indicesValid) reasons.push('Preview mesh requires complete, in-range triangle indices');
    }
  }
  checkRuntimeBudget(budget.deadline, budget.checkpoint);
  if (!isRecord(value.axis)) {
    reasons.push('Preview axis must be present');
  } else {
    reasons.push(...unexpectedKeys(value.axis, new Set(['origin', 'direction', 'planeX', 'planeY']), 'Preview axis'));
    if (!finiteTuple(value.axis.origin, 3) || !finiteTuple(value.axis.direction, 3)
      || !finiteTuple(value.axis.planeX, 3) || !finiteTuple(value.axis.planeY, 3)) {
      reasons.push('Preview axis origin, direction, and basis must contain finite triples');
    } else if (Math.hypot(...value.axis.direction) === 0) {
      reasons.push('Preview axis direction must be non-zero');
    } else if (selectedAxis && (value.axis.origin.some((item, index) => item !== selectedAxis.origin[index])
      || value.axis.direction.some((item, index) => item !== selectedAxis.direction[index]))) {
      reasons.push('Preview axis must match the selected automatic axis');
    } else if (selectedAxis) {
      const expected = createOutlineAxisBasis({
        origin: selectedAxis.origin as Vec3,
        direction: selectedAxis.direction as Vec3,
      });
      const tolerance = 256 * Number.EPSILON;
      if (value.axis.planeX.some((item, index) => Math.abs(item - expected.planeX[index]) > tolerance)
        || value.axis.planeY.some((item, index) => Math.abs(item - expected.planeY[index]) > tolerance)) {
        reasons.push('Preview axis basis must match the deterministic extraction basis');
      }
    }
  }
  if (!Array.isArray(value.layers)) {
    reasons.push('Preview layers must be an array');
  } else {
    const previewLayers = value.layers as readonly ColoredOutlineLayer[];
    if (!validLayerCount(previewLayers.length)) {
      reasons.push('Preview layers must contain 6 to 24 ordered layer records');
    }
    const previewValid = validLayerCount(previewLayers.length)
      && previewLayers.every((layer) => {
        const validation = validateLayer(layer);
        reasons.push(...validation.reasons.map((reason) => `Preview ${reason}`));
        return validation.ok;
      });
    if (previewValid && coloredLayersValid) {
      const previewRecords = JSON.stringify(orderedLayerRecords(previewLayers, budget.deadline, budget.checkpoint));
      checkRuntimeBudget(budget.deadline, budget.checkpoint);
      const coloredRecords = JSON.stringify(orderedLayerRecords(coloredLayers, budget.deadline, budget.checkpoint));
      checkRuntimeBudget(budget.deadline, budget.checkpoint);
      if (previewRecords !== coloredRecords) {
        reasons.push('Preview layers must match the ordered colored layer records');
      }
    } else if (previewLayers.length !== coloredLayers.length) {
      reasons.push('Preview layers must match the ordered colored layer records');
    }
  }
  return reasons;
}

function isLegacyLayerCandidate(value: unknown): value is OutlineLayer {
  return isRecord(value) && isRecord(value.contour)
    && Array.isArray(value.contour.outer) && Array.isArray(value.contour.holes);
}

function samePoints(left: readonly Point2[], right: readonly Point2[]): boolean {
  return left.length === right.length
    && left.every(([x, y], index) => x === right[index][0] && y === right[index][1]);
}

const LAUNCHER_OMISSION_WARNING_TEXT = '無法安全保留原裝發射器相容性，已省略三個發射器開孔';
const FASTENER_OMISSION_WARNING_TEXT = '無法安全配置 3 mm 固定螺絲孔，已省略螺絲孔';

function nearlyEqual(left: number, right: number): boolean {
  // Geometry producers use deterministic IEEE-754 operations; 64 scaled ULPs
  // permits serialization noise without accepting manufacturing-scale drift.
  return Math.abs(left - right) <= Number.EPSILON * 64 * Math.max(1, Math.abs(left), Math.abs(right));
}

function sameContourGeometry(
  left: FeatureContour,
  right: FeatureContour,
  deadline: number,
  checkpoint: () => void,
): boolean {
  if (left.role !== right.role
    || left.areaMm2 !== right.areaMm2
    || JSON.stringify(left.boundsMm) !== JSON.stringify(right.boundsMm)
    || left.outer.length !== right.outer.length) return false;
  for (let index = 0; index < left.outer.length; index += 1) {
    if ((index & 63) === 0) checkRuntimeBudget(deadline, checkpoint);
    if (left.outer[index][0] !== right.outer[index][0]
      || left.outer[index][1] !== right.outer[index][1]) return false;
  }
  return true;
}

function validFastenerContour(
  contour: FeatureContour,
  center: Point2,
  pathDiameterMm: number,
  deadline: number,
  checkpoint: () => void,
): boolean {
  if (contour.role !== 'CUT_BLACK' || contour.outer.length !== 48) return false;
  const distinct = new Set<string>();
  const radius = pathDiameterMm / 2;
  for (let index = 0; index < contour.outer.length; index += 1) {
    if ((index & 63) === 0) checkRuntimeBudget(deadline, checkpoint, 'assembly:fastener-point-loop');
    const point = contour.outer[index];
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) return false;
    distinct.add(`${point[0]}:${point[1]}`);
    const angle = index * Math.PI * 2 / 48;
    if (!nearlyEqual(point[0], center[0] + Math.cos(angle) * radius)
      || !nearlyEqual(point[1], center[1] + Math.sin(angle) * radius)) return false;
  }
  if (distinct.size !== 48 || !validatePolygon({ points: contour.outer }, () => checkRuntimeBudget(deadline, checkpoint))) {
    return false;
  }
  const bounds = contourBounds(contour.outer, deadline, checkpoint);
  const area = Math.abs(contourSignedArea(contour.outer, deadline, checkpoint));
  return nearlyEqual(contour.boundsMm.minX, bounds.minX)
    && nearlyEqual(contour.boundsMm.minY, bounds.minY)
    && nearlyEqual(contour.boundsMm.maxX, bounds.maxX)
    && nearlyEqual(contour.boundsMm.maxY, bounds.maxY)
    && nearlyEqual(contour.areaMm2, area);
}

function assemblyReasons(
  value: unknown,
  layers: readonly ColoredOutlineLayer[],
  featureWarnings: readonly string[],
  material: ManufacturingGeometryProfile | undefined,
  deadline: number,
  checkpoint: (label?: string) => void,
): string[] {
  const reasons: string[] = [];
  checkRuntimeBudget(deadline, checkpoint);
  if (!isRecord(value)) return ['Automatic assembly summary must be present'];
  reasons.push(...unexpectedKeys(value, new Set(['material', 'launcher', 'fastener', 'topFeatures']), 'Automatic assembly'));
  if (!material || JSON.stringify(value.material) !== JSON.stringify(material)) {
    reasons.push('Automatic assembly material must match the validated manufacturing geometry profile');
  }
  const launcher = value.launcher;
  if (!isRecord(launcher)) {
    reasons.push('Automatic assembly launcher summary must be present');
  } else {
    const active = launcher.status === 'detected' || launcher.status === 'fallback';
    const omitted = launcher.status === 'omitted';
    const permitted = active
      ? new Set(['status', 'cutCount', 'assemblyAllowanceMm'])
      : new Set(['status', 'cutCount']);
    reasons.push(...unexpectedKeys(launcher, permitted, 'Automatic assembly launcher'));
    if (!active && !omitted) reasons.push('Automatic assembly launcher status is invalid');
    if (active && (launcher.cutCount !== 3 || launcher.assemblyAllowanceMm !== 0.2)) {
      reasons.push('Automatic assembly launcher retained summary is invalid');
    }
    if (omitted && launcher.cutCount !== 0) reasons.push('Automatic assembly launcher omitted summary is invalid');
    const topStart = Math.max(0, layers.length - 2);
    const expectedCount = active ? 3 : 0;
    if (layers.some((layer, index) => layer.launcherCuts.length !== (index >= topStart ? expectedCount : 0))) {
      reasons.push('Automatic assembly launcher must be identical on exactly the top two layers or omitted atomically');
    } else if (active && layers.length >= 2) {
      for (let index = 0; index < 3; index += 1) {
        if (!sameContourGeometry(
          layers.at(-2)!.launcherCuts[index], layers.at(-1)!.launcherCuts[index], deadline, checkpoint,
        )) {
          reasons.push('Automatic assembly launcher geometry must be identical on the top two layers');
        }
      }
    }
    if (featureWarnings.includes(LAUNCHER_OMISSION_WARNING_TEXT) !== omitted) {
      reasons.push('Automatic assembly launcher omission warning provenance is inconsistent');
    }
  }
  const fastener = value.fastener;
  if (!isRecord(fastener)) {
    reasons.push('Automatic assembly fastener summary must be present');
  } else {
    reasons.push(...unexpectedKeys(fastener, new Set([
      'count', 'centers', 'finishedDiameterMm', 'pathDiameterMm', 'radiusMm', 'rotationRad',
    ]), 'Automatic assembly fastener'));
    const count = fastener.count;
    const expectedPathDiameterMm = material ? 3 - material.kerfMm : NaN;
    if (![0, 1, 2, 3].includes(count as number)
      || !Array.isArray(fastener.centers) || fastener.centers.length !== count
      || fastener.centers.some((center) => !finiteTuple(center, 2))
      || fastener.finishedDiameterMm !== 3
      || !Number.isFinite(fastener.pathDiameterMm) || (fastener.pathDiameterMm as number) <= 0
      || count === 0 && (fastener.radiusMm !== undefined || fastener.rotationRad !== undefined)
      || count !== 0 && (!Number.isFinite(fastener.radiusMm) || (fastener.radiusMm as number) < 0
        || !Number.isFinite(fastener.rotationRad))) {
      reasons.push('Automatic assembly fastener summary is invalid');
    } else if (!Number.isFinite(expectedPathDiameterMm) || expectedPathDiameterMm <= 0
      || !nearlyEqual(fastener.pathDiameterMm as number, expectedPathDiameterMm)) {
      reasons.push('Automatic assembly fastener path diameter must equal 3 mm minus the material kerf');
    } else if (layers.some((layer) => layer.fastenerHoles.length !== count)) {
      reasons.push('Automatic assembly fastener count must be shared by every layer');
    } else if ((count as number) > 0 && layers.length > 0) {
      const reference = layers[0].fastenerHoles;
      for (const layer of layers.slice(1)) for (let index = 0; index < (count as number); index += 1) {
        if (!sameContourGeometry(reference[index], layer.fastenerHoles[index], deadline, checkpoint)) {
          reasons.push('Automatic assembly fastener geometry must be identical on every layer');
        }
      }
      for (let index = 0; index < (count as number); index += 1) {
        const expected = (fastener.centers as readonly Point2[])[index];
        const patternAngle = (fastener.rotationRad as number) + index * Math.PI * 2 / (count as number);
        const patternCenter: Point2 = [
          Math.cos(patternAngle) * (fastener.radiusMm as number),
          Math.sin(patternAngle) * (fastener.radiusMm as number),
        ];
        if (!nearlyEqual(expected[0], patternCenter[0]) || !nearlyEqual(expected[1], patternCenter[1])
          || !validFastenerContour(
            reference[index], expected, fastener.pathDiameterMm as number, deadline, checkpoint,
          )) {
          reasons.push('Automatic assembly fastener path diameter, centers, and 48-point circle geometry must reconcile');
        }
      }
    }
    if (featureWarnings.includes(FASTENER_OMISSION_WARNING_TEXT) !== (count === 0)) {
      reasons.push('Automatic assembly fastener omission warning provenance is inconsistent');
    }
  }
  const topFeatures = value.topFeatures;
  const top = layers.at(-1);
  if (!isRecord(topFeatures) || !isRecord(topFeatures.retained) || !isRecord(topFeatures.omitted) || !top
    || topFeatures.retained.red !== top.deepFeatures.length
    || topFeatures.retained.blue !== top.lightFeatures.length
    || topFeatures.omitted.red !== (top.diagnostics.depth.omitted?.red ?? 0)
    || topFeatures.omitted.blue !== (top.diagnostics.depth.omitted?.blue ?? 0)) {
    reasons.push('Automatic assembly top-feature retained and omitted counts are inconsistent');
  }
  return reasons;
}

export function validateAutomaticColoredResult(
  value: unknown,
  deadline = Date.now() + DEFAULT_VALIDATION_RUNTIME_MS,
  checkpoint: (label?: string) => void = () => undefined,
  material?: ManufacturingGeometryProfile,
): void {
  checkRuntimeBudget(deadline, checkpoint);
  const reasons: string[] = [];
  if (!isRecord(value)) throw new RangeError('Invalid automatic colored result: result must be an object');
  const budget: ValidationBudget = {
    deadline,
    checkpoint,
  };
  const validationCache = new WeakMap<object, ColoredLayerValidation>();
  const validateLayer = (candidate: unknown): ColoredLayerValidation => {
    checkRuntimeBudget(deadline, checkpoint);
    if (!isRecord(candidate)) {
      const validation = validateColoredLayerWithBudget(candidate, budget);
      if (validation.reasons.includes(RUNTIME_REASON)) throw new RangeError(RUNTIME_REASON);
      return validation;
    }
    const cached = validationCache.get(candidate);
    if (cached) return cached;
    const validation = validateColoredLayerWithBudget(candidate, budget);
    if (validation.reasons.includes(RUNTIME_REASON)) throw new RangeError(RUNTIME_REASON);
    validationCache.set(candidate, validation);
    return validation;
  };
  if (typeof value.sourceHash !== 'string' || value.sourceHash.trim().length === 0) reasons.push('Source hash must be non-empty');
  if (value.mode !== 'exact' && value.mode !== 'outline-2.5d') reasons.push('Outline mode is invalid');
  let selectedAxis: { readonly origin: readonly number[]; readonly direction: readonly number[] } | undefined;
  if (!isRecord(value.axis)) {
    reasons.push('Selected automatic axis must be present');
  } else {
    reasons.push(...unexpectedKeys(value.axis, new Set(['source', 'axis']), 'Selected automatic axis'));
    if (value.axis.source !== 'candidate' && value.axis.source !== 'shortest-bounds') {
      reasons.push('Selected automatic axis source is invalid');
    }
    if (!isRecord(value.axis.axis)) {
      reasons.push('Selected automatic axis geometry must be present');
    } else {
      const axis = value.axis.axis;
      reasons.push(...unexpectedKeys(axis, new Set(['origin', 'direction', 'confidence', 'confirmed']), 'Selected automatic axis geometry'));
      if (!finiteTuple(axis.origin, 3) || !finiteTuple(axis.direction, 3) || Math.hypot(...axis.direction) === 0) {
        reasons.push('Selected automatic axis requires finite origin and non-zero direction triples');
      } else {
        selectedAxis = { origin: axis.origin, direction: axis.direction };
      }
      if (!Number.isFinite(axis.confidence) || (axis.confidence as number) < 0 || (axis.confidence as number) > 1
        || typeof axis.confirmed !== 'boolean') {
        reasons.push('Selected automatic axis confidence and confirmation are invalid');
      }
    }
  }

  const legacyLayers = Array.isArray(value.layers) ? value.layers : undefined;
  if (!legacyLayers) reasons.push('Migration exterior layers must be an array');
  if (!Array.isArray(value.coloredLayers) || !validLayerCount(value.coloredLayers.length)) {
    reasons.push('Colored result requires 6 to 24 ordered layers with exactly one exterior each');
  } else {
    const layerIds = new Set<string>(), featureIds = new Set<string>(), allIds = new Set<string>();
    let previous: ColoredOutlineLayer | undefined;
    for (const [layerPosition, candidate] of value.coloredLayers.entries()) {
      const validation = validateLayer(candidate);
      reasons.push(...validation.reasons);
      if (!isRecord(candidate)) continue;
      if (typeof candidate.id === 'string') {
        if (layerIds.has(candidate.id)) reasons.push(`Duplicate layer ID ${candidate.id}`);
        layerIds.add(candidate.id);
        if (allIds.has(candidate.id)) reasons.push(`Duplicate public ID ${candidate.id}`);
        allIds.add(candidate.id);
      }
      for (const key of ['exterior', 'centralHole'] as const) {
        const feature = candidate[key];
        if (isRecord(feature) && typeof feature.id === 'string') {
          if (featureIds.has(feature.id)) reasons.push(`Duplicate feature ID ${feature.id}`);
          featureIds.add(feature.id);
          if (allIds.has(feature.id)) reasons.push(`Duplicate public ID ${feature.id}`);
          allIds.add(feature.id);
        }
      }
      for (const key of ['launcherCuts', 'fastenerHoles', 'deepFeatures', 'lightFeatures'] as const) {
        const features = candidate[key];
        if (!Array.isArray(features)) continue;
        for (const feature of features) {
          if (!isRecord(feature) || typeof feature.id !== 'string') continue;
          if (featureIds.has(feature.id)) reasons.push(`Duplicate feature ID ${feature.id}`);
          featureIds.add(feature.id);
          if (allIds.has(feature.id)) reasons.push(`Duplicate public ID ${feature.id}`);
          allIds.add(feature.id);
        }
      }
      if (layerPosition !== value.coloredLayers.length - 1) {
        if (Array.isArray(candidate.deepFeatures) && candidate.deepFeatures.length > 1) {
          reasons.push('Lower layers permit at most one deep feature');
        }
        if (Array.isArray(candidate.lightFeatures) && candidate.lightFeatures.length > 1) {
          reasons.push('Lower layers permit at most one light feature');
        }
      }
      if (previous && (typeof candidate.index !== 'number' || candidate.index <= previous.index
        || typeof candidate.zStart !== 'number' || candidate.zStart < previous.zEnd)) {
        reasons.push('Colored layers must be in increasing non-overlapping index and Z order');
      }
      previous = candidate as ColoredOutlineLayer;
    }
  }
  const featureWarningSet = new Set<string>();
  let featureWarnings: readonly string[] | undefined;
  if (!Array.isArray(value.featureWarnings) || value.featureWarnings.some((warning) => typeof warning !== 'string')) {
    reasons.push('Feature warnings must be an array of strings');
  } else {
    featureWarnings = value.featureWarnings as readonly string[];
    for (const warning of featureWarnings) {
      checkRuntimeBudget(deadline, checkpoint);
      if (warning.length === 0 || warning.length > 200 || /[\\/@\r\n\0]/.test(warning)
        || /[\w.+-]+@[\w.-]+/.test(warning)) {
        reasons.push('Each sanitized feature warning must exclude paths and contact details');
      }
      if (featureWarningSet.has(warning)) reasons.push('Feature warnings must not contain duplicates');
      featureWarningSet.add(warning);
    }
  }
  const coloredLayers = Array.isArray(value.coloredLayers)
    ? value.coloredLayers as readonly ColoredOutlineLayer[]
    : [];
  const coloredLayersValid = validLayerCount(coloredLayers.length)
    && coloredLayers.every((layer) => validateLayer(layer).ok);
  const resultMaterial = isRecord(value.material)
    ? value.material as unknown as ManufacturingGeometryProfile
    : undefined;
  const validatedMaterial = material ?? resultMaterial;
  if (material && value.material !== undefined
    && JSON.stringify(value.material) !== JSON.stringify(material)) {
    reasons.push('Automatic result material must match the validated manufacturing geometry profile');
  }
  if (coloredLayersValid && featureWarnings) {
    reasons.push(...assemblyReasons(
      value.assembly, coloredLayers, featureWarnings, validatedMaterial, deadline, checkpoint,
    ));
  }
  if (coloredLayersValid && featureWarnings) {
    try {
      validateSharedCentralHoleDecision(coloredLayers.map((layer) => ({
        status: layer.diagnostics.hole.status,
        contour: layer.centralHole,
        ...(layer.diagnostics.hole.status === 'retained' ? {
          equivalentDiameterMm: layer.diagnostics.hole.equivalentDiameterMm,
          axisDistanceMm: layer.diagnostics.hole.axisDistanceMm,
        } : {}),
      })), featureWarnings, deadline, checkpoint);
    } catch (error) {
      if (error instanceof RangeError && error.message === RUNTIME_REASON) throw error;
      reasons.push(error instanceof Error ? error.message : 'Shared central hole decision is invalid');
    }
  }
  for (const layer of coloredLayers) {
    checkRuntimeBudget(deadline, checkpoint);
    if (!isRecord(layer) || !isRecord(layer.diagnostics) || !isRecord(layer.diagnostics.depth)) continue;
    const omissionCode = layer.diagnostics.depth.omissionCode as DepthFeatureOmissionCode | undefined;
    if (omissionCode && DEPTH_OMISSION_CODES.has(omissionCode)
      && !featureWarningSet.has(DEPTH_OMISSION_WARNINGS[omissionCode])) {
      reasons.push(`Depth omission ${omissionCode} requires its sanitized feature warning`);
    }
  }

  if (legacyLayers) {
    if (!validLayerCount(legacyLayers.length)) {
      reasons.push('Migration exterior layers must contain 6 to 24 ordered layer records');
    }
    if (legacyLayers.length !== coloredLayers.length) {
      reasons.push('Migration exterior layers must match the colored layer count and order');
    }
    for (let index = 0; index < legacyLayers.length; index += 1) {
      const candidate = legacyLayers[index];
      if (isRecord(candidate)) {
        for (const [key, label, role] of [
          ['exterior', 'Exterior', 'CUT_BLACK'],
          ['centralHole', 'Central hole', 'CUT_BLACK'],
          ['deepFeature', 'Deep feature', 'DEEP_RED'],
          ['lightFeature', 'Light feature', 'LIGHT_BLUE'],
        ] as const) {
          if (candidate[key] === undefined) continue;
          reasons.push(`Migration exterior layer has unexpected ${label.toLowerCase()} role geometry`);
          reasons.push(...contourReasons(candidate[key], role, label, budget));
        }
        for (const key of ['features', 'holes']) {
          if (Object.hasOwn(candidate, key)) reasons.push(`Migration exterior layer has unexpected generic ${key} array`);
        }
      }
      if (!isLegacyLayerCandidate(candidate)) {
        reasons.push(`Migration exterior layer ${index} is malformed`);
        continue;
      }
      try {
        const validation = validateOutlineLayer(candidate, deadline, checkpoint);
        reasons.push(...validation.reasons.map((reason) => `Migration exterior layer ${index}: ${reason}`));
      } catch {
        reasons.push(`Migration exterior layer ${index} is malformed`);
        continue;
      }
      const colored = coloredLayers[index];
      if (colored && (candidate.id !== colored.id || candidate.index !== colored.index
        || candidate.zStart !== colored.zStart || candidate.zEnd !== colored.zEnd
        || candidate.removedComponentCount !== colored.removedComponentCount
        || candidate.simplifiedAreaMm2 !== colored.exterior.areaMm2
        || !samePoints(candidate.contour.outer, colored.exterior.outer))) {
        reasons.push(`Migration exterior layer ${index} must match the ordered colored layer record`);
      }
    }
  }
  if (!Number.isSafeInteger(value.removedComponentCount) || (value.removedComponentCount as number) < 0) {
    reasons.push('Automatic removed component count must be a non-negative safe integer');
  } else if (coloredLayersValid && value.removedComponentCount !== coloredLayers.reduce(
    (sum, layer) => sum + layer.removedComponentCount, 0,
  )) {
    reasons.push('Automatic removed component count must match ordered colored layer records');
  }
  reasons.push(...previewReasons(
    value.preview, coloredLayers, coloredLayersValid, selectedAxis, validateLayer, budget,
  ));
  const previewAxis = isRecord(value.preview) && isRecord(value.preview.axis)
    ? value.preview.axis as unknown as OutlinePreviewAxis
    : undefined;
  if (typeof value.featureEvidenceFingerprint !== 'string' || value.featureEvidenceFingerprint.length === 0) {
    reasons.push('Feature evidence fingerprint must be present and non-empty');
  } else if (previewAxis && coloredLayersValid && (value.mode === 'exact' || value.mode === 'outline-2.5d') && typeof value.sourceHash === 'string'
    && value.featureEvidenceFingerprint !== featureEvidenceFingerprint({
      sourceHash: value.sourceHash,
      material: validatedMaterial,
      assembly: value.assembly as AutomaticOutlineAssembly | undefined,
      mode: value.mode,
      coloredLayers,
      preview: { axis: previewAxis },
    }, deadline, checkpoint, validatedMaterial)) {
    reasons.push('Feature evidence fingerprint is inconsistent with ordered role records');
  }
  if (reasons.length > 0) throw new RangeError(`Invalid automatic colored result: ${reasons.join('; ')}`);
}
