import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, findAxisCandidates } from '../domain/axis/find-axis';
import { generateParts } from '../domain/decomposition/generate-parts';
import { quantizeHeightField } from '../domain/engraving/quantize';
import type { MaterialProfileV1 } from '../domain/materials/schema';
import { inspectMesh } from '../domain/mesh/inspect-mesh';
import { parseSTL } from '../domain/mesh/parse-stl';
import { repairMeshSafe } from '../domain/mesh/repair-mesh';
import type { TriangleMesh } from '../domain/mesh/types';
import {
  createManufacturingArtifacts,
  type ManufacturingArtifacts,
  type ManufacturingSettings,
} from '../domain/pipeline/manufacturing-pipeline';
import { buildPackage, type ManufacturingPackage } from './package';
import { LAYER_ORDER, type LayerEntity, type ManufacturingProject, type ManufacturingSheet } from './layers';

const readyTestMaterial: MaterialProfileV1 = {
  schemaVersion: 1,
  id: 'test-only-birch-plywood-b42',
  machine: 'TEST ONLY virtual laser',
  materialCode: 'TEST-BIRCH-PLYWOOD-B42',
  materialName: 'TEST ONLY laser-approved birch plywood',
  batchNotes: 'Synthetic batch B42 used only by automated export integration tests',
  thicknessMm: 3,
  sheetWidthMm: 300,
  sheetHeightMm: 200,
  kerfMm: 0.14,
  fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 },
  minFeatureMm: 0.6,
  minWebMm: 0.4,
  minRemainingMm: 1.2,
  recipes: {
    cut: { powerPercent: 50, speedMmPerSecond: 20, passes: 1, notes: 'Synthetic test recipe' },
    score: null,
    engrave1: { powerPercent: 10, speedMmPerSecond: 100, passes: 1, notes: 'Synthetic test recipe' },
    engrave2: { powerPercent: 15, speedMmPerSecond: 100, passes: 1, notes: 'Synthetic test recipe' },
    engrave3: { powerPercent: 20, speedMmPerSecond: 100, passes: 1, notes: 'Synthetic test recipe' },
    engrave4: null,
    engrave5: null,
  },
  calibratedAt: '2026-07-19T00:00:00.000Z',
  physicalCouponVerified: true,
  operatorApproval: {
    operatorName: 'TEST ONLY synthetic operator',
    qualification: 'Automated test fixture, not a production qualification',
    signedAt: '2026-07-19T00:00:00.000Z',
    signature: 'TEST-ONLY-NOT-A-PHYSICAL-SIGNATURE',
    couponId: 'TEST-ONLY-SYNTHETIC-COUPON',
  },
  safetyEvidence: {
    kind: 'allowlisted',
    category: 'laser-approved-plywood',
    compositionKnown: true,
    manufacturer: 'TEST ONLY synthetic manufacturer',
    productId: 'TEST-BIRCH-PLYWOOD-B42',
    laserSafetyReference: 'TEST ONLY synthetic safety reference',
  },
};

const settings: ManufacturingSettings = {
  splitPositionPercent: 50,
  ribCount: 6,
  ringLayers: 2,
  shaftMm: 3,
  fit: 'snug',
  materialId: readyTestMaterial.id,
  engravingLevels: 3,
  textureStrength: 0.6,
  sheetWidthMm: 300,
  sheetHeightMm: 200,
};

type RealOutput = {
  readonly artifacts: ManufacturingArtifacts;
  readonly project: ManufacturingProject;
  readonly files: ManufacturingPackage;
};

describe('real STL manufacturing-package integration', () => {
  it('preserves two distinct model geometries through SVG, DXF, PDF, JSON, and ZIP', async () => {
    const smooth = await manufacture('symmetric-smooth.stl');
    const wide = await manufacture('wide-outer-ring.stl');

    expect(smooth.artifacts.profile.value).not.toEqual(wide.artifacts.profile.value);
    expect(cutGeometry(smooth.project)).not.toEqual(cutGeometry(wide.project));
    expect(cutBounds(smooth.project.document.sheets)).not.toEqual(cutBounds(wide.project.document.sheets));

    await expectPackageMatchesDocument(smooth);
    await expectPackageMatchesDocument(wide);
  });
});

async function manufacture(fileName: string): Promise<RealOutput> {
  const bytes = await readFile(resolve(process.cwd(), 'fixtures', 'acceptance', fileName));
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const safeRepair = repairMeshSafe(parseSTL(source));
  expect(safeRepair.accepted, `${fileName} must pass the real safe-repair gate`).toBe(true);
  const mesh = safeRepair.mesh;
  const axis = findAxisCandidates(mesh, { sampleCount: 4096 })[0];
  expect(axis.confidence, `${fileName} must meet the UI automatic-axis threshold`).toBeGreaterThanOrEqual(AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const artifacts = await createManufacturingArtifacts({
    sourceSha256,
    meshSha256: meshSha256(mesh),
    mesh,
    meshInspection: inspectMesh(mesh),
    repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1' },
    axis: { ...axis, confirmed: true },
    settings,
    material: readyTestMaterial,
  }, {
    decompose: async ({ profile, material, options }) => generateParts(profile, material, options),
    engrave: async ({ field, levels, options }) => quantizeHeightField(field, levels, options),
  });
  const acceptedConfirmations = artifacts.preflight.value.issues
    .filter(({ severity }) => severity === 'confirm')
    .map(({ code }) => code);
  const blocking = artifacts.preflight.value.issues.filter(({ severity }) => severity === 'blocking');
  expect(blocking, `${fileName} must have no synthetic-pipeline blocking issue`).toEqual([]);
  const project: ManufacturingProject = {
    schemaVersion: 1,
    name: fileName.replace(/\.stl$/u, ''),
    sourceSha256,
    provenance: { inputFingerprint: artifacts.provenance.inputFingerprint },
    preflight: {
      inputFingerprint: artifacts.provenance.inputFingerprint,
      canExport: true,
      issues: artifacts.preflight.value.issues.map(({ code, severity, message }) => ({ code, severity, message })),
      acceptedConfirmations,
      materialReadiness: artifacts.material.value.readiness,
      materialProfile: artifacts.material.value.profile,
      physicalApproval: 'approved',
    },
    document: artifacts.document.value,
    settings: {
      testOnly: true,
      inputFingerprint: artifacts.provenance.inputFingerprint,
      materialFingerprint: artifacts.provenance.materialFingerprint,
      repair: artifacts.provenance.repair,
    },
  };
  return { artifacts, project, files: await buildPackage(project) };
}

async function expectPackageMatchesDocument(output: RealOutput): Promise<void> {
  expect(output.files.sheets).toHaveLength(output.project.document.sheets.length);
  for (const [sheetIndex, sheet] of output.project.document.sheets.entries()) {
    expectSvgMatchesSheet(output.files.sheets[sheetIndex].svg, sheet);
    expectDxfMatchesSheet(output.files.sheets[sheetIndex].dxf, sheet);
  }

  const assembly = await PDFDocument.load(output.files.assemblyPdf);
  expect(assembly.getPageCount()).toBe(1);
  expect(assembly.getPage(0).getWidth()).toBeCloseTo(210 * 72 / 25.4, 5);
  expect(assembly.getPage(0).getHeight()).toBeCloseTo(297 * 72 / 25.4, 5);
  for (const part of output.project.document.manifest) {
    expect(assembly.getKeywords()).toContain(`${part.partId}:${part.quantity}`);
    expect(assembly.getKeywords()).toContain(`assembly-order:${part.assemblyOrder}:${part.partId}`);
  }

  const expectedJson = JSON.parse(JSON.stringify(output.project));
  expect(JSON.parse(output.files.projectJson)).toEqual(expectedJson);
  const zip = await JSZip.loadAsync(output.files.zip);
  expect(JSON.parse(await zip.file('03-settings/project-settings.json')!.async('string'))).toEqual(expectedJson);
  for (const [sheetIndex, files] of output.files.sheets.entries()) {
    const number = String(sheetIndex + 1).padStart(2, '0');
    expect(await zip.file(`01-cut-files/material-sheet-${number}.svg`)!.async('string')).toBe(files.svg);
    expect(await zip.file(`01-cut-files/material-sheet-${number}.dxf`)!.async('string')).toBe(files.dxf);
  }
}

function expectSvgMatchesSheet(svg: string, sheet: ManufacturingSheet): void {
  expect(svg).toContain(`width="${sheet.width}mm" height="${sheet.height}mm" viewBox="0 0 ${sheet.width} ${sheet.height}"`);
  const actual = [...svg.matchAll(/<g id="layer-([^"]+)"[^>]*>(.*?)<\/g>/gs)].flatMap((group) =>
    [...group[2].matchAll(/<polygon id="([^"]+)" data-part-id="([^"]+)" data-instance="(\d+)" data-contour="([^"]+)" points="([^"]+)"\/>/g)].map((polygon) => ({
      layer: group[1],
      id: polygon[1],
      partId: polygon[2],
      instance: Number(polygon[3]),
      contour: polygon[4],
      points: polygon[5].split(' ').map((point) => point.split(',').map(Number)),
    }))
  );
  const expected = LAYER_ORDER.flatMap((layer) => sheet.entities.filter((entity) => entity.layer === layer)).map(entityOracle);
  expect(actual).toEqual(expected);
}

function expectDxfMatchesSheet(dxf: string, sheet: ManufacturingSheet): void {
  expect(dxf).toContain('$INSUNITS\n70\n4');
  expect(dxf).toContain(`$EXTMIN\n10\n0\n20\n0\n30\n0`);
  expect(dxf).toContain(`$EXTMAX\n10\n${sheet.width}\n20\n${sheet.height}\n30\n0`);
  const entities = [...dxf.matchAll(/999\nENTITY_ID:([^\n]+)\n999\nPART_ID:([^\n]+)\n999\nINSTANCE:(\d+)\n999\nCONTOUR:([^\n]+)\n0\nLWPOLYLINE\n8\n([^\n]+)\n90\n(\d+)\n70\n1\n((?:10\n[^\n]+\n20\n[^\n]+\n)+)/g)].map((match) => {
    const points = [...match[7].matchAll(/10\n([^\n]+)\n20\n([^\n]+)\n/g)].map((point) => [Number(point[1]), Number(point[2])]);
    expect(points).toHaveLength(Number(match[6]));
    return { id: match[1], partId: match[2], instance: Number(match[3]), contour: match[4], layer: match[5], points };
  });
  expect(entities).toEqual(sheet.entities.map(entityOracle));
}

function entityOracle(entity: LayerEntity) {
  return {
    id: entity.id,
    partId: entity.partId,
    instance: entity.instance,
    contour: entity.contour,
    layer: entity.layer,
    points: entity.polygon.points.map((point) => [...point]),
  };
}

function meshSha256(mesh: TriangleMesh): string {
  return createHash('sha256')
    .update(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength))
    .update(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength))
    .digest('hex');
}

function cutGeometry(project: ManufacturingProject): string {
  return JSON.stringify(project.document.sheets.flatMap(({ entities }) => entities.filter(({ layer }) => layer === 'CUT')));
}

function cutBounds(sheets: readonly ManufacturingSheet[]): readonly [number, number] {
  const points = sheets.flatMap(({ entities }) => entities.filter(({ layer, contour }) => layer === 'CUT' && contour === 'outline').flatMap(({ polygon }) => polygon.points));
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}
