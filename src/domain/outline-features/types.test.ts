import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { OutlineLayer } from '../outline-2.5d/extract';
import type { AutomaticOutlineResult } from '../pipeline/automatic-outline-pipeline';
import { CENTRAL_HOLE_OMISSION_WARNING } from './hole';
import { FASTENER_OMISSION_WARNING } from '../outline-assembly/fasteners';
import {
  planFixedLauncherClearance,
  type FixedLauncherPlan,
} from '../outline-assembly/launcher';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../outline-assembly/launcher-template';
import {
  featureEvidenceFingerprint,
  migrateColoredOutlineLayer,
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

function circle48At(center: Point2, radius: number, id: string): FeatureContour {
  return contour(id, 'CUT_BLACK', Array.from({ length: 48 }, (_, index) => {
    const angle = index * Math.PI * 2 / 48;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius] as const;
  }));
}

function rectangle(width: number, height: number, id = 'layer-0-deep', role: FeatureRole = 'DEEP_RED'): FeatureContour {
  const left = -8;
  return contour(id, role, [
    [left, -height / 2], [left, height / 2],
    [left + width, height / 2], [left + width, -height / 2],
  ]);
}

function bowTie(id = 'layer-0-deep'): FeatureContour {
  return contour(id, 'DEEP_RED', [[-2, -1], [2, 1], [-2, 1], [2, -1]]);
}

function coloredLayer(overrides: Partial<ColoredOutlineLayer> = {}): ColoredOutlineLayer {
  return {
    id: 'outline-layer-0', index: 0, zStart: 0, zEnd: 1,
    exterior: square(20), centralHole: circle(2),
    launcherCuts: [], fastenerHoles: [],
    deepFeatures: [rectangle(3, 2)], lightFeatures: [],
    removedComponentCount: 1,
    diagnostics: {
      hole: { status: 'retained', equivalentDiameterMm: 4, axisDistanceMm: 0.1 },
      depth: { cellSizeMm: 0.1, contrastMm: 0.8, redThresholdMm: 0.6, blueThresholdMm: 0.25 },
    },
    ...overrides,
  };
}

function indexedColoredLayer(index: number): ColoredOutlineLayer {
  return coloredLayer({
    id: `outline-layer-${index}`,
    index,
    zStart: index,
    zEnd: index + 1,
    exterior: square(60, `layer-${index}-exterior`),
    centralHole: circle(2, `layer-${index}-hole`),
    deepFeatures: [rectangle(3, 2, `layer-${index}-deep`)],
  });
}

function coloredLayerSet(count: number): readonly ColoredOutlineLayer[] {
  return Array.from({ length: count }, (_, index) => indexedColoredLayer(index));
}

function legacyLayer(layer = indexedColoredLayer(0)): OutlineLayer {
  return {
    id: layer.id, index: layer.index, zStart: layer.zStart, zEnd: layer.zEnd,
    contour: { outer: layer.exterior.outer, holes: [] },
    sourceAreaMm2: layer.exterior.areaMm2, simplifiedAreaMm2: layer.exterior.areaMm2,
    sourceBoundsMm: layer.exterior.boundsMm,
    simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0,
    removedComponentCount: layer.removedComponentCount,
  };
}

let cachedOfficialLauncher: FixedLauncherPlan | undefined;

function automaticResult(sourceLayers = coloredLayerSet(6)): AutomaticOutlineResult {
  const material = { id: 'test', name: 'Test', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
  const launcher = cachedOfficialLauncher ??= planFixedLauncherClearance({
    axisPoint: [0, 0],
    topExterior: square(60, 'launcher-plan-top'),
    secondExterior: square(60, 'launcher-plan-second'),
    topCentralHole: circle(2, 'launcher-plan-top-hole'),
    secondCentralHole: circle(2, 'launcher-plan-second-hole'),
    material,
    fitOffsetMm: 0,
  });
  const coloredLayers = sourceLayers.map((layer, layerIndex) => ({
    ...layer,
    launcherCuts: layerIndex < sourceLayers.length - 2 ? [] : launcher.cuts.map((cut, index) => ({
      ...cut,
      id: `${layer.id}-launcher-clearance-${index + 1}`,
    })),
  }));
  const result = {
    sourceHash: 'a'.repeat(32),
    material,
    assembly: {
      material,
      launcher: {
        status: 'fixed' as const,
        cutCount: 3 as const,
        templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
        templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
        rotationRad: launcher.rotationRad,
        fitOffsetMm: launcher.fitOffsetMm,
        finishedAllowanceMm: launcher.finishedAllowanceMm,
      },
      fastener: { count: 0 as const, centers: [], finishedDiameterMm: 3 as const, pathDiameterMm: 2.9 },
      topFeatures: {
        retained: { red: coloredLayers.at(-1)?.deepFeatures.length ?? 0, blue: coloredLayers.at(-1)?.lightFeatures.length ?? 0 },
        omitted: coloredLayers.at(-1)?.diagnostics.depth.omitted ?? { red: 0, blue: 0 },
        launcherOverlap: {
          clipped: { red: 0, blue: 0 },
          removed: { red: 0, blue: 0 },
        },
      },
    },
    mode: 'exact' as const,
    status: 'success' as const,
    axis: {
      source: 'candidate' as const,
      axis: { origin: [0, 0, 0] as const, direction: [0, 0, 1] as const, confidence: 1, confirmed: true },
    },
    layers: coloredLayers.map((layer) => legacyLayer(layer)),
    coloredLayers,
    featureWarnings: [FASTENER_OMISSION_WARNING],
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
    removedComponentCount: coloredLayers.reduce((sum, layer) => sum + layer.removedComponentCount, 0),
    removalEvidenceFingerprint: 'b'.repeat(32),
    diagnostics: {
      topology: { triangleCount: 1, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true },
      repairDecision: 'accepted' as const, rasterCellSizeMm: null,
      layers: coloredLayers.map((layer) => ({ id: layer.id, simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0, areaEvidenceBasis: 'exact-slice-pre-simplification' as const })),
    },
    preview: {
      mesh: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
      axis: {
        origin: [0, 0, 0] as const,
        direction: [0, 0, 1] as const,
        planeX: [0, 1, 0] as const,
        planeY: [-1, 0, 0] as const,
      },
      layers: coloredLayers,
    },
  };
  return { ...result, featureEvidenceFingerprint: featureEvidenceFingerprint(result) };
}

function withSharedHoleEvidence(
  result: AutomaticOutlineResult,
  coloredLayers: readonly ColoredOutlineLayer[],
  featureWarnings: readonly string[] = result.featureWarnings,
): AutomaticOutlineResult {
  const reconciledWarnings = [...new Set([
    ...featureWarnings,
    FASTENER_OMISSION_WARNING,
  ])];
  const changed = {
    ...result,
    coloredLayers,
    featureWarnings: reconciledWarnings,
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function featureSeries(
  role: Extract<FeatureRole, 'DEEP_RED' | 'LIGHT_BLUE'>,
  count: number,
  prefix: string,
): readonly FeatureContour[] {
  return Array.from({ length: count }, (_, index) => contour(`${prefix}-${index}`, role, [
    [-9 + index * 1.4, -1], [-9 + index * 1.4, 1],
    [-8 + index * 1.4, 1], [-8 + index * 1.4, -1],
  ]));
}

function withFeatureCounts(topDeep: number, lowerDeep: number): AutomaticOutlineResult {
  const source = automaticResult();
  const coloredLayers = source.coloredLayers.map((layer, index) => ({
    ...layer,
    deepFeatures: index === source.coloredLayers.length - 1
      ? featureSeries('DEEP_RED', topDeep, `top-deep-${index}`)
      : index === 0
        ? featureSeries('DEEP_RED', lowerDeep, `lower-deep-${index}`)
        : layer.deepFeatures,
  }));
  const top = coloredLayers.at(-1)!;
  const changed = {
    ...source,
    assembly: {
      ...source.assembly,
      topFeatures: {
        retained: { red: top.deepFeatures.length, blue: top.lightFeatures.length },
        omitted: top.diagnostics.depth.omitted ?? { red: 0, blue: 0 },
        launcherOverlap: source.assembly.topFeatures.launcherOverlap,
      },
    },
    coloredLayers,
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function withThreeFasteners(): AutomaticOutlineResult {
  const source = automaticResult();
  const radiusMm = 5, rotationRad = 0, pathDiameterMm = 2.9;
  const centers = [0, 1, 2].map((index): Point2 => {
    const angle = rotationRad + index * Math.PI * 2 / 3;
    return [Math.cos(angle) * radiusMm, Math.sin(angle) * radiusMm];
  });
  const coloredLayers = source.coloredLayers.map((layer) => ({
    ...layer,
    fastenerHoles: centers.map((center, index) => (
      circle48At(center, pathDiameterMm / 2, `${layer.id}-fastener-hole-${index + 1}`)
    )),
  }));
  const changed = {
    ...source,
    assembly: {
      ...source.assembly,
      fastener: {
        count: 3 as const, centers, finishedDiameterMm: 3 as const,
        pathDiameterMm, radiusMm, rotationRad,
      },
    },
    coloredLayers,
    featureWarnings: source.featureWarnings.filter((warning) => warning !== FASTENER_OMISSION_WARNING),
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function repositionThreeFasteners(
  source: AutomaticOutlineResult,
  radiusMm: number,
  rotationRad = 0,
): AutomaticOutlineResult {
  const centers = [0, 1, 2].map((index): Point2 => {
    const angle = rotationRad + index * Math.PI * 2 / 3;
    return [Math.cos(angle) * radiusMm, Math.sin(angle) * radiusMm];
  });
  const coloredLayers = source.coloredLayers.map((layer) => ({
    ...layer,
    fastenerHoles: centers.map((center, index) => circle48At(
      center,
      source.assembly.fastener.pathDiameterMm / 2,
      layer.fastenerHoles[index].id,
    )),
  }));
  const changed = {
    ...source,
    assembly: {
      ...source.assembly,
      fastener: { ...source.assembly.fastener, centers, radiusMm, rotationRad },
    },
    coloredLayers,
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function omitCentralHoleEvidence(source: AutomaticOutlineResult): AutomaticOutlineResult {
  const coloredLayers = source.coloredLayers.map(({ centralHole: _centralHole, ...layer }) => ({
    ...layer,
    diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
  }));
  const changed = {
    ...source,
    coloredLayers,
    featureWarnings: [...source.featureWarnings, CENTRAL_HOLE_OMISSION_WARNING],
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function overlapLauncherWithFasteners(source: AutomaticOutlineResult): AutomaticOutlineResult {
  const topStart = source.coloredLayers.length - 2;
  const referenceCuts = source.assembly.fastener.centers.map((center, index) => (
    circle48At(center, 0.75, `launcher-reference-${index + 1}`)
  ));
  const coloredLayers = source.coloredLayers.map((layer, layerIndex) => ({
    ...layer,
    launcherCuts: layerIndex < topStart ? [] : referenceCuts.map((cut, index) => ({
      ...cut,
      id: `${layer.id}-launcher-clearance-${index + 1}`,
    })),
  }));
  const changed = {
    ...source,
    assembly: {
      ...source.assembly,
      launcher: source.assembly.launcher,
    },
    coloredLayers,
    featureWarnings: source.featureWarnings,
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function engravingBox(id: string, minX: number, maxX: number, minY: number, maxY: number): FeatureContour {
  return contour(id, 'DEEP_RED', [
    [minX, minY], [minX, maxY], [maxX, maxY], [maxX, minY],
  ]);
}

function replaceLayerEngraving(
  source: AutomaticOutlineResult,
  layerIndex: number,
  feature: FeatureContour,
): AutomaticOutlineResult {
  const coloredLayers = source.coloredLayers.map((layer, index) => index === layerIndex
    ? { ...layer, deepFeatures: [{ ...feature, id: `${layer.id}-${feature.id}` }] }
    : layer);
  const changed = {
    ...source,
    coloredLayers,
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function withLauncherCenters(centers: readonly Point2[]): AutomaticOutlineResult {
  const source = automaticResult();
  const topStart = source.coloredLayers.length - 2;
  const coloredLayers = source.coloredLayers.map((layer, layerIndex) => ({
    ...layer,
    launcherCuts: layerIndex < topStart ? [] : centers.map((center, index) => (
      circle48At(center, 0.4, `${layer.id}-launcher-clearance-${index + 1}`)
    )),
  }));
  const changed = {
    ...source,
    assembly: {
      ...source.assembly,
      launcher: source.assembly.launcher,
    },
    coloredLayers,
    featureWarnings: source.featureWarnings,
    preview: { ...source.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function safeLauncherResult(): AutomaticOutlineResult {
  return automaticResult();
}

describe('colored outline contracts', () => {
  function legacyLayerBase(): Record<string, unknown> {
    const { deepFeatures: _deepFeatures, lightFeatures: _lightFeatures,
      launcherCuts: _launcherCuts, fastenerHoles: _fastenerHoles, ...legacyBase } = coloredLayer();
    return legacyBase;
  }

  it('migrates a zero-feature legacy layer to empty canonical arrays', () => {
    expect(migrateColoredOutlineLayer(legacyLayerBase())).toMatchObject({
      launcherCuts: [], fastenerHoles: [], deepFeatures: [], lightFeatures: [],
    });
  });

  it('migrates legacy singular colored contours into canonical ordered arrays', () => {
    const legacy = {
      ...legacyLayerBase(),
      deepFeature: rectangle(3, 2, 'legacy-deep'),
      lightFeature: contour('legacy-light', 'LIGHT_BLUE', [[3, -1], [3, 1], [5, 1], [5, -1]]),
    };

    expect(migrateColoredOutlineLayer(legacy)).toMatchObject({
      deepFeatures: [legacy.deepFeature],
      lightFeatures: [legacy.lightFeature],
      launcherCuts: [],
      fastenerHoles: [],
    });
    expect(migrateColoredOutlineLayer(legacy)).not.toHaveProperty('deepFeature');
    expect(migrateColoredOutlineLayer(legacy)).not.toHaveProperty('lightFeature');
  });

  it('rejects cross-role mixing between legacy and canonical engraving fields', () => {
    expect(() => migrateColoredOutlineLayer({
      ...legacyLayerBase(),
      deepFeature: rectangle(1, 1, 'legacy-deep'),
      lightFeatures: [],
    })).toThrow(/legacy.*canonical|mixed/i);
    expect(() => migrateColoredOutlineLayer({
      ...legacyLayerBase(),
      deepFeatures: [],
      lightFeature: contour('legacy-light', 'LIGHT_BLUE', [[3, -1], [3, 1], [5, 1], [5, -1]]),
    })).toThrow(/legacy.*canonical|mixed/i);
  });

  it.each([
    { deepFeature: rectangle(1, 1, 'legacy-deep'), deepFeatures: [] },
    { lightFeature: contour('legacy-light', 'LIGHT_BLUE', [[3, -1], [3, 1], [5, 1], [5, -1]]), lightFeatures: [] },
  ])('rejects same-role mixing between legacy and canonical engraving fields', (mixed) => {
    expect(() => migrateColoredOutlineLayer({ ...legacyLayerBase(), ...mixed }))
      .toThrow(/legacy.*canonical|mixed/i);
  });

  it.each([
    ['deep features', { deepFeatures: 'bad' }],
    ['launcher cuts', { launcherCuts: {} }],
    ['explicit undefined', { lightFeatures: undefined }],
  ])('rejects present malformed canonical %s instead of erasing it during migration', (_label, malformed) => {
    expect(() => migrateColoredOutlineLayer({ ...legacyLayerBase(), ...malformed }))
      .toThrow(/canonical.*array|array.*canonical/i);
  });

  it('bounds top and lower engraving arrays independently', () => {
    expect(() => validateAutomaticColoredResult(withFeatureCounts(13, 1))).toThrow(/12.*deep/i);
    expect(() => validateAutomaticColoredResult(withFeatureCounts(1, 2))).toThrow(/one.*deep/i);
  });

  it.each([
    ['templateVersion', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { templateVersion: number }).templateVersion += 1;
    }],
    ['templateFingerprint', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { templateFingerprint: string }).templateFingerprint = 'f'.repeat(32);
    }],
    ['rotationRad', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { rotationRad: number }).rotationRad += 0.01;
    }],
    ['fitOffsetMm', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { fitOffsetMm: number }).fitOffsetMm += 0.01;
    }],
    ['finishedAllowanceMm', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { finishedAllowanceMm: number }).finishedAllowanceMm += 0.01;
    }],
    ['launcherOverlap.clipped.red', (result: AutomaticOutlineResult) => {
      (result.assembly.topFeatures.launcherOverlap.clipped as { red: number }).red += 1;
    }],
    ['launcherOverlap.clipped.blue', (result: AutomaticOutlineResult) => {
      (result.assembly.topFeatures.launcherOverlap.clipped as { blue: number }).blue += 1;
    }],
    ['launcherOverlap.removed.red', (result: AutomaticOutlineResult) => {
      (result.assembly.topFeatures.launcherOverlap.removed as { red: number }).red += 1;
    }],
    ['launcherOverlap.removed.blue', (result: AutomaticOutlineResult) => {
      (result.assembly.topFeatures.launcherOverlap.removed as { blue: number }).blue += 1;
    }],
  ])('rejects mutated fixed canonical assembly evidence at %s', (_field, mutate) => {
    const forged = structuredClone(safeLauncherResult());
    mutate(forged);
    expect(() => validateAutomaticColoredResult(forged)).toThrow(/launcher|fingerprint|assembly/i);
  });

  it.each([
    ['rotation', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { rotationRad: number }).rotationRad += 0.01;
    }],
    ['coherent fit and finished allowance', (result: AutomaticOutlineResult) => {
      (result.assembly.launcher as { fitOffsetMm: number }).fitOffsetMm += 0.01;
      (result.assembly.launcher as { finishedAllowanceMm: number }).finishedAllowanceMm += 0.01;
    }],
  ])('rejects recomputed-fingerprint fixed launcher %s metadata that disagrees with its cuts', (_label, mutate) => {
    const changed = structuredClone(safeLauncherResult());
    mutate(changed);
    const forged = { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };

    expect(forged.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(forged));
    expect(() => validateAutomaticColoredResult(forged)).toThrow(/launcher.*template|placement|geometry/i);
  });

  it('rejects a colored layer that mixes legacy and canonical feature fields', () => {
    const source = automaticResult();
    const coloredLayers = source.coloredLayers.map((layer, index) => index === 0
      ? { ...layer, deepFeature: rectangle(1, 1, 'unexpected-legacy-deep') }
      : layer);
    const changed = { ...source, coloredLayers, preview: { ...source.preview, layers: coloredLayers } };
    const forged = { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/unexpected|legacy/i);
  });

  it('bounds black cut arrays, enforces their role, and keeps IDs globally unique', () => {
    const source = automaticResult();
    const first = source.coloredLayers[0];
    const launcherCuts = Array.from({ length: 4 }, (_, index) => circle(0.25, `launcher-${index}`));
    const fastenerHoles = Array.from({ length: 4 }, (_, index) => ({
      ...circle(0.25, index === 0 ? 'launcher-0' : `fastener-${index}`),
      role: index === 0 ? 'LIGHT_BLUE' as const : 'CUT_BLACK' as const,
    }));
    const coloredLayers = [{ ...first, launcherCuts, fastenerHoles }, ...source.coloredLayers.slice(1)];
    const changed = { ...source, coloredLayers, preview: { ...source.preview, layers: coloredLayers } };
    const forged = { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/launcher.*3.*fastener.*3.*CUT_BLACK.*duplicate/i);
  });

  it('fingerprints ordered multi-contour geometry and requires preview equality', () => {
    const source = withFeatureCounts(2, 1);
    const top = source.coloredLayers.at(-1)!;
    const reordered = { ...top, deepFeatures: [...top.deepFeatures].reverse() };
    const mismatched = {
      ...source,
      coloredLayers: [...source.coloredLayers.slice(0, -1), reordered],
    };
    const ordered = {
      ...mismatched,
      preview: { ...source.preview, layers: [...source.preview.layers.slice(0, -1), reordered] },
    };
    const fingerprint = featureEvidenceFingerprint(ordered);
    const geometryChanged = {
      ...ordered,
      coloredLayers: [...ordered.coloredLayers.slice(0, -1), {
        ...reordered,
        deepFeatures: reordered.deepFeatures.map((feature, index) => index === 0
          ? {
            ...feature,
            outer: feature.outer.map(([x, y]) => [x + 0.1, y] as const),
            boundsMm: { ...feature.boundsMm, minX: feature.boundsMm.minX + 0.1, maxX: feature.boundsMm.maxX + 0.1 },
          }
          : feature),
      }],
    };

    expect(fingerprint).not.toBe(source.featureEvidenceFingerprint);
    expect(featureEvidenceFingerprint(geometryChanged)).not.toBe(fingerprint);
    expect(() => validateAutomaticColoredResult({ ...ordered, featureEvidenceFingerprint: fingerprint })).not.toThrow();
    expect(() => validateAutomaticColoredResult({
      ...ordered,
      featureEvidenceFingerprint: fingerprint,
      preview: source.preview,
    })).toThrow(/preview.*match/i);
  });

  it('accepts the canonical bounded role arrays', () => {
    const layer = coloredLayer();

    expect(validateColoredLayerShape(layer)).toEqual({ ok: true, reasons: [] });
  });

  it('rejects a fingerprint-consistent mixed retain/omit shared-hole decision', () => {
    const source = automaticResult();
    const omitted = {
      ...source.coloredLayers[1],
      centralHole: undefined,
      diagnostics: { ...source.coloredLayers[1].diagnostics, hole: { status: 'omitted' as const } },
    };
    const coloredLayers = [...source.coloredLayers];
    coloredLayers[1] = omitted;

    expect(() => validateAutomaticColoredResult(withSharedHoleEvidence(source, coloredLayers)))
      .toThrow(/shared central hole.*(?:every layer|mixed|retain.*omit)/i);
  });

  it.each([
    ['shifted', (hole: FeatureContour) => contour(
      hole.id,
      'CUT_BLACK',
      hole.outer.map(([x, y]) => [x + 0.25, y] as const),
    )],
    ['resized', (hole: FeatureContour) => circle(1.5, hole.id)],
  ])('rejects a fingerprint-consistent %s shared-hole contour', (_label, mutate) => {
    const source = automaticResult();
    const changed = {
      ...source.coloredLayers[2],
      centralHole: mutate(source.coloredLayers[2].centralHole!),
    };
    const coloredLayers = [...source.coloredLayers];
    coloredLayers[2] = changed;

    expect(() => validateAutomaticColoredResult(withSharedHoleEvidence(source, coloredLayers)))
      .toThrow(/shared central holes.*identical.*model space/i);
  });

  it('requires exact warning provenance for the all-layer shared-hole decision', () => {
    const retained = automaticResult();
    expect(() => validateAutomaticColoredResult(withSharedHoleEvidence(
      retained,
      retained.coloredLayers,
      [CENTRAL_HOLE_OMISSION_WARNING],
    ))).toThrow(/shared central hole.*omission warning/i);

    const omittedLayers = retained.coloredLayers.map((layer) => ({
      ...layer,
      centralHole: undefined,
      diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
    }));
    expect(() => validateAutomaticColoredResult(withSharedHoleEvidence(retained, omittedLayers, [])))
      .toThrow(/shared central hole.*omission warning/i);
    expect(() => validateAutomaticColoredResult(withSharedHoleEvidence(
      retained,
      omittedLayers,
      [CENTRAL_HOLE_OMISSION_WARNING],
    ))).not.toThrow();
  });

  it('rejects a forged self-intersecting role contour', () => {
    const result = automaticResult();
    const cloned = structuredClone(result);
    const forgedLayer = { ...cloned.coloredLayers[0], deepFeatures: [bowTie()] };
    const forged = {
      ...cloned,
      coloredLayers: [forgedLayer, ...cloned.coloredLayers.slice(1)],
      preview: { ...cloned.preview, layers: [forgedLayer, ...cloned.preview.layers.slice(1)] },
    };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/deep feature|self-intersection/i);
  });

  it('rejects a fingerprint-consistent central hole whose edges leave a concave exterior', () => {
    const concaveExterior = contour('layer-0-exterior', 'CUT_BLACK', [
      [-5, -5], [-5, 5], [-2, 5], [-2, -2],
      [2, -2], [2, 5], [5, 5], [5, -5],
    ]);
    const crossingHole = contour('layer-0-hole', 'CUT_BLACK', [
      [-3, 0], [-3, 1], [3, 1], [3, 0],
    ]);
    const forgedLayer = coloredLayer({
      exterior: concaveExterior,
      centralHole: crossingHole,
      deepFeatures: [],
      lightFeatures: [],
      diagnostics: {
        hole: { status: 'retained', equivalentDiameterMm: 2, axisDistanceMm: 4.5 },
        depth: { cellSizeMm: 0.1, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
      },
    });
    const forged = automaticResult([forgedLayer, ...coloredLayerSet(6).slice(1)]);

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/central hole.*contain|clearance|exterior/i);
  });

  it('rejects role geometry forged into the migration-only exterior layers', () => {
    const layer = coloredLayer();
    const result = automaticResult([layer]);
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
      deepFeatures: [{ ...rectangle(3, 2), id: 'layer-0-exterior', role: 'LIGHT_BLUE' }],
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
      deepFeatures: [],
      diagnostics: {
        hole: { status: 'omitted' },
        depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
      },
    });
    const cloned = structuredClone(automaticResult([first]));
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

  it.each([1, 5])('rejects %i-layer colored, preview, and migration truncation', (count) => {
    expect(() => validateAutomaticColoredResult(automaticResult(coloredLayerSet(count))))
      .toThrow(/colored result.*6.*24/i);

    const valid = automaticResult();
    expect(() => validateAutomaticColoredResult({
      ...valid, preview: { ...valid.preview, layers: valid.preview.layers.slice(0, count) },
    })).toThrow(/preview layers.*6.*24/i);
    expect(() => validateAutomaticColoredResult({
      ...valid, layers: valid.layers.slice(0, count),
    })).toThrow(/migration exterior layers.*6.*24/i);
  });

  it('accepts 24 ordered layers and rejects 25', () => {
    expect(() => validateAutomaticColoredResult(automaticResult(coloredLayerSet(24)))).not.toThrow();
    expect(() => validateAutomaticColoredResult(automaticResult(coloredLayerSet(25))))
      .toThrow(/colored result.*6.*24/i);
  });

  it('requires the preview axis to match the selected automatic axis', () => {
    const result = automaticResult();
    const forged = {
      ...result,
      preview: { ...result.preview, axis: { ...result.preview.axis, origin: [1, 0, 0] } },
    };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/preview axis.*selected/i);
  });

  it('requires the deterministic extraction basis and fingerprints it', () => {
    const result = automaticResult();
    const forgedWithoutFingerprint = {
      ...result,
      preview: {
        ...result.preview,
        axis: { ...result.preview.axis, planeX: [1, 0, 0] as const },
      },
    };
    const forged = {
      ...forgedWithoutFingerprint,
      featureEvidenceFingerprint: featureEvidenceFingerprint(forgedWithoutFingerprint),
    };

    expect(forged.featureEvidenceFingerprint).not.toBe(result.featureEvidenceFingerprint);
    expect(() => validateAutomaticColoredResult(forged)).toThrow(/preview axis.*basis/i);
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
      preview: {
        ...roleArraySource.preview,
        layers: [previewLayer, ...roleArraySource.preview.layers.slice(1)],
      },
    };
    expect(() => validateAutomaticColoredResult(genericRoleArray)).toThrow(/unexpected.*features/i);
  });

  it('stops preview verification immediately when position or index deadlines expire', () => {
    const originalNow = Date.now;
    try {
      let now = 0;
      Date.now = () => now;
      const positionSource = structuredClone(automaticResult());
      const positionMesh = { ...positionSource.preview.mesh };
      Object.defineProperty(positionMesh, 'positions', {
        enumerable: true,
        get: () => {
          now = 2;
          return positionSource.preview.mesh.positions;
        },
      });
      Object.defineProperty(positionMesh, 'indices', {
        enumerable: true,
        get: () => { throw new Error('indices traversal started after expiry'); },
      });
      expect(() => validateAutomaticColoredResult({
        ...positionSource,
        preview: { ...positionSource.preview, mesh: positionMesh },
      }, 1)).toThrow(/runtime budget/i);

      now = 0;
      const indexSource = structuredClone(automaticResult());
      const indexMesh = { ...indexSource.preview.mesh };
      Object.defineProperty(indexMesh, 'indices', {
        enumerable: true,
        get: () => {
          now = 2;
          return indexSource.preview.mesh.indices;
        },
      });
      const indexPreview = { ...indexSource.preview, mesh: indexMesh };
      Object.defineProperty(indexPreview, 'axis', {
        enumerable: true,
        get: () => { throw new Error('axis verification started after expiry'); },
      });
      expect(() => validateAutomaticColoredResult({ ...indexSource, preview: indexPreview }, 1))
        .toThrow(/runtime budget/i);
    } finally {
      Date.now = originalNow;
    }
  });

  it('stops result validation immediately after an earlier layer detects expiry', () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      const source = structuredClone(automaticResult());
      const exterior = { ...source.coloredLayers[0].exterior };
      Object.defineProperty(exterior, 'outer', {
        enumerable: true,
        get: () => {
          now = 2;
          return source.coloredLayers[0].exterior.outer;
        },
      });
      const coloredLayers = [...source.coloredLayers];
      coloredLayers[0] = { ...coloredLayers[0], exterior };
      Object.defineProperty(coloredLayers, 1, {
        enumerable: true,
        get: () => { throw new Error('later layer validation started after expiry'); },
      });

      expect(() => validateAutomaticColoredResult({ ...source, coloredLayers }, 1))
        .toThrow(/runtime budget/i);
    } finally {
      Date.now = originalNow;
    }
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

  it('rejects fingerprint-consistent omission evidence without its sanitized warning', () => {
    const source = structuredClone(automaticResult());
    const omittedLayer = {
      ...source.coloredLayers[0],
      deepFeatures: [],
      diagnostics: {
        ...source.coloredLayers[0].diagnostics,
        depth: {
          cellSizeMm: 0.1,
          contrastMm: 0,
          redThresholdMm: 2,
          blueThresholdMm: 2,
          omissionCode: 'INSUFFICIENT_CONTRAST' as const,
        },
      },
    };
    const forgedWithoutFingerprint = {
      ...source,
      coloredLayers: [omittedLayer, ...source.coloredLayers.slice(1)],
      preview: { ...source.preview, layers: [omittedLayer, ...source.preview.layers.slice(1)] },
      featureWarnings: [],
    };
    const forged = {
      ...forgedWithoutFingerprint,
      featureEvidenceFingerprint: featureEvidenceFingerprint(forgedWithoutFingerprint),
    };

    expect(() => validateAutomaticColoredResult(forged)).toThrow(/omission.*warning|warning.*omission/i);
  });

  it('rejects unsanitized feature warnings even when role fingerprints remain valid', () => {
    const source = automaticResult();

    expect(() => validateAutomaticColoredResult({
      ...source,
      featureWarnings: ['/Users/example/private-source.stl', 'operator@example.test'],
    })).toThrow(/sanitized feature warning/i);
  });

  it('fails closed with a domain RangeError for a malformed colored layer carrying no diagnostics', () => {
    const source = automaticResult();

    expect(() => validateAutomaticColoredResult({
      ...source,
      coloredLayers: [null, ...source.coloredLayers.slice(1)],
    })).toThrow(RangeError);
  });

  it('uses the supplied absolute deadline for fingerprint generation and validation', () => {
    const result = automaticResult();
    expect(() => featureEvidenceFingerprint(result, 0)).toThrow(/runtime budget/i);

    const originalNow = Date.now;
    let now = 0;
    const forged = { ...result };
    Object.defineProperty(forged, 'featureEvidenceFingerprint', {
      enumerable: true,
      get: () => {
        now = 2;
        return result.featureEvidenceFingerprint;
      },
    });
    Date.now = () => now;
    try {
      expect(() => validateAutomaticColoredResult(forged, 1)).toThrow(/runtime budget/i);
    } finally {
      Date.now = originalNow;
    }
  });

  it('remains valid and preserves typed arrays after a structured clone', () => {
    const result = automaticResult();
    const cloned = structuredClone(result);

    expect(() => validateAutomaticColoredResult(cloned)).not.toThrow();
    expect(cloned.coloredLayers).toEqual(result.coloredLayers);
    expect(Array.from(cloned.preview.mesh.positions)).toEqual(Array.from(result.preview.mesh.positions));
    expect(Array.from(cloned.preview.mesh.indices)).toEqual(Array.from(result.preview.mesh.indices));
    expect(cloned.preview.axis.planeX).toEqual(result.preview.axis.planeX);
    expect(cloned.preview.axis.planeY).toEqual(result.preview.axis.planeY);
    expect(Object.prototype.toString.call(cloned.preview.mesh.positions)).toBe('[object Float32Array]');
    expect(Object.prototype.toString.call(cloned.preview.mesh.indices)).toBe('[object Uint32Array]');
    expect(cloned.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(cloned));
  });

  it('polls late fastener-circle reconciliation and preserves the exact caller cancellation', () => {
    const result = withThreeFasteners();
    expect(() => validateAutomaticColoredResult(result)).not.toThrow();
    const cancellation = new Error('cancel during late fastener point reconciliation');
    let pointPolls = 0;
    expect(() => validateAutomaticColoredResult(result, Infinity, (label?: string) => {
      if (label === 'assembly:fastener-point-loop' && ++pointPolls === 2) throw cancellation;
    })).toThrow(cancellation);
    expect(pointPolls).toBe(2);
  });

  it.each([
    // 2.04 mm remains around the 1.5 mm finished radius: minWeb alone would pass,
    // but the required extra 0.05 mm kerf loss must reject it.
    ['exterior web plus kerf loss', () => repositionThreeFasteners(withThreeFasteners(), 27.96)],
    ['central-hole web', () => repositionThreeFasteners(withThreeFasteners(), 3)],
    ['launcher-cut web', () => overlapLauncherWithFasteners(withThreeFasteners())],
    ['pairwise web', () => repositionThreeFasteners(omitCentralHoleEvidence(withThreeFasteners()), 1)],
  ])('rejects a self-consistent recomputed fastener forgery that violates %s safety', (_label, forge) => {
    const forged = forge();
    expect(forged.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(forged));
    expect(() => validateAutomaticColoredResult(forged, Infinity, () => undefined, forged.material))
      .toThrow(/fastener.*physical safety|clearance|separation/i);
  });

  it('polls bounded physical-safety reconciliation and preserves the exact caller cancellation', () => {
    const result = withThreeFasteners();
    const cancellation = new Error('cancel during protected-region safety reconciliation');
    let safetyPolls = 0;
    expect(() => validateAutomaticColoredResult(result, Infinity, (label?: string) => {
      if (label === 'assembly:fastener-protected-region-loop' && ++safetyPolls === 2) throw cancellation;
    }, result.material)).toThrow(cancellation);
    expect(safetyPolls).toBe(2);
  });

  it('accepts independently revalidated generated-safe launcher and engraving geometry', () => {
    const result = safeLauncherResult();

    expect(() => validateAutomaticColoredResult(result, Infinity, () => undefined, result.material))
      .not.toThrow();
  });

  it.each([
    ['exterior removal envelope', () => replaceLayerEngraving(
      automaticResult(), 0, engravingBox('near-exterior', -29.8, -28.8, 6, 7),
    )],
    ['central-hole removal envelope', () => replaceLayerEngraving(
      automaticResult(), 0, engravingBox('near-central', 2.2, 3.2, -0.25, 0.25),
    )],
    ['launcher finished envelope', () => {
      const source = safeLauncherResult();
      const [centerX, centerY] = source.coloredLayers.at(-1)!.launcherCuts[0].outer[0];
      return replaceLayerEngraving(
        source, 4,
        engravingBox('near-launcher', centerX - 0.25, centerX + 0.25, centerY - 0.25, centerY + 0.25),
      );
    }],
    ['fastener finished envelope', () => replaceLayerEngraving(
      withThreeFasteners(), 0, engravingBox('near-fastener', 6.65, 7.65, -0.2, 0.2),
    )],
  ])('rejects a self-consistent recomputed exact-mode engraving forgery intersecting the %s', (_label, forge) => {
    const forged = forge();
    expect(forged.mode).toBe('exact');
    expect(forged.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(forged));
    expect(() => validateAutomaticColoredResult(forged, Infinity, () => undefined, forged.material))
      .toThrow(/engraving.*physical cut|physical.*engraving|clearance/i);
  });

  it.each([
    // With kerf 0.1 and minWeb 0.5, these leave 0.549 mm to the toolpath:
    // above minWeb alone, but just below the required inclusive 0.55 mm band.
    ['exterior containment and minimum web', [[29.001, 0], [-2.5, 4.330127018922193], [-2.5, -4.330127018922193]] as const],
    ['central-hole minimum web', [[2.999, 0], [-5, 4], [-5, -4]] as const],
    ['inter-hook minimum web', [[5, 0], [5.7, 0], [-5, 0]] as const],
  ])('rejects recomputed active launcher geometry violating %s', (_label, centers) => {
    const forged = withLauncherCenters(centers);
    expect(forged.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(forged));
    expect(() => validateAutomaticColoredResult(forged, Infinity, () => undefined, forged.material))
      .toThrow(/launcher.*physical safety|containment|minimum web/i);
  });

  it('polls launcher and engraving physical reconciliation and preserves exact cancellation identity', () => {
    const result = safeLauncherResult();
    const cancellation = new Error('cancel physical cut envelope validation');
    expect(() => validateAutomaticColoredResult(result, Infinity, (label?: string) => {
      if (label === 'assembly:physical-cut-envelope-loop') throw cancellation;
    }, result.material)).toThrow(cancellation);
  });
});
