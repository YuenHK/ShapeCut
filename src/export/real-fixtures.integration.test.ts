import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, findAxisCandidates } from '../domain/axis/find-axis';
import { generateParts } from '../domain/decomposition/generate-parts';
import { quantizeHeightField } from '../domain/engraving/quantize';
import { manufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
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
import { convertAutomatically } from '../domain/pipeline/automatic-outline-pipeline';
import type { FeatureContour } from '../domain/outline-features/types';
import { READY_TEST_MATERIAL } from '../test/ready-material';
import { createOutlinePackage, verifyOutlinePackage } from './outline-package';
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

const knightFixtures = ([
  { caseId: 'reference-a', fileName: 'Copy of Beyblade X Knight Fortress.stl' },
  { caseId: 'reference-b', fileName: 'Copy of Beyblade X Knight Fortress Group.stl' },
] as const).map((fixture) => ({
  ...fixture,
  path: [
    resolve(process.cwd(), fixture.fileName),
    resolve(process.cwd(), '..', '..', fixture.fileName),
  ].find(existsSync),
}));

describe.runIf(knightFixtures.every(({ path }) => path !== undefined))(
  'Knight Fortress launcher exterior expansion',
  () => {
    it.each(knightFixtures)(
      '$caseId succeeds with only the top-two canonical exteriors expanded',
      async ({ caseId, path }) => {
        const bytes = await readFile(path!);
        const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const conversionStartedAt = performance.now();
        const result = await convertAutomatically({
          bytes: source,
          material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
          launcherFitOffsetMm: 0,
        });
        const conversionElapsedMs = performance.now() - conversionStartedAt;
        const sourceContours = result.layers.map(({ contour }) => (
          contour.outer.map(([x, y]) => [x, y] as const)
        ));
        const blackBeforePackaging = blackContourSnapshot(result.coloredLayers);

        expect(result.assembly.launcher.exteriorExpansion).toMatchObject({
          mode: 'shared-uniform',
          maxOffsetMm: 6,
        });
        expect(conversionElapsedMs).toBeLessThan(30_000);
        expect(result.assembly.launcher.exteriorExpansion.offsetMm).toBeGreaterThan(0);
        expect(result.assembly.launcher.exteriorExpansion.offsetMm).toBeLessThanOrEqual(6);
        expect(result.layers.slice(-2).map(({ id }) => id))
          .toEqual(result.assembly.launcher.exteriorExpansion.affectedLayerIds);
        expect(result.coloredLayers.slice(-2).every(
          (layer) => layer.launcherCuts.length === 3,
        )).toBe(true);
        expect(result.assembly.decorationOmissions.every((omission) =>
          result.coloredLayers.some((layer) =>
            layer.id === omission.layerId
              && layer.deepFeatures.length === 0
              && layer.lightFeatures.length === 0,
          ),
        )).toBe(true);
        const omittedLayerIds = result.assembly.decorationOmissions.map(({ layerId }) => layerId);
        expect(result.coloredLayers.flatMap((layer) => (
          layer.diagnostics.depth.omissionCode === 'PROTECTED_CUT_WORK_BUDGET'
            ? [layer.id]
            : []
        ))).toEqual(omittedLayerIds);

        expect(result.coloredLayers).toHaveLength(sourceContours.length);
        result.coloredLayers.forEach((layer, index) => {
          if (index < sourceContours.length - 2) {
            expect(layer.exterior.outer, `${caseId} lower exterior ${layer.id}`)
              .toEqual(sourceContours[index]);
          } else {
            expect(layer.exterior.outer, `${caseId} expanded exterior ${layer.id}`)
              .not.toEqual(sourceContours[index]);
          }
        });
        expect(result.preview.layers.map(({ exterior }) => exterior.outer))
          .toEqual(result.coloredLayers.map(({ exterior }) => exterior.outer));
        expect(blackContourSnapshot(result.preview.layers)).toEqual(blackBeforePackaging);

        const output = await createOutlinePackage(result);
        await expect(verifyOutlinePackage(output, result)).resolves.toBeUndefined();
        expect(blackContourSnapshot(result.coloredLayers)).toEqual(blackBeforePackaging);
        expect(blackContourSnapshot(result.preview.layers)).toEqual(blackBeforePackaging);
        const project = JSON.parse(output.projectJson) as {
          readonly assembly: {
            readonly launcher: { readonly exteriorExpansion: unknown };
            readonly decorationOmissions: unknown;
          };
          readonly layers: readonly {
            readonly id: string;
            readonly members: {
              readonly CUT_BLACK: readonly string[];
              readonly DEEP_RED: readonly string[];
              readonly LIGHT_BLUE: readonly string[];
            };
          }[];
        };
        const manifest = JSON.parse(output.manifestJson) as {
          readonly decisions: {
            readonly launcherExteriorExpansionMode: unknown;
            readonly launcherExteriorExpansionMm: unknown;
            readonly launcherExteriorExpansionMaxMm: unknown;
            readonly launcherExteriorExpansionLayerIds: unknown;
            readonly decorationOmissions: unknown;
          };
        };
        expect(project.assembly.launcher.exteriorExpansion)
          .toEqual(result.assembly.launcher.exteriorExpansion);
        expect(manifest.decisions).toMatchObject({
          launcherExteriorExpansionMode: result.assembly.launcher.exteriorExpansion.mode,
          launcherExteriorExpansionMm: result.assembly.launcher.exteriorExpansion.offsetMm,
          launcherExteriorExpansionMaxMm: result.assembly.launcher.exteriorExpansion.maxOffsetMm,
          launcherExteriorExpansionLayerIds:
            result.assembly.launcher.exteriorExpansion.affectedLayerIds,
          decorationOmissions: result.assembly.decorationOmissions,
        });
        expect(project.assembly.decorationOmissions)
          .toEqual(result.assembly.decorationOmissions);
        for (const layer of project.layers) {
          expect(layer.members.CUT_BLACK.length).toBeGreaterThan(0);
          if (omittedLayerIds.includes(layer.id)) {
            expect(layer.members.DEEP_RED).toEqual([]);
            expect(layer.members.LIGHT_BLUE).toEqual([]);
          }
        }
        console.info(
          [
            'KNIGHT_RELEASE',
            caseId,
            `elapsedMs=${conversionElapsedMs.toFixed(3)}`,
            `offsetMm=${result.assembly.launcher.exteriorExpansion.offsetMm.toFixed(2)}`,
            `rotationRad=${result.assembly.launcher.rotationRad.toFixed(12)}`,
            `omittedLayerIds=${omittedLayerIds.length === 0 ? 'none' : omittedLayerIds.join(',')}`,
            `blackBytes=${blackBeforePackaging.byteLength}`,
          ].join(' '),
        );
      },
      120_000,
    );
  },
);

function blackContourSnapshot(
  layers: readonly {
    readonly id: string;
    readonly exterior: FeatureContour;
    readonly centralHole?: FeatureContour;
    readonly launcherCuts: readonly FeatureContour[];
    readonly fastenerHoles: readonly FeatureContour[];
  }[],
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(layers.map((layer) => ({
    layerId: layer.id,
    contours: [
      layer.exterior,
      ...(layer.centralHole ? [layer.centralHole] : []),
      ...layer.launcherCuts,
      ...layer.fastenerHoles,
    ],
  }))));
}

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
  const records = Object.values(zip.files).filter(({ dir }) => !dir);
  expect(records.map(({ name }) => name).sort()).toEqual([
    ...output.files.sheets.flatMap((_files, sheetIndex) => {
      const number = String(sheetIndex + 1).padStart(2, '0');
      return [
        `01-cut-files/material-sheet-${number}.dxf`,
        `01-cut-files/material-sheet-${number}.svg`,
      ];
    }),
    '02-instructions/assembly-guide.pdf',
    '02-instructions/parts-map.svg',
    '03-settings/material-recipe.pdf',
    '03-settings/project-settings.json',
    'preflight-report.pdf',
  ].sort());
  expect(await zip.file('03-settings/project-settings.json')!.async('string')).toBe(output.files.projectJson);
  expect(JSON.parse(await zip.file('03-settings/project-settings.json')!.async('string'))).toEqual(expectedJson);
  expect(await zip.file('02-instructions/assembly-guide.pdf')!.async('uint8array'))
    .toEqual(output.files.assemblyPdf);
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
