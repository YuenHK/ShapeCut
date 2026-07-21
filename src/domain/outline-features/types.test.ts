import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { OutlineLayer } from '../outline-2.5d/extract';
import type { AutomaticOutlineResult } from '../pipeline/automatic-outline-pipeline';
import {
  featureEvidenceFingerprint,
  validateAutomaticColoredResult,
  validateColoredLayerShape,
  type ColoredOutlineLayer,
  type FeatureContour,
  type FeatureRole,
} from './types';

function contour(id: string, role: FeatureRole, outer: readonly Point2[]): FeatureContour {
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  const areaMm2 = Math.abs(outer.reduce((sum, point, index) => {
    const next = outer[(index + 1) % outer.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
  return {
    id,
    role,
    outer,
    boundsMm: {
      minX: Math.min(...xs), minY: Math.min(...ys),
      maxX: Math.max(...xs), maxY: Math.max(...ys),
    },
    areaMm2,
  };
}

function square(size: number, id = 'layer-0-exterior', role: FeatureRole = 'CUT_BLACK'): FeatureContour {
  const half = size / 2;
  return contour(id, role, [[-half, -half], [-half, half], [half, half], [half, -half]]);
}

function circle(radius: number, id = 'layer-0-hole', role: FeatureRole = 'CUT_BLACK'): FeatureContour {
  return contour(id, role, Array.from({ length: 8 }, (_, index) => {
    const angle = -index / 8 * Math.PI * 2;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  }));
}

function rectangle(width: number, height: number, id = 'layer-0-deep', role: FeatureRole = 'DEEP_RED'): FeatureContour {
  return contour(id, role, [
    [-width / 2, -height / 2], [-width / 2, height / 2],
    [width / 2, height / 2], [width / 2, -height / 2],
  ]);
}

function bowTie(id = 'layer-0-deep'): FeatureContour {
  return contour(id, 'DEEP_RED', [[-2, -1], [2, 1], [-2, 1], [2, -1]]);
}

function coloredLayer(overrides: Partial<ColoredOutlineLayer> = {}): ColoredOutlineLayer {
  return {
    id: 'outline-layer-0', index: 0, zStart: 0, zEnd: 1,
    exterior: square(20), centralHole: circle(2),
    deepFeature: rectangle(3, 2), lightFeature: undefined,
    removedComponentCount: 1,
    diagnostics: {
      hole: { status: 'retained', equivalentDiameterMm: 4, axisDistanceMm: 0.1 },
      depth: { cellSizeMm: 0.1, contrastMm: 0.8, redThresholdMm: 0.6, blueThresholdMm: 0.25 },
    },
    ...overrides,
  };
}

function legacyLayer(): OutlineLayer {
  return {
    id: 'outline-layer-0', index: 0, zStart: 0, zEnd: 1,
    contour: { outer: square(20).outer, holes: [] },
    sourceAreaMm2: 400, simplifiedAreaMm2: 400,
    sourceBoundsMm: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
    simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0,
    removedComponentCount: 1,
  };
}

function automaticResult(layer = coloredLayer()): AutomaticOutlineResult {
  const result = {
    sourceHash: 'a'.repeat(32),
    mode: 'exact' as const,
    status: 'success' as const,
    axis: {
      source: 'candidate' as const,
      axis: { origin: [0, 0, 0] as const, direction: [0, 0, 1] as const, confidence: 1, confirmed: true },
    },
    layers: [legacyLayer()],
    coloredLayers: [layer],
    featureWarnings: [],
    warnings: [],
    originalReport: {
      inspection: { triangleCount: 1, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, invertedVolume: false },
      duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0,
      selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true,
      boundaryEdges: [], nonManifoldEdges: [], degenerateTriangles: [], duplicateTriangles: [],
      inconsistentWindingEdges: [], selfIntersections: [],
      markersTruncated: {
        boundaryEdges: false, nonManifoldEdges: false, degenerateTriangles: false,
        duplicateTriangles: false, inconsistentWindingEdges: false, selfIntersections: false,
      },
    },
    repairAccepted: true,
    removedComponentCount: 1,
    removalEvidenceFingerprint: 'b'.repeat(32),
    diagnostics: {
      topology: { triangleCount: 1, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true },
      repairDecision: 'accepted' as const, rasterCellSizeMm: null,
      layers: [{ id: 'outline-layer-0', simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0, areaEvidenceBasis: 'exact-slice-pre-simplification' as const }],
    },
    preview: {
      mesh: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      axis: { origin: [0, 0, 0] as const, direction: [0, 0, 1] as const },
      layers: [layer],
    },
  };
  return { ...result, featureEvidenceFingerprint: featureEvidenceFingerprint(result) };
}

describe('colored outline contracts', () => {
  it('accepts the exact singular role structure', () => {
    const layer = coloredLayer();

    expect(validateColoredLayerShape(layer)).toEqual({ ok: true, reasons: [] });
  });

  it('rejects a forged self-intersecting role contour', () => {
    const result = automaticResult();
    const cloned = structuredClone(result);
    const forgedLayer = { ...cloned.coloredLayers[0], deepFeature: bowTie() };
    const forged = {
      ...cloned,
      coloredLayers: [forgedLayer],
      preview: { ...cloned.preview, layers: [forgedLayer] },
    };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/deep feature|self-intersection/i);
  });

  it('rejects role geometry forged into the migration-only exterior layers', () => {
    const layer = coloredLayer();
    const result = automaticResult(layer);
    const forged = structuredClone({ ...result, layers: [{ ...layer, deepFeature: bowTie() }] });

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/deep feature|self-intersection/i);
  });

  it('rejects generic role arrays and extra enumerable role geometry', () => {
    const layer = coloredLayer() as ColoredOutlineLayer & Record<string, unknown>;
    layer.holes = [circle(1, 'forged-hole')];
    layer.features = [rectangle(1, 1, 'forged-feature')];

    expect(validateColoredLayerShape(layer)).toEqual(expect.objectContaining({
      ok: false,
      reasons: expect.arrayContaining([expect.stringMatching(/unexpected.*holes/i), expect.stringMatching(/unexpected.*features/i)]),
    }));
  });

  it('rejects unsafe layer numbers, non-finite metadata, duplicate IDs, and incorrect roles', () => {
    const invalid = coloredLayer({
      index: Number.MAX_SAFE_INTEGER + 1,
      zEnd: Infinity,
      removedComponentCount: -1,
      deepFeature: { ...rectangle(3, 2), id: 'layer-0-exterior', role: 'LIGHT_BLUE' },
      diagnostics: {
        hole: { status: 'retained', equivalentDiameterMm: NaN, axisDistanceMm: -1 },
        depth: { cellSizeMm: 0.1, contrastMm: Infinity, redThresholdMm: 0.2, blueThresholdMm: 0.3 },
      },
    });

    const validation = validateColoredLayerShape(invalid);
    expect(validation.ok).toBe(false);
    expect(validation.reasons.join('\n')).toMatch(/safe integer|finite|removed component|duplicate|deep feature.*DEEP_RED|diagnostics/i);
  });

  it('rejects duplicate IDs and unordered layer records across an automatic result', () => {
    const first = coloredLayer();
    const second = coloredLayer({
      id: first.id,
      index: 0,
      zStart: -1,
      zEnd: 0,
      exterior: square(10, 'layer-1-exterior'),
      centralHole: undefined,
      deepFeature: undefined,
      diagnostics: {
        hole: { status: 'omitted' },
        depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
      },
    });
    const cloned = structuredClone(automaticResult(first));
    const forgedWithoutFingerprint = {
      ...cloned,
      coloredLayers: [first, second],
      preview: { ...cloned.preview, layers: [first, second] },
    };
    const forged = {
      ...forgedWithoutFingerprint,
      featureEvidenceFingerprint: featureEvidenceFingerprint(forgedWithoutFingerprint),
    };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/duplicate layer id|order/i);
  });

  it('rejects unsafe or inconsistent automatic component counts', () => {
    expect(() => validateAutomaticColoredResult({
      ...automaticResult(), removedComponentCount: 1.5,
    })).toThrow(/removed component count.*safe integer/i);
    expect(() => validateAutomaticColoredResult({
      ...automaticResult(), removedComponentCount: 0,
    })).toThrow(/removed component count.*layer records/i);
  });

  it('fails closed on expired validation work and mismatched migration layers', () => {
    expect(validateColoredLayerShape(coloredLayer(), 0)).toEqual(expect.objectContaining({
      ok: false, reasons: expect.arrayContaining([expect.stringMatching(/runtime budget/i)]),
    }));
    expect(() => validateAutomaticColoredResult({
      ...automaticResult(), layers: [],
    })).toThrow(/migration.*match.*colored/i);
  });

  it('requires the preview axis to match the selected automatic axis', () => {
    const result = automaticResult();
    const forged = {
      ...result,
      preview: { ...result.preview, axis: { ...result.preview.axis, origin: [1, 0, 0] } },
    };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/preview axis.*selected/i);
  });

  it('rejects non-finite or incorrectly typed preview triangle data', () => {
    const wrongPositions = structuredClone(automaticResult()) as unknown as {
      preview: { mesh: { positions: Float64Array; indices: Uint32Array } };
    };
    wrongPositions.preview.mesh.positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(() => validateAutomaticColoredResult(wrongPositions)).toThrow(/Float32Array/i);

    const nonFinite = structuredClone(automaticResult());
    nonFinite.preview.mesh.positions[1] = NaN;
    expect(() => validateAutomaticColoredResult(nonFinite)).toThrow(/finite preview positions/i);

    const triangleSource = structuredClone(automaticResult());
    const invalidTriangle = {
      ...triangleSource,
      preview: {
        ...triangleSource.preview,
        mesh: { ...triangleSource.preview.mesh, indices: new Uint32Array([0, 1, 3]) },
      },
    };
    expect(() => validateAutomaticColoredResult(invalidTriangle)).toThrow(/triangle indices/i);

    const roleArraySource = structuredClone(automaticResult());
    const previewLayer = {
      ...roleArraySource.preview.layers[0],
      features: [rectangle(1, 1, 'forged-preview-feature')],
    };
    const genericRoleArray = {
      ...roleArraySource,
      preview: { ...roleArraySource.preview, layers: [previewLayer] },
    };
    expect(() => validateAutomaticColoredResult(genericRoleArray)).toThrow(/unexpected.*features/i);
  });

  it('rejects missing, empty, or inconsistent feature evidence fingerprints', () => {
    const { featureEvidenceFingerprint: _fingerprint, ...missing } = structuredClone(automaticResult());
    expect(() => validateAutomaticColoredResult(missing)).toThrow(/feature.*fingerprint/i);

    expect(() => validateAutomaticColoredResult({
      ...automaticResult(), featureEvidenceFingerprint: '',
    })).toThrow(/feature.*fingerprint/i);
    expect(() => validateAutomaticColoredResult({
      ...automaticResult(), featureEvidenceFingerprint: '0'.repeat(32),
    })).toThrow(/feature.*fingerprint/i);
  });

  it('remains valid and preserves typed arrays after a structured clone', () => {
    const result = automaticResult();
    const cloned = structuredClone(result);

    expect(() => validateAutomaticColoredResult(cloned)).not.toThrow();
    expect(cloned.coloredLayers).toEqual(result.coloredLayers);
    expect(Array.from(cloned.preview.mesh.positions)).toEqual(Array.from(result.preview.mesh.positions));
    expect(Array.from(cloned.preview.mesh.indices)).toEqual(Array.from(result.preview.mesh.indices));
    expect(Object.prototype.toString.call(cloned.preview.mesh.positions)).toBe('[object Float32Array]');
    expect(Object.prototype.toString.call(cloned.preview.mesh.indices)).toBe('[object Uint32Array]');
    expect(cloned.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(cloned));
  });
});
