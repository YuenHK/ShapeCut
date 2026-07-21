import type { Point2 } from '../decomposition/types';
import type { OutlineLayer } from '../outline-2.5d/extract';
import type { Bounds2 } from '../outline-2.5d/simplify';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineMode } from '../outline-2.5d/types';
import { validateOutlineLayer } from '../outline-2.5d/validate';
import { isStrictlyContainedLoop } from './hole';

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
  };
};
export type ColoredOutlineLayer = {
  readonly id: string;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly exterior: FeatureContour;
  readonly centralHole?: FeatureContour;
  readonly deepFeature?: FeatureContour;
  readonly lightFeature?: FeatureContour;
  readonly removedComponentCount: number;
  readonly diagnostics: LayerFeatureDiagnostics;
};
export type OutlinePreviewPayload = {
  readonly mesh: { readonly positions: Float32Array; readonly indices: Uint32Array };
  readonly axis: {
    readonly origin: readonly [number, number, number];
    readonly direction: readonly [number, number, number];
  };
  readonly layers: readonly ColoredOutlineLayer[];
};

export type ColoredLayerValidation = { readonly ok: boolean; readonly reasons: readonly string[] };
type FeatureFingerprintSource = {
  readonly sourceHash: string;
  readonly mode: OutlineMode;
  readonly coloredLayers: readonly ColoredOutlineLayer[];
};
type UnknownRecord = Record<string, unknown>;
type ValidationBudget = {
  readonly deadline: number;
  readonly checkpoint: () => void;
};

const FEATURE_ROLES = new Set<FeatureRole>(['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE']);
const LAYER_KEYS = new Set([
  'id', 'index', 'zStart', 'zEnd', 'exterior', 'centralHole', 'deepFeature', 'lightFeature',
  'removedComponentCount', 'diagnostics',
]);
const CONTOUR_KEYS = new Set(['id', 'role', 'outer', 'boundsMm', 'areaMm2']);
const RUNTIME_REASON = 'Colored feature validation exceeded the runtime budget';
const DEFAULT_VALIDATION_RUNTIME_MS = 30_000;

function validLayerCount(count: number): boolean {
  return count >= DEFAULT_OUTLINE_BUDGETS.minLayers && count <= DEFAULT_OUTLINE_BUDGETS.maxLayers;
}

function checkRuntimeBudget(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError(RUNTIME_REASON);
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
      'cellSizeMm', 'contrastMm', 'redThresholdMm', 'blueThresholdMm',
    ]), 'Depth diagnostics'));
    const depth = value.depth;
    if (![depth.cellSizeMm, depth.contrastMm, depth.redThresholdMm, depth.blueThresholdMm].every(Number.isFinite)
      || (depth.cellSizeMm as number) < 0 || (depth.contrastMm as number) < 0
      || (depth.redThresholdMm as number) < 0 || (depth.blueThresholdMm as number) < 0
      || (depth.redThresholdMm as number) < (depth.blueThresholdMm as number)) {
      reasons.push('Depth diagnostics must be finite, non-negative, and ordered red over blue');
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
    ['Deep feature', value.deepFeature, 'DEEP_RED'],
    ['Light feature', value.lightFeature, 'LIGHT_BLUE'],
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
  checkpoint: () => void,
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
        ['deepFeature', contourRecord(layer.deepFeature, deadline, checkpoint)],
        ['lightFeature', contourRecord(layer.lightFeature, deadline, checkpoint)],
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
): string {
  checkRuntimeBudget(deadline, checkpoint);
  const serialized = JSON.stringify({
    sourceHash: result.sourceHash,
    mode: result.mode,
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
    reasons.push(...unexpectedKeys(value.axis, new Set(['origin', 'direction']), 'Preview axis'));
    if (!finiteTuple(value.axis.origin, 3) || !finiteTuple(value.axis.direction, 3)) {
      reasons.push('Preview axis origin and direction must contain finite triples');
    } else if (Math.hypot(...value.axis.direction) === 0) {
      reasons.push('Preview axis direction must be non-zero');
    } else if (selectedAxis && (value.axis.origin.some((item, index) => item !== selectedAxis.origin[index])
      || value.axis.direction.some((item, index) => item !== selectedAxis.direction[index]))) {
      reasons.push('Preview axis must match the selected automatic axis');
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

export function validateAutomaticColoredResult(
  value: unknown,
  deadline = Date.now() + DEFAULT_VALIDATION_RUNTIME_MS,
  checkpoint: () => void = () => undefined,
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
    for (const candidate of value.coloredLayers) {
      const validation = validateLayer(candidate);
      reasons.push(...validation.reasons);
      if (!isRecord(candidate)) continue;
      if (typeof candidate.id === 'string') {
        if (layerIds.has(candidate.id)) reasons.push(`Duplicate layer ID ${candidate.id}`);
        layerIds.add(candidate.id);
        if (allIds.has(candidate.id)) reasons.push(`Duplicate public ID ${candidate.id}`);
        allIds.add(candidate.id);
      }
      for (const key of ['exterior', 'centralHole', 'deepFeature', 'lightFeature']) {
        const feature = candidate[key];
        if (isRecord(feature) && typeof feature.id === 'string') {
          if (featureIds.has(feature.id)) reasons.push(`Duplicate feature ID ${feature.id}`);
          featureIds.add(feature.id);
          if (allIds.has(feature.id)) reasons.push(`Duplicate public ID ${feature.id}`);
          allIds.add(feature.id);
        }
      }
      if (previous && (typeof candidate.index !== 'number' || candidate.index <= previous.index
        || typeof candidate.zStart !== 'number' || candidate.zStart < previous.zEnd)) {
        reasons.push('Colored layers must be in increasing non-overlapping index and Z order');
      }
      previous = candidate as ColoredOutlineLayer;
    }
  }
  if (!Array.isArray(value.featureWarnings) || value.featureWarnings.some((warning) => typeof warning !== 'string')) {
    reasons.push('Feature warnings must be an array of strings');
  }
  const coloredLayers = Array.isArray(value.coloredLayers)
    ? value.coloredLayers as readonly ColoredOutlineLayer[]
    : [];
  const coloredLayersValid = validLayerCount(coloredLayers.length)
    && coloredLayers.every((layer) => validateLayer(layer).ok);

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
  if (typeof value.featureEvidenceFingerprint !== 'string' || value.featureEvidenceFingerprint.length === 0) {
    reasons.push('Feature evidence fingerprint must be present and non-empty');
  } else if (coloredLayersValid && (value.mode === 'exact' || value.mode === 'outline-2.5d') && typeof value.sourceHash === 'string'
    && value.featureEvidenceFingerprint !== featureEvidenceFingerprint({
      sourceHash: value.sourceHash,
      mode: value.mode,
      coloredLayers,
    }, deadline, checkpoint)) {
    reasons.push('Feature evidence fingerprint is inconsistent with ordered role records');
  }
  if (reasons.length > 0) throw new RangeError(`Invalid automatic colored result: ${reasons.join('; ')}`);
}
