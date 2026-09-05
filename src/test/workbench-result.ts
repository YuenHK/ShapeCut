import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, type ColoredOutlineLayer } from '../domain/outline-features/types';
import { GEOMETRY_ESTIMATE_MATERIALS } from '../domain/materials/geometry-estimates';
import { OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT, OFFICIAL_THREE_PRONG_TEMPLATE_VERSION } from '../domain/outline-assembly/launcher-template';
const coloredLayer: ColoredOutlineLayer = {
  id: 'layer-0', index: 0, zStart: 0, zEnd: 1,
  exterior: {
    id: 'layer-0-exterior', role: 'CUT_BLACK',
    outer: [[0, 0], [10, 0], [10, 5], [0, 5]],
    boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 5 }, areaMm2: 50,
  },
  launcherCuts: [], fastenerHoles: [], deepFeatures: [], lightFeatures: [],
  removedComponentCount: 0,
  diagnostics: {
    hole: { status: 'omitted' },
    depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
  },
};

const resultMaterial = GEOMETRY_ESTIMATE_MATERIALS.find(({ id }) => id === 'acrylic-6')!;

const baseResult: AutomaticOutlineResult = {
  sourceHash: 'a'.repeat(32),
  material: resultMaterial,
  assembly: {
    material: resultMaterial,
    launcher: {
      status: 'fixed', cutCount: 3,
      templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      rotationRad: 0, fitOffsetMm: 0, finishedAllowanceMm: 0.2,
      exteriorExpansion: {
        mode: 'shared-uniform', offsetMm: 0, maxOffsetMm: 6,
        affectedLayerIds: ['layer-0', 'layer-1'],
      },
    },
    fastener: { count: 0, centers: [], finishedDiameterMm: 3, pathDiameterMm: 2.85 },
    decorationOmissions: [],
    topFeatures: {
      retained: { red: 0, blue: 0 }, omitted: { red: 0, blue: 0 },
      launcherOverlap: {
        clipped: { red: 0, blue: 0 }, removed: { red: 0, blue: 0 },
      },
    },
  },
  mode: 'exact',
  status: 'success',
  axis: { source: 'candidate', axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: true } },
  layers: [{
    id: 'layer-0', index: 0, zStart: 0, zEnd: 1,
    contour: { outer: [[0, 0], [10, 0], [10, 5], [0, 5]], holes: [] },
    sourceAreaMm2: 50, simplifiedAreaMm2: 50,
    sourceBoundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
    simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0,
    removedComponentCount: 0,
  }],
  centralHoleSourceEvidence: [{ status: 'omitted' }],
  decorationOmissionSourceEvidence: [],
  coloredLayers: [coloredLayer],
  featureWarnings: [],
  featureEvidenceFingerprint: featureEvidenceFingerprint({
    sourceHash: 'a'.repeat(32), status: 'success', mode: 'exact',
    centralHoleSourceEvidence: [{ status: 'omitted' }],
    decorationOmissionSourceEvidence: [], coloredLayers: [coloredLayer],
    preview: { axis: {
      origin: [0, 0, 0], direction: [0, 0, 1], planeX: [0, 1, 0], planeY: [-1, 0, 0],
    } },
  }),
  preview: {
    mesh: {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 5, 0]),
      indices: new Uint32Array([0, 1, 2]),
    },
    axis: {
      origin: [0, 0, 0], direction: [0, 0, 1],
      planeX: [0, 1, 0], planeY: [-1, 0, 0],
    },
    layers: [coloredLayer],
  },
  warnings: [],
  originalReport: {} as AutomaticOutlineResult['originalReport'],
  repairAccepted: true,
  removedComponentCount: 0,
  removalEvidenceFingerprint: '0'.repeat(32),
  diagnostics: { topology: { triangleCount: 0, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true }, repairDecision: 'accepted', rasterCellSizeMm: null, layers: [{ id: 'layer-0', simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0, areaEvidenceBasis: 'exact-slice-pre-simplification' }] },
};

export const workbenchResult: AutomaticOutlineResult = {
  ...baseResult,
  layers: Array.from({ length: 3 }, (_, index) => ({ ...baseResult.layers[0], id: `layer-${index}`, index, zStart: index, zEnd: index + 1 })),
  coloredLayers: Array.from({ length: 3 }, (_, index) => ({ ...coloredLayer, id: `layer-${index}`, index, zStart: index, zEnd: index + 1 })),
  preview: { ...baseResult.preview, layers: Array.from({ length: 3 }, (_, index) => ({ ...coloredLayer, id: `layer-${index}`, index, zStart: index, zEnd: index + 1 })) },
};
