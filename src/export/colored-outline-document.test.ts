import { describe, expect, it } from 'vitest';
import { diagnosticsFingerprint } from '../domain/pipeline/automatic-outline-pipeline';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import {
  createColoredOutlineDocument,
  validateColoredOutlineDocument,
} from './colored-outline-document';
import { coloredResult } from './colored-outline-test-fixture';

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

describe('canonical colored outline document', () => {
  it('writes bounded multi-contour geometry in canonical cut and engraving order', () => {
    const result = coloredResult();
    const layer = result.coloredLayers[5];
    const featured = result.coloredLayers[2];
    const coloredLayers = result.coloredLayers.map((candidate, index) => ({
      ...candidate,
      launcherCuts: index < 4 ? [] : [1, 2, 3].map((number) => ({
        ...layer.centralHole!, id: `${candidate.id}-launcher-${number}`,
      })),
      fastenerHoles: [1, 2].map((number) => ({
        ...layer.centralHole!, id: `${candidate.id}-fastener-${number}`,
      })),
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
        launcher: { status: 'detected' as const, cutCount: 3 as const, assemblyAllowanceMm: 0.2 as const },
        fastener: { count: 2 as const, centers: [[0, 0], [0, 0]] as const, finishedDiameterMm: 3 as const, pathDiameterMm: 2.85 },
        topFeatures: { retained: { red: 1, blue: 1 }, omitted: { red: 0, blue: 0 } },
      },
      preview: { ...result.preview, layers: coloredLayers },
    };
    const complete = { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
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

  it('rejects diagnostics and removal fingerprints that drift from the direct pipeline evidence', () => {
    const diagnosticDrift = coloredResult();
    Object.assign(diagnosticDrift.diagnostics.layers[0], { boundsDriftRatio: 0.02 });
    expect(() => createColoredOutlineDocument(diagnosticDrift)).toThrow(/diagnostic|drift|evidence/i);

    const removalDrift = coloredResult();
    Object.assign(removalDrift, { removalEvidenceFingerprint: 'f'.repeat(32) });
    expect(() => createColoredOutlineDocument(removalDrift)).toThrow(/removal|fingerprint|evidence/i);
  });
});
