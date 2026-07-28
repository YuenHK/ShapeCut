import { describe, expect, it } from 'vitest';
import { diagnosticsFingerprint } from '../domain/pipeline/automatic-outline-pipeline';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import type { Point2 } from '../domain/decomposition/types';
import type { FeatureContour } from '../domain/outline-features/types';
import {
  createColoredOutlineDocument,
  validateColoredOutlineDocument,
} from './colored-outline-document';
import { coloredResult } from './colored-outline-test-fixture';

function circle48(center: Point2, radius: number, id: string): FeatureContour {
  const outer = Array.from({ length: 48 }, (_, index) => {
    const angle = index * Math.PI * 2 / 48;
    return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius] as const;
  });
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  return {
    id, role: 'CUT_BLACK', outer,
    boundsMm: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    areaMm2: Math.abs(outer.reduce((sum, point, index) => {
      const next = outer[(index + 1) % outer.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2),
  };
}

function allLayerHoleOmissionResult() {
  const result = coloredResult();
  const coloredLayers = result.coloredLayers.map((layer) => ({
    ...layer,
    centralHole: undefined,
    diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
  }));
  const omitted = {
    ...result,
    status: 'warning' as const,
    coloredLayers,
    featureWarnings: [...result.featureWarnings, CENTRAL_HOLE_OMISSION_WARNING],
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...omitted, featureEvidenceFingerprint: featureEvidenceFingerprint(omitted) };
}

function withFeatureWarnings(
  result: ReturnType<typeof coloredResult>,
  featureWarnings: readonly string[],
) {
  const changed = { ...result, status: 'warning' as const, featureWarnings };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function withColoredLayers(
  result: ReturnType<typeof coloredResult>,
  coloredLayers: ReturnType<typeof coloredResult>['coloredLayers'],
) {
  const changed = {
    ...result,
    coloredLayers,
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function activeAssemblyResult() {
  const result = coloredResult();
  const layer = result.coloredLayers[5], featured = result.coloredLayers[2];
  const launcherCuts = layer.launcherCuts;
  const fastenerCenters = [[7, 0], [-7, 0]] as const;
  const coloredLayers = result.coloredLayers.map((candidate, index) => ({
    ...candidate,
    launcherCuts: index < 4 ? [] : launcherCuts.map((cut, cutIndex) => ({
      ...cut, id: `${candidate.id}-launcher-${cutIndex + 1}`,
    })),
    fastenerHoles: fastenerCenters.map((center, fastenerIndex) => (
      circle48(center, 2.85 / 2, `${candidate.id}-fastener-${fastenerIndex + 1}`)
    )),
    deepFeatures: index === 5
      ? featured.deepFeatures.map((contour) => ({ ...contour, id: 'top-deep-1' }))
      : candidate.deepFeatures,
    lightFeatures: index === 5
      ? featured.lightFeatures.map((contour) => ({ ...contour, id: 'top-light-1' }))
      : candidate.lightFeatures,
  }));
  const changed = {
    ...result,
    coloredLayers,
    featureWarnings: [],
    assembly: {
      ...result.assembly,
      launcher: result.assembly.launcher,
      fastener: {
        count: 2 as const, centers: fastenerCenters, finishedDiameterMm: 3 as const,
        pathDiameterMm: 2.85, radiusMm: 7, rotationRad: 0,
      },
      topFeatures: {
        retained: { red: 1, blue: 1 },
        omitted: { red: 0, blue: 0 },
        launcherOverlap: {
          clipped: { red: 0, blue: 0 },
          removed: { red: 0, blue: 0 },
        },
      },
    },
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

describe('canonical colored outline document', () => {
  it('writes bounded multi-contour geometry in canonical cut and engraving order', () => {
    const complete = activeAssemblyResult();
    const document = createColoredOutlineDocument(complete);

    expect(document.layers[5].roles.CUT_BLACK.map(({ id }) => id)).toEqual([
      'layer-6-exterior', 'layer-6-hole',
      'layer-6-launcher-1', 'layer-6-launcher-2', 'layer-6-launcher-3',
      'layer-6-fastener-1', 'layer-6-fastener-2',
    ]);
    expect(document.layers[5].roles.DEEP_RED.map(({ id }) => id)).toEqual(['top-deep-1']);
    expect(document.layers[5].roles.LIGHT_BLUE.map(({ id }) => id)).toEqual(['top-light-1']);
  });

  it('preserves ordered physical layers and exact canonical role identity', () => {
    const result = coloredResult();
    const document = createColoredOutlineDocument(result);

    expect(document).toMatchObject({
      schemaVersion: 2,
      sourceHash: result.sourceHash,
      featureEvidenceFingerprint: result.featureEvidenceFingerprint,
      diagnosticsFingerprint: diagnosticsFingerprint(result.diagnostics),
    });
    expect(document.layers.map(({ id, order, index }) => ({ id, order, index }))).toEqual(
      result.coloredLayers.map(({ id, index }, position) => ({ id, order: position + 1, index })),
    );
    expect(Object.keys(document.layers[2].roles)).toEqual(['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE']);
    expect(document.layers[2].roles.CUT_BLACK.map(({ id }) => id)).toEqual([
      'layer-3-exterior', 'layer-3-hole',
    ]);
    expect(document.layers[2].roles.DEEP_RED).toHaveLength(1);
    expect(document.layers[2].roles.LIGHT_BLUE).toHaveLength(1);
    expect(document.assembly).toEqual(result.assembly);
    expect(document.assembly.launcher.exteriorExpansion).toEqual({
      mode: 'shared-uniform',
      offsetMm: 0,
      maxOffsetMm: 6,
      affectedLayerIds: ['layer-5', 'layer-6'],
    });
    expect(() => validateColoredOutlineDocument(document, result)).not.toThrow();
  });

  it('rejects a mixed launcher or fastener assembly forgery independently of the source result', () => {
    const result = coloredResult();
    const launcher = structuredClone(createColoredOutlineDocument(result));
    Object.assign(launcher.assembly.launcher, { status: 'detected', cutCount: 3 });
    expect(() => validateColoredOutlineDocument(launcher, result))
      .toThrow(/assembly|launcher|canonical|mismatch/i);

    const fastener = structuredClone(createColoredOutlineDocument(result));
    Object.assign(fastener.assembly.fastener, { count: 2, centers: [[1, 1], [-1, -1]] });
    expect(() => validateColoredOutlineDocument(fastener, result))
      .toThrow(/assembly|fastener|canonical|mismatch/i);
  });

  it.each([
    ['templateVersion', (document: any) => { document.assembly.launcher.templateVersion += 1; }],
    ['templateFingerprint', (document: any) => { document.assembly.launcher.templateFingerprint = 'f'.repeat(32); }],
    ['rotationRad', (document: any) => { document.assembly.launcher.rotationRad += 0.01; }],
    ['fitOffsetMm', (document: any) => { document.assembly.launcher.fitOffsetMm += 0.01; }],
    ['finishedAllowanceMm', (document: any) => { document.assembly.launcher.finishedAllowanceMm += 0.01; }],
    ['exteriorExpansion.mode', (document: any) => { document.assembly.launcher.exteriorExpansion.mode = 'independent'; }],
    ['exteriorExpansion.offsetMm', (document: any) => { document.assembly.launcher.exteriorExpansion.offsetMm += 0.01; }],
    ['exteriorExpansion.maxOffsetMm', (document: any) => { document.assembly.launcher.exteriorExpansion.maxOffsetMm = 7; }],
    ['exteriorExpansion.affectedLayerIds', (document: any) => {
      document.assembly.launcher.exteriorExpansion.affectedLayerIds.reverse();
    }],
    ['launcherOverlap.clipped.red', (document: any) => { document.assembly.topFeatures.launcherOverlap.clipped.red += 1; }],
    ['launcherOverlap.clipped.blue', (document: any) => { document.assembly.topFeatures.launcherOverlap.clipped.blue += 1; }],
    ['launcherOverlap.removed.red', (document: any) => { document.assembly.topFeatures.launcherOverlap.removed.red += 1; }],
    ['launcherOverlap.removed.blue', (document: any) => { document.assembly.topFeatures.launcherOverlap.removed.blue += 1; }],
  ])('rejects canonical assembly mutation at %s', (_field, mutate) => {
    const result = coloredResult();
    const document = structuredClone(createColoredOutlineDocument(result));
    mutate(document);
    expect(() => validateColoredOutlineDocument(document, result))
      .toThrow(/launcher|assembly|canonical|mismatch/i);
  });

  it('rejects a recomputed-fingerprint exterior-clearance forgery at the canonical boundary', () => {
    const source = activeAssemblyResult();
    const radiusMm = 29;
    const centers = [[radiusMm, 0], [-radiusMm, 0]] as const;
    const coloredLayers = source.coloredLayers.map((layer) => ({
      ...layer,
      fastenerHoles: centers.map((center, index) => (
        circle48(center, source.assembly.fastener.pathDiameterMm / 2, layer.fastenerHoles[index].id)
      )),
    }));
    const changed = {
      ...source,
      assembly: {
        ...source.assembly,
        fastener: { ...source.assembly.fastener, centers, radiusMm },
      },
      coloredLayers,
      preview: { ...source.preview, layers: coloredLayers },
    };
    const forged = { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };

    expect(forged.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(forged));
    expect(() => createColoredOutlineDocument(forged)).toThrow(/fastener.*physical safety|clearance/i);
  });

  it('carries the bounded sanitized all-layer central-hole omission safety note', () => {
    const result = allLayerHoleOmissionResult();
    const document = createColoredOutlineDocument(result);

    expect(document.safetyNotes).toContain(CENTRAL_HOLE_OMISSION_WARNING);
    const safetyNotes = (document as typeof document & { readonly safetyNotes?: readonly string[] }).safetyNotes ?? [];
    for (const note of safetyNotes) expect(note).not.toMatch(/[\\/@\r\n\0]|[\w.+-]+@[\w.-]+/);
    expect(() => validateColoredOutlineDocument(document, result)).not.toThrow();
  });

  it('requires exact central-hole omission provenance and rejects false omission claims', () => {
    const omitted = allLayerHoleOmissionResult();
    const missingWarning = withFeatureWarnings(omitted, []);
    expect(() => createColoredOutlineDocument(missingWarning)).toThrow(/central.*hole.*omission.*warning/i);

    const retainedWithFalseWarning = withFeatureWarnings(coloredResult(), [CENTRAL_HOLE_OMISSION_WARNING]);
    expect(() => createColoredOutlineDocument(retainedWithFalseWarning)).toThrow(/central.*hole.*omission.*warning/i);
  });

  it('rejects mixed and shifted shared-hole decisions before creating a canonical document', () => {
    const result = coloredResult();
    const mixedLayers = result.coloredLayers.map((layer, index) => index === 0 ? {
      ...layer,
      centralHole: undefined,
      diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
    } : layer);
    expect(() => createColoredOutlineDocument(withColoredLayers(result, mixedLayers)))
      .toThrow(/shared central hole.*(?:every layer|mixed|retain.*omit)/i);

    const shiftedLayers = result.coloredLayers.map((layer, index) => {
      if (index !== 2 || !layer.centralHole) return layer;
      const outer = layer.centralHole.outer.map(([x, y]) => [x + 0.25, y] as const);
      return {
        ...layer,
        centralHole: {
          ...layer.centralHole,
          outer,
          boundsMm: {
            ...layer.centralHole.boundsMm,
            minX: layer.centralHole.boundsMm.minX + 0.25,
            maxX: layer.centralHole.boundsMm.maxX + 0.25,
          },
        },
      };
    });
    expect(() => createColoredOutlineDocument(withColoredLayers(result, shiftedLayers)))
      .toThrow(/shared central holes.*identical.*model space/i);
  });

  it('independently rejects mixed and shifted hole geometry in a forged canonical document', () => {
    const result = coloredResult();
    const mixed = structuredClone(createColoredOutlineDocument(result));
    Object.assign(mixed.layers[0].roles, { CUT_BLACK: [mixed.layers[0].roles.CUT_BLACK[0]] });
    expect(() => validateColoredOutlineDocument(mixed, result))
      .toThrow(/canonical shared central hole.*(?:every layer|mixed|retain.*omit)/i);

    const shifted = structuredClone(createColoredOutlineDocument(result));
    (shifted.layers[2].roles.CUT_BLACK[1].outer[0] as unknown as [number, number])[0] += 0.25;
    expect(() => validateColoredOutlineDocument(shifted, result))
      .toThrow(/canonical shared central holes.*identical.*model space/i);
  });

  it.each([
    ['private note', ['/Users/private/source.stl']],
    ['too many notes', Array.from({ length: 17 }, (_, index) => `Safety note ${index}`)],
    ['oversized note', ['x'.repeat(201)]],
  ])('rejects canonical %s before it can reach an artifact', (_label, safetyNotes) => {
    const result = allLayerHoleOmissionResult();
    const document = structuredClone(createColoredOutlineDocument(result));
    Object.assign(document, { safetyNotes });

    expect(() => validateColoredOutlineDocument(document, result)).toThrow(/safety note.*(?:private|contact|bound|length|invalid)/i);
  });

  it.each([
    ['recolored role', (document: any) => { document.layers[2].roles.DEEP_RED[0].role = 'LIGHT_BLUE'; }],
    ['mutated geometry', (document: any) => { document.layers[2].roles.CUT_BLACK[0].outer[0][0] += 1; }],
    ['swapped layers', (document: any) => { [document.layers[1], document.layers[2]] = [document.layers[2], document.layers[1]]; }],
    ['feature fingerprint', (document: any) => { document.featureEvidenceFingerprint = 'f'.repeat(32); }],
    ['diagnostics fingerprint', (document: any) => { document.diagnosticsFingerprint = 'e'.repeat(32); }],
    ['direct span drift', (document: any) => { document.layers[2].zEnd += 0.01; }],
  ])('rejects %s instead of exporting untrusted canonical data', (_label, mutate) => {
    const result = coloredResult();
    const document = structuredClone(createColoredOutlineDocument(result));
    mutate(document);

    expect(() => validateColoredOutlineDocument(document, result)).toThrow(/canonical|fingerprint|role|geometry|order|span|mismatch/i);
  });

  it('shares the caller absolute deadline through colored-result and canonical polygon validation', () => {
    const labels: string[] = [];
    expect(() => createColoredOutlineDocument(coloredResult(), 5, {
      now: () => labels.includes('canonical:polygon-loop') ? 6 : 0,
      onCheckpoint: (label) => labels.push(label),
    })).toThrow(/shared deadline/i);
    expect(labels).toContain('canonical:polygon-loop');
  });

  it('propagates labeled late assembly cancellation unchanged through canonical validation', () => {
    const cancellation = new Error('cancel canonical fastener reconciliation');
    let polls = 0;
    expect(() => createColoredOutlineDocument(activeAssemblyResult(), 1, {
      now: () => 0,
      onCheckpoint: (label) => {
        if (label === 'canonical:result-validation:assembly:fastener-point-loop' && ++polls === 2) {
          throw cancellation;
        }
      },
    })).toThrow(cancellation);
    expect(polls).toBe(2);
  });

  it('rejects diagnostics and removal fingerprints that drift from the direct pipeline evidence', () => {
    const diagnosticDrift = coloredResult();
    Object.assign(diagnosticDrift.diagnostics.layers[0], { boundsDriftRatio: 0.02 });
    expect(() => createColoredOutlineDocument(diagnosticDrift)).toThrow(/diagnostic|drift|evidence/i);

    const removalDrift = coloredResult();
    Object.assign(removalDrift, { removalEvidenceFingerprint: 'f'.repeat(32) });
    expect(() => createColoredOutlineDocument(removalDrift)).toThrow(/removal|fingerprint|evidence/i);
  });
});
