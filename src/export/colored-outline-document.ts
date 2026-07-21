import type { FeatureContour } from '../domain/outline-features/types';
import { validateAutomaticColoredResult } from '../domain/outline-features/types';
import {
  diagnosticsFingerprint,
  removalEvidenceFingerprint,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';

export const COLORED_ROLE_COLORS = Object.freeze({
  CUT_BLACK: '#000000',
  DEEP_RED: '#E5484D',
  LIGHT_BLUE: '#3E63DD',
} as const);

export type ColoredOutlineRole = keyof typeof COLORED_ROLE_COLORS;
export type ColoredOutlineDocument = {
  readonly schemaVersion: 2;
  readonly sourceHash: string;
  readonly featureEvidenceFingerprint: string;
  readonly diagnosticsFingerprint: string;
  readonly layers: readonly {
    readonly id: string;
    readonly order: number;
    readonly index: number;
    readonly zStart: number;
    readonly zEnd: number;
    readonly roles: Readonly<{
      CUT_BLACK: readonly FeatureContour[];
      DEEP_RED: readonly FeatureContour[];
      LIGHT_BLUE: readonly FeatureContour[];
    }>;
  }[];
};

export type ColoredDocumentDeadlineOptions = {
  readonly now?: () => number;
  readonly onCheckpoint?: (label: string) => void;
};

export type ColoredDocumentCheckpoint = (label: string) => void;

export function coloredDocumentCheckpoint(
  deadline: number,
  options: ColoredDocumentDeadlineOptions = {},
): ColoredDocumentCheckpoint {
  const now = options.now ?? Date.now;
  return (label) => {
    options.onCheckpoint?.(label);
    if (!Number.isFinite(deadline) || now() > deadline) {
      throw new RangeError('Colored outline package exceeded the shared deadline');
    }
  };
}

function copyContour(contour: FeatureContour, checkpoint: ColoredDocumentCheckpoint): FeatureContour {
  checkpoint('canonical:contour:start');
  return {
    id: contour.id,
    role: contour.role,
    outer: contour.outer.map(([x, y], index) => {
      if ((index & 63) === 0) checkpoint('canonical:polygon-loop');
      return [x, y] as const;
    }),
    boundsMm: { ...contour.boundsMm },
    areaMm2: contour.areaMm2,
  };
}

function documentFromValidatedResult(
  result: AutomaticOutlineResult,
  checkpoint: ColoredDocumentCheckpoint,
): ColoredOutlineDocument {
  const layers = result.coloredLayers.map((layer, index) => {
    checkpoint('canonical:layer-loop');
    return {
      id: layer.id,
      order: index + 1,
      index: layer.index,
      zStart: layer.zStart,
      zEnd: layer.zEnd,
      roles: {
        CUT_BLACK: [
          copyContour(layer.exterior, checkpoint),
          ...(layer.centralHole ? [copyContour(layer.centralHole, checkpoint)] : []),
        ],
        DEEP_RED: layer.deepFeature ? [copyContour(layer.deepFeature, checkpoint)] : [],
        LIGHT_BLUE: layer.lightFeature ? [copyContour(layer.lightFeature, checkpoint)] : [],
      },
    };
  });
  return {
    schemaVersion: 2,
    sourceHash: result.sourceHash,
    featureEvidenceFingerprint: result.featureEvidenceFingerprint,
    diagnosticsFingerprint: diagnosticsFingerprint(result.diagnostics),
    layers,
  };
}

function signedArea(points: FeatureContour['outer'], checkpoint: ColoredDocumentCheckpoint): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkpoint('canonical:orientation-loop');
    const point = points[index], next = points[(index + 1) % points.length];
    sum += point[0] * next[1] - next[0] * point[1];
  }
  return sum / 2;
}

function exactRecord(value: unknown): string {
  return JSON.stringify(value);
}

function assertCanonicalShape(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint,
): void {
  if (document.schemaVersion !== 2
    || !/^[0-9a-f]{32}$/i.test(document.sourceHash)
    || !/^[0-9a-f]{32}$/i.test(document.featureEvidenceFingerprint)
    || !/^[0-9a-f]{32}$/i.test(document.diagnosticsFingerprint)
    || !Array.isArray(document.layers)
    || document.layers.length < 6
    || document.layers.length > 24) {
    throw new RangeError('Colored canonical document fingerprint or layer count is invalid');
  }
  const layerIds = new Set<string>(), featureIds = new Set<string>();
  for (const [position, layer] of document.layers.entries()) {
    checkpoint('canonical:validate-layer-loop');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(layer.id)
      || layerIds.has(layer.id)
      || layer.order !== position + 1
      || !Number.isSafeInteger(layer.index)
      || layer.index < 0
      || !Number.isFinite(layer.zStart)
      || !Number.isFinite(layer.zEnd)
      || layer.zEnd <= layer.zStart
      || position > 0 && (layer.index <= document.layers[position - 1].index
        || layer.zStart < document.layers[position - 1].zEnd)
      || exactRecord(Object.keys(layer.roles)) !== exactRecord(['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE'])
      || layer.roles.CUT_BLACK.length < 1
      || layer.roles.CUT_BLACK.length > 2
      || layer.roles.DEEP_RED.length > 1
      || layer.roles.LIGHT_BLUE.length > 1) {
      throw new RangeError('Colored canonical layer identity, order, span, or role cardinality is invalid');
    }
    layerIds.add(layer.id);
    for (const role of Object.keys(COLORED_ROLE_COLORS) as ColoredOutlineRole[]) {
      const contours = layer.roles[role];
      for (const [contourIndex, contour] of contours.entries()) {
        checkpoint('canonical:validate-contour-loop');
        if (contour.role !== role
          || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(contour.id)
          || featureIds.has(contour.id)) {
          throw new RangeError('Colored canonical contour role or identity is invalid');
        }
        featureIds.add(contour.id);
        const area = signedArea(contour.outer, checkpoint);
        const expectedCounterClockwise = role === 'CUT_BLACK' && contourIndex === 1;
        if (!Number.isFinite(area) || area === 0
          || (expectedCounterClockwise ? area <= 0 : area >= 0)) {
          throw new RangeError('Colored canonical contour orientation is invalid');
        }
      }
    }
  }
}

function runColoredResultValidation(
  result: AutomaticOutlineResult,
  deadline: number,
  options: ColoredDocumentDeadlineOptions,
  checkpoint: ColoredDocumentCheckpoint,
): void {
  checkpoint('canonical:result-validation:before');
  // Test clocks are injected through checkpoint; production keeps the same absolute Date.now deadline.
  validateAutomaticColoredResult(result, options.now ? Infinity : deadline, () => checkpoint('canonical:result-validation-loop'));
  const inspection = result.originalReport.inspection;
  const expectedTopology = {
    triangleCount: inspection.triangleCount,
    boundaryEdgeCount: inspection.boundaryEdgeCount,
    nonManifoldEdgeCount: inspection.nonManifoldEdgeCount,
    degenerateTriangleCount: inspection.degenerateTriangleCount,
    duplicateTriangleCount: result.originalReport.duplicateTriangleCount,
    inconsistentWindingEdgeCount: result.originalReport.inconsistentWindingEdgeCount,
    selfIntersectionCount: result.originalReport.selfIntersectionCount,
    selfIntersectionAnalysisComplete: result.originalReport.selfIntersectionAnalysisComplete,
  };
  const expectedDiagnosticLayers = result.layers.map((layer) => {
    checkpoint('canonical:diagnostic-layer-loop');
    return {
      id: layer.id,
      simplificationToleranceMm: layer.simplificationToleranceMm,
      boundsDriftRatio: layer.boundsDriftRatio,
      areaDriftRatio: layer.areaDriftRatio,
      areaEvidenceBasis: result.mode === 'exact'
        ? 'exact-slice-pre-simplification' as const
        : 'retained-raster-pre-simplification' as const,
    };
  });
  if (exactRecord(result.diagnostics.topology) !== exactRecord(expectedTopology)
    || result.diagnostics.repairDecision !== (result.repairAccepted ? 'accepted' : 'projected-original')
    || (result.mode === 'exact'
      ? result.diagnostics.rasterCellSizeMm !== null
      : !(Number.isFinite(result.diagnostics.rasterCellSizeMm) && result.diagnostics.rasterCellSizeMm! > 0))
    || exactRecord(result.diagnostics.layers) !== exactRecord(expectedDiagnosticLayers)) {
    throw new RangeError('Colored canonical diagnostics drift from direct pipeline evidence');
  }
  if (result.removalEvidenceFingerprint !== removalEvidenceFingerprint(result)) {
    throw new RangeError('Colored canonical removal evidence fingerprint is inconsistent');
  }
  checkpoint('canonical:result-validation:after');
}

export function createColoredOutlineDocument(
  result: AutomaticOutlineResult,
  deadline = Date.now() + 30_000,
  options: ColoredDocumentDeadlineOptions = {},
): ColoredOutlineDocument {
  const checkpoint = coloredDocumentCheckpoint(deadline, options);
  checkpoint('canonical:create:start');
  runColoredResultValidation(result, deadline, options, checkpoint);
  const document = documentFromValidatedResult(result, checkpoint);
  assertCanonicalShape(document, checkpoint);
  checkpoint('canonical:create:return');
  return document;
}

export function validateColoredOutlineDocument(
  document: ColoredOutlineDocument,
  result: AutomaticOutlineResult,
  deadline = Date.now() + 30_000,
  options: ColoredDocumentDeadlineOptions = {},
): void {
  const checkpoint = coloredDocumentCheckpoint(deadline, options);
  checkpoint('canonical:verify:start');
  runColoredResultValidation(result, deadline, options, checkpoint);
  assertCanonicalShape(document, checkpoint);
  const expected = documentFromValidatedResult(result, checkpoint);
  if (exactRecord(document) !== exactRecord(expected)) {
    throw new RangeError('Colored canonical document geometry, role, order, span, or fingerprint mismatch');
  }
  checkpoint('canonical:verify:return');
}
