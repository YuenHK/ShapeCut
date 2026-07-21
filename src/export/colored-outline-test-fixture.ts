import { featureEvidenceFingerprint, type ColoredOutlineLayer, type FeatureContour } from '../domain/outline-features/types';
import {
  diagnosticsFingerprint,
  removalEvidenceFingerprint,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';

const SOURCE_HASH = '0123456789abcdef'.repeat(2);

function contour(
  id: string,
  role: FeatureContour['role'],
  outer: FeatureContour['outer'],
): FeatureContour {
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  const areaMm2 = Math.abs(outer.reduce((sum, point, index) => {
    const next = outer[(index + 1) % outer.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
  return {
    id, role, outer,
    boundsMm: {
      minX: Math.min(...xs), minY: Math.min(...ys),
      maxX: Math.max(...xs), maxY: Math.max(...ys),
    },
    areaMm2,
  };
}

export function coloredResult(): AutomaticOutlineResult {
  const coloredLayers: ColoredOutlineLayer[] = Array.from({ length: 6 }, (_, index) => {
    const offset = index * 30;
    const exterior = contour(
      `layer-${index + 1}-exterior`,
      'CUT_BLACK',
      [[offset - 10, -10], [offset - 10, 10], [offset + 10, 10], [offset + 10, -10]],
    );
    if (index !== 2) return {
      id: `layer-${index + 1}`,
      index,
      zStart: index * 2,
      zEnd: index * 2 + 2,
      exterior,
      removedComponentCount: 0,
      diagnostics: {
        hole: { status: 'omitted' },
        depth: { cellSizeMm: 0.25, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
      },
    };
    return {
      id: `layer-${index + 1}`,
      index,
      zStart: index * 2,
      zEnd: index * 2 + 2,
      exterior,
      centralHole: contour(
        `layer-${index + 1}-hole`,
        'CUT_BLACK',
        [[offset - 2, -2], [offset + 2, -2], [offset + 2, 2], [offset - 2, 2]],
      ),
      deepFeature: contour(
        `layer-${index + 1}-deep`,
        'DEEP_RED',
        [[offset - 8, -8], [offset - 8, -4], [offset - 4, -4], [offset - 4, -8]],
      ),
      lightFeature: contour(
        `layer-${index + 1}-light`,
        'LIGHT_BLUE',
        [[offset + 4, 4], [offset + 4, 8], [offset + 8, 8], [offset + 8, 4]],
      ),
      removedComponentCount: 0,
      diagnostics: {
        hole: { status: 'retained', equivalentDiameterMm: 4, axisDistanceMm: 0 },
        depth: { cellSizeMm: 0.25, contrastMm: 2, redThresholdMm: 1.5, blueThresholdMm: 0.5 },
      },
    };
  });
  const layers = coloredLayers.map((layer) => ({
    id: layer.id,
    index: layer.index,
    zStart: layer.zStart,
    zEnd: layer.zEnd,
    contour: { outer: layer.exterior.outer, holes: [] as const },
    sourceAreaMm2: layer.exterior.areaMm2,
    simplifiedAreaMm2: layer.exterior.areaMm2,
    sourceBoundsMm: { ...layer.exterior.boundsMm },
    simplificationToleranceMm: 0.01,
    boundsDriftRatio: 0,
    areaDriftRatio: 0,
    removedComponentCount: layer.removedComponentCount,
  }));
  const diagnostics = {
    topology: {
      triangleCount: 4, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0, duplicateTriangleCount: 0,
      inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0,
      selfIntersectionAnalysisComplete: true,
    },
    repairDecision: 'accepted' as const,
    rasterCellSizeMm: null,
    layers: layers.map(({ id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio }) => ({
      id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio,
      areaEvidenceBasis: 'exact-slice-pre-simplification' as const,
    })),
  };
  const base = {
    sourceHash: SOURCE_HASH,
    mode: 'exact' as const,
    status: 'success' as const,
    axis: {
      source: 'candidate' as const,
      axis: { origin: [60, 0, 0] as const, direction: [0, 0, 1] as const, confidence: 1, confirmed: true },
    },
    layers,
    coloredLayers,
    featureWarnings: [],
    preview: {
      mesh: {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: Uint32Array.from([0, 1, 2]),
      },
      axis: {
        origin: [60, 0, 0] as const,
        direction: [0, 0, 1] as const,
        planeX: [0, 1, 0] as const,
        planeY: [-1, 0, 0] as const,
      },
      layers: coloredLayers,
    },
    warnings: [],
    originalReport: {
      inspection: {
        triangleCount: 4, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0,
        degenerateTriangleCount: 0, invertedVolume: false,
      },
      duplicateTriangleCount: 0,
      inconsistentWindingEdgeCount: 0,
      selfIntersectionCount: 0,
      selfIntersectionAnalysisComplete: true,
      boundaryEdges: [], nonManifoldEdges: [], degenerateTriangles: [],
      duplicateTriangles: [], inconsistentWindingEdges: [], selfIntersections: [],
      markersTruncated: {
        boundaryEdges: false, nonManifoldEdges: false, degenerateTriangles: false,
        duplicateTriangles: false, inconsistentWindingEdges: false, selfIntersections: false,
      },
    },
    repairAccepted: true,
    removedComponentCount: 0,
    diagnostics,
  };
  const result = {
    ...base,
    removalEvidenceFingerprint: removalEvidenceFingerprint(base),
    featureEvidenceFingerprint: featureEvidenceFingerprint(base),
  };
  // Keep this assertion near the fixture: all package tests consume genuinely valid evidence.
  if (!/^[0-9a-f]{32}$/.test(diagnosticsFingerprint(result.diagnostics))) throw new Error('Invalid fixture diagnostics');
  return result;
}

function regularLoop(
  centerX: number,
  centerY: number,
  radius: number,
  pointCount: number,
  clockwise: boolean,
): readonly (readonly [number, number])[] {
  return Array.from({ length: pointCount }, (_, index) => {
    const angle = (clockwise ? -1 : 1) * index * Math.PI * 2 / pointCount;
    return [centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius] as const;
  });
}

/**
 * Test-only legal packaging workload: the 24-layer maximum, all four contours,
 * and 512 points per contour (49,152 segments). The 1,024-point variant took
 * 90.3 s on the acceptance host, so it cannot satisfy the 30 s worker boundary.
 */
export function nearLimitColoredResult(pointCount = 512): AutomaticOutlineResult {
  const seed = coloredResult(), layerCount = 24;
  const coloredLayers: ColoredOutlineLayer[] = Array.from({ length: layerCount }, (_, index) => {
    const id = `stress-layer-${index + 1}`;
    const exterior = contour(`${id}-exterior`, 'CUT_BLACK', regularLoop(0, 0, 20, pointCount, true));
    const centralHole = contour(`${id}-hole`, 'CUT_BLACK', regularLoop(0, 0, 3, pointCount, false));
    const deepFeature = contour(`${id}-deep`, 'DEEP_RED', regularLoop(-9, 0, 2, pointCount, true));
    const lightFeature = contour(`${id}-light`, 'LIGHT_BLUE', regularLoop(9, 0, 2, pointCount, true));
    return {
      id, index, zStart: index * 2, zEnd: index * 2 + 2,
      exterior, centralHole, deepFeature, lightFeature,
      removedComponentCount: 0,
      diagnostics: {
        hole: {
          status: 'retained',
          equivalentDiameterMm: 2 * Math.sqrt(centralHole.areaMm2 / Math.PI),
          axisDistanceMm: 0,
        },
        depth: { cellSizeMm: 0.25, contrastMm: 2, redThresholdMm: 1.5, blueThresholdMm: 0.5 },
      },
    };
  });
  const layers = coloredLayers.map((layer) => ({
    id: layer.id, index: layer.index, zStart: layer.zStart, zEnd: layer.zEnd,
    contour: { outer: layer.exterior.outer, holes: [] as const },
    sourceAreaMm2: layer.exterior.areaMm2,
    simplifiedAreaMm2: layer.exterior.areaMm2,
    sourceBoundsMm: { ...layer.exterior.boundsMm },
    simplificationToleranceMm: 0.01,
    boundsDriftRatio: 0,
    areaDriftRatio: 0,
    removedComponentCount: 0,
  }));
  const diagnostics = {
    ...seed.diagnostics,
    layers: layers.map(({ id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio }) => ({
      id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio,
      areaEvidenceBasis: 'exact-slice-pre-simplification' as const,
    })),
  };
  const base = {
    ...seed,
    axis: {
      source: 'candidate' as const,
      axis: { origin: [0, 0, 0] as const, direction: [0, 0, 1] as const, confidence: 1, confirmed: true },
    },
    layers,
    coloredLayers,
    preview: {
      ...seed.preview,
      axis: { ...seed.preview.axis, origin: [0, 0, 0] as const },
      layers: coloredLayers,
    },
    diagnostics,
  };
  return {
    ...base,
    removalEvidenceFingerprint: removalEvidenceFingerprint(base),
    featureEvidenceFingerprint: featureEvidenceFingerprint(base),
  };
}
