import { describe, expect, it } from 'vitest';
import { generateParts } from '../decomposition/generate-parts';
import type { LathedProfile } from '../decomposition/types';
import { quantizeHeightField } from '../engraving/quantize';
import type { MaterialProfileV1 } from '../materials/schema';
import type { TriangleMesh } from '../mesh/types';
import {
  createManufacturingArtifacts,
  type ManufacturingPipelineInput,
} from './manufacturing-pipeline';

const readyMaterial: MaterialProfileV1 = {
  schemaVersion: 1,
  id: 'q400-ready-birch-3-b42',
  machine: 'Trotec Q400 #1',
  materialCode: 'BIRCH-PLY-BATCH-42',
  materialName: 'Laser-approved birch plywood batch 42',
  batchNotes: 'Manufacturer batch B42 measured at all four corners',
  thicknessMm: 3,
  sheetWidthMm: 300,
  sheetHeightMm: 200,
  kerfMm: 0.14,
  fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 },
  minFeatureMm: 0.6,
  minWebMm: 0.4,
  minRemainingMm: 1.2,
  recipes: {
    cut: { powerPercent: 50, speedMmPerSecond: 20, passes: 1, notes: 'test fixture' },
    score: null,
    engrave1: { powerPercent: 10, speedMmPerSecond: 100, passes: 1, notes: 'test fixture' },
    engrave2: { powerPercent: 15, speedMmPerSecond: 100, passes: 1, notes: 'test fixture' },
    engrave3: { powerPercent: 20, speedMmPerSecond: 100, passes: 1, notes: 'test fixture' },
    engrave4: null,
    engrave5: null,
  },
  calibratedAt: '2026-07-19T00:00:00.000Z',
  physicalCouponVerified: true,
  operatorApproval: {
    operatorName: 'Alex Chan',
    qualification: 'School laser cutter qualified operator',
    signedAt: '2026-07-19T00:00:00.000Z',
    signature: 'A-CHAN-Q400-B42',
    couponId: 'Q400-BIRCH-B42-20260719',
  },
  safetyEvidence: {
    kind: 'allowlisted',
    category: 'laser-approved-plywood',
    compositionKnown: true,
    manufacturer: 'Example Timber Company',
    productId: 'BIRCH-PLY-BATCH-42',
    laserSafetyReference: 'https://example.com/materials/birch-ply-b42-laser-safety',
  },
};

const settings = {
  splitPositionPercent: 50,
  ribCount: 6 as const,
  ringLayers: 2,
  shaftMm: 3,
  fit: 'snug' as const,
  materialId: readyMaterial.id,
  engravingLevels: 3 as const,
  textureStrength: 0.6,
  sheetWidthMm: 300,
  sheetHeightMm: 200,
};

const worker = {
  decompose: async ({ profile, material, options }: Parameters<typeof generateParts> extends never ? never : {
    profile: LathedProfile;
    material: Parameters<typeof generateParts>[1];
    options: Parameters<typeof generateParts>[2];
  }) => generateParts(profile, material, options),
  engrave: async ({ field, levels, options }: Parameters<typeof quantizeHeightField> extends never ? never : {
    field: Parameters<typeof quantizeHeightField>[0];
    levels: Parameters<typeof quantizeHeightField>[1];
    options?: Parameters<typeof quantizeHeightField>[2];
  }) => quantizeHeightField(field, levels, options),
};

describe('manufacturing vertical pipeline', () => {
  it('propagates radial split position into hub, rib, and nested CUT geometry', async () => {
    const base = input(
      'c'.repeat(64),
      lathedSurface([
        { z: -30, radius: 30 },
        { z: 0, radius: 30 },
        { z: 30, radius: 30 },
      ]),
    );
    const inner = await createManufacturingArtifacts({
      ...base,
      settings: { ...base.settings, splitPositionPercent: 30, ribCount: 4, ringLayers: 1 },
    }, worker);
    const outer = await createManufacturingArtifacts({
      ...base,
      settings: { ...base.settings, splitPositionPercent: 60, ribCount: 4, ringLayers: 1 },
    }, worker);
    const hubRadius = (artifacts: typeof inner): number => Math.max(...artifacts.kit.value.parts
      .find(({ kind }) => kind === 'hub-layer')!.outline.points.map(([x, y]) => Math.hypot(x, y)));
    const profileOuterRadius = Math.max(...inner.profile.value.samples.map(({ radius }) => radius));
    const cutGeometry = (artifacts: typeof inner) => artifacts.document.value.sheets.flatMap(({ entities }) => entities
      .filter(({ layer }) => layer === 'CUT')
      .map(({ contour, polygon }) => ({ contour, points: polygon.points })));

    expect(hubRadius(inner)).toBeCloseTo(profileOuterRadius * 0.3, 10);
    expect(hubRadius(outer)).toBeCloseTo(profileOuterRadius * 0.6, 10);
    expect(inner.kit.value.parts.find(({ kind }) => kind === 'rib')!.outline.points)
      .not.toEqual(outer.kit.value.parts.find(({ kind }) => kind === 'rib')!.outline.points);
    expect(cutGeometry(inner)).not.toEqual(cutGeometry(outer));
  });

  it.each([9, 91])('rejects an unsafe pipeline split position of %s percent', async (splitPositionPercent) => {
    const unsafe = input('d'.repeat(64), lathedSurface([
      { z: -30, radius: 30 },
      { z: 0, radius: 30 },
      { z: 30, radius: 30 },
    ]));
    await expect(createManufacturingArtifacts({
      ...unsafe,
      settings: { ...unsafe.settings, splitPositionPercent },
    }, worker)).rejects.toThrow(/split position|10.*90/i);
  });

  it('binds every artifact to one input version and produces different CUT geometry for meaningfully different meshes', async () => {
    const narrow = input(
      'a'.repeat(64),
      lathedSurface([
        { z: -12, radius: 9 },
        { z: -6, radius: 16 },
        { z: 0, radius: 22 },
        { z: 6, radius: 16 },
        { z: 12, radius: 9 },
      ]),
    );
    const wide = input(
      'b'.repeat(64),
      lathedSurface([
        { z: -12, radius: 11 },
        { z: -6, radius: 20 },
        { z: 0, radius: 28 },
        { z: 6, radius: 20 },
        { z: 12, radius: 11 },
      ]),
    );

    const first = await createManufacturingArtifacts(narrow, worker);
    const second = await createManufacturingArtifacts(wide, worker);

    expect(first.preflight.value.issues).toEqual([]);
    expect(second.preflight.value.issues).toEqual([]);
    expect(first.preflight.value.canExport).toBe(true);
    expect(second.preflight.value.canExport).toBe(true);
    expect(first.document.value.sheets.flatMap(({ entities }) => entities).filter(({ layer }) => layer === 'CUT').length).toBeGreaterThan(0);
    expect(JSON.stringify(first.document.value.sheets)).not.toBe(JSON.stringify(second.document.value.sheets));
    expect(first.provenance.inputFingerprint).not.toBe(second.provenance.inputFingerprint);
    for (const artifact of [first.profile, first.kit, first.material, first.engraving, first.layout, first.preflight, first.document]) {
      expect(artifact.provenance).toEqual(first.provenance);
    }
    expect(first.document.value.provenance.inputFingerprint).toBe(first.provenance.inputFingerprint);
  });
});

function input(sourceSha256: string, mesh: TriangleMesh): ManufacturingPipelineInput {
  return {
    sourceSha256,
    mesh,
    meshSha256: sourceSha256,
    repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1' },
    meshInspection: {
      triangleCount: mesh.indices.length / 3,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
      invertedVolume: false,
    },
    axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
    settings,
    material: readyMaterial,
  };
}

function lathedSurface(samples: LathedProfile['samples'], segments = 32): TriangleMesh {
  const positions: number[] = [];
  for (const { z, radius } of samples) for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment * Math.PI * 2 / segments;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
  }
  const indices: number[] = [];
  for (let ring = 0; ring + 1 < samples.length; ring += 1) for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const a = ring * segments + segment;
    const b = ring * segments + next;
    const c = (ring + 1) * segments + segment;
    const d = (ring + 1) * segments + next;
    indices.push(a, b, c, b, d, c);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}
