import type { AutomaticOutlineAssembly, FeatureContour } from '../domain/outline-features/types';
import { validateManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import {
  validateAutomaticColoredResult,
  validateSharedCentralHoleDecision,
} from '../domain/outline-features/types';
import {
  diagnosticsFingerprint,
  removalEvidenceFingerprint,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import { LAUNCHER_ASSEMBLY_ALLOWANCE_MM } from '../domain/outline-assembly/launcher';
import { validateLauncherFitOffsetMm } from '../domain/outline-assembly/launcher-fit';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import { PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING } from '../domain/outline-features/depth-field';
import {
  LAUNCHER_EXTERIOR_EXPANSION_MAX_MM,
  LAUNCHER_EXTERIOR_EXPANSION_MODE,
  normalizeLauncherExteriorExpansionMm,
} from '../domain/outline-assembly/launcher-exterior-expansion';

export const COLORED_ROLE_COLORS = Object.freeze({
  CUT_BLACK: '#000000',
  DEEP_RED: '#E5484D',
  LIGHT_BLUE: '#3A78D4',
} as const);

export type ColoredOutlineRole = keyof typeof COLORED_ROLE_COLORS;
export type ColoredOutlineDocument = {
  readonly schemaVersion: 2;
  readonly sourceHash: string;
  readonly featureEvidenceFingerprint: string;
  readonly diagnosticsFingerprint: string;
  readonly safetyNotes: readonly string[];
  readonly assembly: AutomaticOutlineAssembly;
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

const MAX_SAFETY_NOTES = 16;
const MAX_SAFETY_NOTE_LENGTH = 200;

export function coloredDocumentCheckpoint(
  deadline: number,
  options: ColoredDocumentDeadlineOptions = {},
): ColoredDocumentCheckpoint {
  const now = options.now ?? Date.now;
  return (label) => {
    options.onCheckpoint?.(label);
    if ((deadline !== Number.POSITIVE_INFINITY && !Number.isFinite(deadline)) || now() > deadline) {
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

function copySafetyNotes(
  notes: readonly string[],
  checkpoint: ColoredDocumentCheckpoint,
): readonly string[] {
  if (!Array.isArray(notes) || notes.length > MAX_SAFETY_NOTES) {
    throw new RangeError('Colored canonical safety note count is out of bounds or invalid');
  }
  const seen = new Set<string>();
  return notes.map((note) => {
    checkpoint('canonical:safety-note-loop');
    if (typeof note !== 'string' || note.length === 0 || note.length > MAX_SAFETY_NOTE_LENGTH
      || /[\\/@\r\n\0]/.test(note) || /[\w.+-]+@[\w.-]+/.test(note) || seen.has(note)) {
      throw new RangeError('Colored canonical safety note is private, contact-bearing, out of bounds, or invalid');
    }
    seen.add(note);
    return note;
  });
}

function copyAssembly(
  assembly: AutomaticOutlineAssembly,
  checkpoint: ColoredDocumentCheckpoint,
): AutomaticOutlineAssembly {
  checkpoint('canonical:assembly:start');
  const material = validateManufacturingGeometryProfile(assembly.material);
  if (!Array.isArray(assembly.decorationOmissions) || assembly.decorationOmissions.length > 24) {
    throw new RangeError('Colored canonical decoration omission evidence is invalid');
  }
  const decorationOmissions = assembly.decorationOmissions.map((omission) => {
    checkpoint('canonical:assembly-decoration-omission-loop');
    if (!omission || typeof omission !== 'object'
      || Object.keys(omission).length !== 3
      || !Object.hasOwn(omission, 'layerId')
      || !Object.hasOwn(omission, 'reason')
      || !Object.hasOwn(omission, 'roles')
      || typeof omission.layerId !== 'string'
      || omission.reason !== 'protected-cut-work-budget'
      || !Array.isArray(omission.roles)
      || omission.roles.length !== 2
      || omission.roles[0] !== 'DEEP_RED'
      || omission.roles[1] !== 'LIGHT_BLUE') {
      throw new RangeError('Colored canonical decoration omission evidence is invalid');
    }
    return {
      layerId: omission.layerId,
      reason: 'protected-cut-work-budget' as const,
      roles: ['DEEP_RED', 'LIGHT_BLUE'] as const,
    };
  });
  return {
    material: { ...material, fitAllowanceMm: { ...material.fitAllowanceMm } },
    launcher: {
      status: 'fixed',
      cutCount: 3,
      templateVersion: assembly.launcher.templateVersion,
      templateFingerprint: assembly.launcher.templateFingerprint,
      rotationRad: assembly.launcher.rotationRad,
      fitOffsetMm: assembly.launcher.fitOffsetMm,
      finishedAllowanceMm: assembly.launcher.finishedAllowanceMm,
      exteriorExpansion: {
        mode: assembly.launcher.exteriorExpansion.mode,
        offsetMm: assembly.launcher.exteriorExpansion.offsetMm,
        maxOffsetMm: assembly.launcher.exteriorExpansion.maxOffsetMm,
        affectedLayerIds: [
          assembly.launcher.exteriorExpansion.affectedLayerIds[0],
          assembly.launcher.exteriorExpansion.affectedLayerIds[1],
        ],
      },
    },
    fastener: {
      count: assembly.fastener.count,
      centers: assembly.fastener.centers.map(([x, y]) => {
        checkpoint('canonical:assembly-center-loop');
        return [x, y] as const;
      }),
      finishedDiameterMm: assembly.fastener.finishedDiameterMm,
      pathDiameterMm: assembly.fastener.pathDiameterMm,
      ...(assembly.fastener.radiusMm === undefined ? {} : { radiusMm: assembly.fastener.radiusMm }),
      ...(assembly.fastener.rotationRad === undefined ? {} : { rotationRad: assembly.fastener.rotationRad }),
    },
    decorationOmissions,
    topFeatures: {
      retained: { ...assembly.topFeatures.retained },
      omitted: { ...assembly.topFeatures.omitted },
      launcherOverlap: {
        clipped: { ...assembly.topFeatures.launcherOverlap.clipped },
        removed: { ...assembly.topFeatures.launcherOverlap.removed },
      },
    },
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
          ...layer.launcherCuts.map((contour) => copyContour(contour, checkpoint)),
          ...layer.fastenerHoles.map((contour) => copyContour(contour, checkpoint)),
        ],
        DEEP_RED: layer.deepFeatures.map((contour) => copyContour(contour, checkpoint)),
        LIGHT_BLUE: layer.lightFeatures.map((contour) => copyContour(contour, checkpoint)),
      },
    };
  });
  return {
    schemaVersion: 2,
    sourceHash: result.sourceHash,
    featureEvidenceFingerprint: result.featureEvidenceFingerprint,
    diagnosticsFingerprint: diagnosticsFingerprint(result.diagnostics),
    safetyNotes: copySafetyNotes(result.featureWarnings, checkpoint),
    assembly: copyAssembly(result.assembly, checkpoint),
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
    || (document.layers.length !== 3 && document.layers.length < 6)
    || document.layers.length > 24) {
    throw new RangeError('Colored canonical document fingerprint or layer count is invalid');
  }
  const safetyNotes = copySafetyNotes(document.safetyNotes, checkpoint);
  const assembly = copyAssembly(document.assembly, checkpoint);
  let validFitOffset = true;
  try {
    validateLauncherFitOffsetMm(assembly.launcher.fitOffsetMm);
  } catch {
    validFitOffset = false;
  }
  const expansion = assembly.launcher.exteriorExpansion;
  let validExpansionOffset = true;
  try {
    validExpansionOffset = normalizeLauncherExteriorExpansionMm(expansion.offsetMm)
      === expansion.offsetMm;
  } catch {
    validExpansionOffset = false;
  }
  if (assembly.launcher.status !== 'fixed'
    || assembly.launcher.cutCount !== 3
    || assembly.launcher.templateVersion !== OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
    || assembly.launcher.templateFingerprint !== OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT
    || !Number.isFinite(assembly.launcher.rotationRad)
    || assembly.launcher.rotationRad < 0
    || assembly.launcher.rotationRad >= Math.PI * 2
    || !validFitOffset
    || expansion.mode !== LAUNCHER_EXTERIOR_EXPANSION_MODE
    || !validExpansionOffset
    || expansion.maxOffsetMm !== LAUNCHER_EXTERIOR_EXPANSION_MAX_MM
    || expansion.affectedLayerIds[0] !== document.layers.at(-2)?.id
    || expansion.affectedLayerIds[1] !== document.layers.at(-1)?.id
    || assembly.launcher.finishedAllowanceMm
      !== LAUNCHER_ASSEMBLY_ALLOWANCE_MM + assembly.launcher.fitOffsetMm) {
    throw new RangeError('Colored canonical fixed launcher assembly evidence is invalid');
  }
  const launcherCount = 3;
  const fastenerCount = assembly.fastener.count;
  if (![0, 1, 2, 3].includes(fastenerCount)
    || assembly.fastener.centers.length !== fastenerCount
    || assembly.fastener.finishedDiameterMm !== 3
    || !Number.isFinite(assembly.fastener.pathDiameterMm) || assembly.fastener.pathDiameterMm <= 0
    || ![assembly.topFeatures.retained.red, assembly.topFeatures.retained.blue,
      assembly.topFeatures.omitted.red, assembly.topFeatures.omitted.blue]
      .concat(
        assembly.topFeatures.launcherOverlap.clipped.red,
        assembly.topFeatures.launcherOverlap.clipped.blue,
        assembly.topFeatures.launcherOverlap.removed.red,
        assembly.topFeatures.launcherOverlap.removed.blue,
      )
      .every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new RangeError('Colored canonical assembly summary is invalid');
  }
  let previousOmissionPosition = -1;
  const omittedLayerIds = new Set<string>();
  for (const omission of assembly.decorationOmissions) {
    checkpoint('canonical:validate-decoration-omission-loop');
    const position = document.layers.findIndex((layer) => layer.id === omission.layerId);
    const layer = document.layers[position];
    if (position <= previousOmissionPosition
      || omittedLayerIds.has(omission.layerId)
      || !layer
      || layer.roles.DEEP_RED.length !== 0
      || layer.roles.LIGHT_BLUE.length !== 0) {
      throw new RangeError('Colored canonical decoration omission layer order or roles are inconsistent');
    }
    omittedLayerIds.add(omission.layerId);
    previousOmissionPosition = position;
  }
  if (safetyNotes.includes(PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING)
    !== (assembly.decorationOmissions.length > 0)) {
    throw new RangeError('Colored canonical decoration omission warning provenance is inconsistent');
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
      || layer.roles.CUT_BLACK.length > 8
      || layer.roles.DEEP_RED.length > 12
      || layer.roles.LIGHT_BLUE.length > 12) {
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
        const expectedCounterClockwise = role === 'CUT_BLACK' && contourIndex > 0;
        if (!Number.isFinite(area) || area === 0
          || (expectedCounterClockwise ? area <= 0 : area >= 0)) {
          throw new RangeError('Colored canonical contour orientation is invalid');
        }
      }
    }
  }
  const centralHoles = document.layers.map((layer, index) => {
    const layerLauncherCount = index >= document.layers.length - 2 ? launcherCount : 0;
    const centralCount = layer.roles.CUT_BLACK.length - 1 - layerLauncherCount - fastenerCount;
    if (centralCount !== 0 && centralCount !== 1) {
      throw new RangeError('Colored canonical black-cut assembly cardinality is inconsistent');
    }
    const contour = centralCount === 1 ? layer.roles.CUT_BLACK[1] : undefined;
    return {
      status: contour ? 'retained' as const : 'omitted' as const,
      ...(contour ? { contour } : {}),
    };
  });
  validateSharedCentralHoleDecision(
    centralHoles, safetyNotes, Infinity, () => checkpoint('canonical:shared-hole-loop'), 'Canonical shared central hole',
  );
  const top = document.layers.at(-1)!;
  if (assembly.topFeatures.retained.red !== top.roles.DEEP_RED.length
    || assembly.topFeatures.retained.blue !== top.roles.LIGHT_BLUE.length) {
    throw new RangeError('Colored canonical top-feature assembly counts are inconsistent');
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
  const material = result.material === undefined
    ? undefined
    : validateManufacturingGeometryProfile(result.material);
  validateAutomaticColoredResult(result, options.now ? Infinity : deadline, (label) => checkpoint(
    label ? `canonical:result-validation:${label}` : 'canonical:result-validation-loop',
  ), material);
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
