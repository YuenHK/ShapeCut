import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { MaterialProfileV1 } from '../domain/materials/schema';
import type { ManufacturingProject } from './layers';
import { buildPackage } from './package';

const square = (x: number, y: number, size: number) => ({ points: [[x, y], [x + size, y], [x + size, y + size], [x, y + size]] as const });

const readyMaterial: MaterialProfileV1 = {
  schemaVersion: 1,
  id: 'q400-birch-b42',
  machine: 'Trotec Q400 #1',
  materialCode: 'BIRCH-PLY-B42',
  materialName: 'Laser-approved birch plywood',
  batchNotes: 'Manufacturer batch B42 measured at four corners',
  thicknessMm: 3,
  sheetWidthMm: 300,
  sheetHeightMm: 200,
  kerfMm: 0.14,
  fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 },
  minFeatureMm: 0.6,
  minWebMm: 0.4,
  minRemainingMm: 1.2,
  recipes: {
    cut: { powerPercent: 50, speedMmPerSecond: 20, passes: 1, notes: 'Approved batch setting' },
    score: null,
    engrave1: { powerPercent: 10, speedMmPerSecond: 100, passes: 1, notes: 'Approved level one' },
    engrave2: null,
    engrave3: null,
    engrave4: null,
    engrave5: null,
  },
  calibratedAt: '2026-07-19T00:00:00.000Z',
  physicalCouponVerified: true,
  operatorApproval: {
    operatorName: 'Alex Chan',
    qualification: 'Qualified laser cutter operator',
    signedAt: '2026-07-19T00:00:00.000Z',
    signature: 'A-CHAN-Q400-B42',
    couponId: 'Q400-BIRCH-B42-20260719',
  },
  safetyEvidence: {
    kind: 'allowlisted',
    category: 'laser-approved-plywood',
    compositionKnown: true,
    manufacturer: 'Example Timber Company',
    productId: 'BIRCH-PLY-B42',
    laserSafetyReference: 'https://example.com/materials/birch-b42-safety',
  },
};

const completeProject: ManufacturingProject = {
  schemaVersion: 1,
  name: 'balanced-spinner',
  sourceSha256: 'a'.repeat(64),
  provenance: { inputFingerprint: 'b'.repeat(64) },
  preflight: {
    inputFingerprint: 'b'.repeat(64),
    canExport: true,
    issues: [],
    acceptedConfirmations: [],
    materialReadiness: { status: 'ready', reasons: [] },
    materialProfile: readyMaterial,
    physicalApproval: 'approved',
  },
  document: {
    provenance: { inputFingerprint: 'b'.repeat(64) },
    unit: 'mm',
    sheets: [{
      width: 300,
      height: 200,
      entities: [
        { id: 'hub-cut', partId: 'hub-1', layer: 'CUT', polygon: square(10, 10, 30) },
        { id: 'hub-score', partId: 'hub-1', layer: 'SCORE', polygon: square(12, 12, 26) },
        { id: 'rib-e1', partId: 'rib-1', layer: 'ENGRAVE_1', polygon: square(60, 10, 20) },
        { id: 'rib-e2', partId: 'rib-1', layer: 'ENGRAVE_2', polygon: square(62, 12, 16) },
        { id: 'rib-e3', partId: 'rib-1', layer: 'ENGRAVE_3', polygon: square(64, 14, 12) },
        { id: 'rib-e4', partId: 'rib-1', layer: 'ENGRAVE_4', polygon: square(66, 16, 8) },
      ],
    }],
    manifest: [
      { partId: 'hub-1', quantity: 2, assemblyOrder: 1 },
      { partId: 'rib-1', quantity: 6, assemblyOrder: 2 },
    ],
  },
  settings: { materialProfileId: 'plywood-3', kerfMm: 0.14 },
};

function svgLayers(svg: string): string[] {
  return [...svg.matchAll(/<g id="layer-([^"]+)"/g)].map((match) => match[1]);
}

function dxfLayers(dxf: string): string[] {
  return [...new Set([...dxf.matchAll(/\n8\n([^\n]+)\n/g)].map((match) => match[1]))];
}

describe('manufacturing package', () => {
  it('exports matching millimetre layers and part manifests from one document', async () => {
    const files = await buildPackage(completeProject);
    const expectedLayers = ['CUT', 'SCORE', 'ENGRAVE_1', 'ENGRAVE_2', 'ENGRAVE_3', 'ENGRAVE_4'];

    expect(svgLayers(files.sheets[0].svg)).toEqual(expectedLayers);
    expect(dxfLayers(files.sheets[0].dxf)).toEqual(expectedLayers);
    expect(files.sheets[0].svg).toContain('width="300mm" height="200mm"');
    expect(files.sheets[0].dxf).toContain('$INSUNITS\n70\n4');

    const pdf = await PDFDocument.load(files.assemblyPdf);
    expect(pdf.getKeywords()).toContain('hub-1:2');
    expect(pdf.getKeywords()).toContain('rib-1:6');
    expect(pdf.getPageCount()).toBeGreaterThan(0);
  });

  it('creates the specified ZIP tree and omits the source STL by default', async () => {
    const files = await buildPackage(completeProject);
    const zip = await JSZip.loadAsync(files.zip);
    const paths = Object.keys(zip.files).filter((path) => !zip.files[path].dir).sort();

    expect(paths).toEqual([
      '01-cut-files/material-sheet-01.dxf',
      '01-cut-files/material-sheet-01.svg',
      '02-instructions/assembly-guide.pdf',
      '02-instructions/parts-map.svg',
      '03-settings/material-recipe.pdf',
      '03-settings/project-settings.json',
      'preflight-report.pdf',
    ]);
    expect(paths.some((path) => path.endsWith('.stl'))).toBe(false);

    const settings = JSON.parse(await zip.file('03-settings/project-settings.json')!.async('string'));
    expect(settings).toMatchObject({ schemaVersion: 1, sourceSha256: 'a'.repeat(64), document: { unit: 'mm' } });

    const preflight = await PDFDocument.load(await zip.file('preflight-report.pdf')!.async('uint8array'));
    expect(preflight.getKeywords()).toContain('production-approved');
    expect(preflight.getKeywords()).toContain('material-readiness:ready');
    expect(preflight.getKeywords()).toContain('blocking:0');
  });

  it('refuses production packaging while physical material or coupon approval is pending', async () => {
    const pending = {
      ...completeProject,
      preflight: {
        ...completeProject.preflight,
        canExport: false,
        issues: [{ code: 'uncalibrated-material', severity: 'blocking' as const, message: 'Physical coupon and signed operator evidence are pending.' }],
        materialReadiness: { status: 'confirm' as const, reasons: [{ code: 'physical-calibration-required', message: 'Physical coupon pending.' }] },
        materialProfile: { ...readyMaterial, calibratedAt: null, physicalCouponVerified: false, operatorApproval: undefined },
        physicalApproval: 'pending' as const,
      },
    };

    await expect(buildPackage(pending)).rejects.toThrow(/preflight|physical|production|pending/i);
  });

  it('recomputes material readiness and rejects forged ready flags without signed physical evidence', async () => {
    const forgedReady = {
      ...completeProject,
      preflight: {
        ...completeProject.preflight,
        materialProfile: { ...readyMaterial, operatorApproval: undefined },
      },
    };

    await expect(buildPackage(forgedReady)).rejects.toThrow(/preflight|physical|production|pending/i);
  });

  it('rejects unsafe names, invalid fingerprints, and non-finite geometry', async () => {
    await expect(buildPackage({ ...completeProject, name: '../escape' })).rejects.toThrow(/name/i);
    await expect(buildPackage({ ...completeProject, sourceSha256: 'not-a-hash' })).rejects.toThrow(/sha-256/i);
    const invalid: ManufacturingProject = {
      ...completeProject,
      document: {
        ...completeProject.document,
        sheets: [{
          ...completeProject.document.sheets[0],
          entities: [{ ...completeProject.document.sheets[0].entities[0], polygon: { points: [[Number.NaN, 0], [1, 0], [0, 1]] } }],
        }],
      },
    };
    await expect(buildPackage(invalid)).rejects.toThrow(/finite/i);
  });
});
