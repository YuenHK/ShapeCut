import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type { Polygon2 } from '../decomposition/types';
import { pointLocation, polygonsOverlapArea, validatePolygon } from '../engraving/geometry';
import { CalibrationCouponError, createCalibrationCoupon } from './calibration-coupon';
import {
  FIT_NAMES,
  MaterialProfileSchema,
  classifyMaterialReadiness,
  type MaterialProfileV1,
} from './schema';

const execFileAsync = promisify(execFile);

const recipes = {
  cut: { powerPercent: 82, speedMmPerSecond: 12, passes: 2, notes: 'Full cut starting point' },
  score: { powerPercent: 22, speedMmPerSecond: 90, passes: 1, notes: 'Light score' },
  engrave1: { powerPercent: 15, speedMmPerSecond: 140, passes: 1, notes: 'Lightest' },
  engrave2: null,
  engrave3: { powerPercent: 30, speedMmPerSecond: 110, passes: 1, notes: 'Medium' },
  engrave4: null,
  engrave5: { powerPercent: 48, speedMmPerSecond: 80, passes: 2, notes: 'Darkest' },
} as const;

const validProfile: MaterialProfileV1 = {
  schemaVersion: 1,
  id: 'q400-birch-batch-24-2.94',
  machine: 'Trotec Q400 #1',
  materialCode: 'PLY-BIRCH-B24',
  materialName: 'Laser-approved birch plywood',
  batchNotes: 'Manufacturer batch B24; measured at four corners',
  thicknessMm: 2.94,
  sheetWidthMm: 600,
  sheetHeightMm: 300,
  kerfMm: 0.14,
  fitAllowanceMm: { loose: 0.18, slip: 0.1, snug: 0.04, press: -0.04 },
  minFeatureMm: 0.8,
  minWebMm: 1.5,
  minRemainingMm: 1.2,
  recipes,
  calibratedAt: null,
  physicalCouponVerified: false,
  safetyEvidence: {
    kind: 'allowlisted',
    category: 'laser-approved-plywood',
    manufacturer: 'Example Timber Co.',
    productId: 'Birch Laser Ply B24',
    laserSafetyReference: 'https://manufacturer.invalid/birch-b24-laser-safety',
  },
};

function cloneProfile(overrides: Partial<MaterialProfileV1> = {}): MaterialProfileV1 {
  return structuredClone({ ...validProfile, ...overrides });
}

function expectZodError(value: unknown): void {
  try {
    MaterialProfileSchema.parse(value);
    expect.unreachable('profile should have been rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
}

function featurePolygons(coupon: ReturnType<typeof createCalibrationCoupon>): readonly Polygon2[] {
  return [
    ...coupon.fitSamples.map(({ polygon }) => polygon),
    coupon.kerfFeature.polygon,
    ...coupon.engravingSwatches.map(({ polygon }) => polygon),
  ];
}

async function probeCouponInIsolatedProcess(profile: MaterialProfileV1): Promise<{
  kind: string;
  elapsedMs: number;
  message?: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'spinner-coupon-probe-'));
  const probePath = join(directory, 'probe.ts');
  const moduleUrl = pathToFileURL(resolve('src/domain/materials/calibration-coupon.ts')).href;
  const source = `
    import { CalibrationCouponError, createCalibrationCoupon } from ${JSON.stringify(moduleUrl)};
    const profile = ${JSON.stringify(profile)};
    const started = performance.now();
    try {
      createCalibrationCoupon(profile, 3);
      process.stdout.write(JSON.stringify({ kind: 'returned', elapsedMs: performance.now() - started }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        kind: error instanceof CalibrationCouponError ? error.name : error?.constructor?.name ?? typeof error,
        elapsedMs: performance.now() - started,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  try {
    await writeFile(probePath, source, 'utf8');
    const { stdout } = await execFileAsync(resolve('node_modules/.bin/vite-node'), [probePath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 3_000,
      killSignal: 'SIGKILL',
    });
    return JSON.parse(String(stdout).trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('MaterialProfileSchema', () => {
  it.each([
    'PVC',
    'p v c',
    'P_V-C',
    'vinyl',
    'PVB',
    'PTFE',
    'Teflon',
    'carbon-fibre',
    'beryllium oxide',
    'chromium(VI) leather',
    'contains_halogen',
    'chlorinated polymer',
    'Sheet containing chlorine',
    'CHLORINE-COMPOUND-1',
    'EPOXY',
    'Epoxy casting sheet',
    'PHENOLIC',
    'Phenolic casting sheet',
    'epoxy resin',
    'phenolic-resin',
  ])('rejects forbidden material identity %s with a controlled safety message', (materialCode) => {
    expect(() => MaterialProfileSchema.parse(cloneProfile({ materialCode }))).toThrowError(/not laser safe/i);
  });

  it('checks the recorded product identity as part of the denylist boundary', () => {
    const profile = cloneProfile({
      materialCode: 'SAFE-CODE',
      materialName: 'Apparently safe sheet',
      safetyEvidence: {
        ...validProfile.safetyEvidence,
        productId: 'P_V-C commercial sheet',
      },
    });

    expect(() => MaterialProfileSchema.parse(profile)).toThrowError(/not laser safe/i);
  });

  it('does not create a denylist alias by concatenating separate identity fields', () => {
    const profile = cloneProfile({
      materialCode: 'PV',
      materialName: 'Cork',
      safetyEvidence: {
        kind: 'allowlisted',
        category: 'cork',
        manufacturer: 'Example Cork Co.',
        productId: 'Cork sheet C24',
        laserSafetyReference: 'https://manufacturer.invalid/cork-c24',
      },
    });

    expect(MaterialProfileSchema.parse(profile)).toEqual(profile);
  });

  it.each(FIT_NAMES)('rejects a %s allowance that makes the physical slot width non-positive', (fit) => {
    const profile = cloneProfile({
      fitAllowanceMm: {
        ...validProfile.fitAllowanceMm,
        [fit]: -validProfile.thicknessMm,
      },
    });

    expectZodError(profile);
  });

  it('rejects null, sparse, non-finite, malformed, and unsupported-version records with Zod errors', () => {
    const sparseRecipes = { ...recipes } as Record<string, unknown>;
    delete sparseRecipes.engrave4;

    for (const value of [
      null,
      {},
      { ...validProfile, schemaVersion: 2 },
      { ...validProfile, thicknessMm: Number.POSITIVE_INFINITY },
      { ...validProfile, kerfMm: Number.NaN },
      { ...validProfile, minRemainingMm: validProfile.thicknessMm + 0.01 },
      { ...validProfile, fitAllowanceMm: { loose: 0.1 } },
      { ...validProfile, recipes: sparseRecipes },
      { ...validProfile, recipes: { ...recipes, cut: { ...recipes.cut, powerPercent: 101 } } },
      { ...validProfile, recipes: { ...recipes, cut: { ...recipes.cut, speedMmPerSecond: 0 } } },
      { ...validProfile, recipes: { ...recipes, cut: { ...recipes.cut, passes: 1.5 } } },
    ]) expectZodError(value);
  });

  it('requires reliable manufacturer identity and safety evidence for a custom material', () => {
    const custom = cloneProfile({
      safetyEvidence: {
        kind: 'custom',
        manufacturer: 'Known Sheet Co.',
        productId: 'CUSTOM-42',
        laserSafetyReference: 'https://manufacturer.invalid/custom-42',
        compositionKnown: true,
      },
    });

    expect(MaterialProfileSchema.parse(custom)).toEqual(custom);
    expectZodError({ ...custom, safetyEvidence: { ...custom.safetyEvidence, manufacturer: '' } });
    expectZodError({ ...custom, safetyEvidence: { ...custom.safetyEvidence, laserSafetyReference: '' } });
  });

  it.each(['', '   ', '\n\t'])('rejects blank exact-batch evidence %j', (batchNotes) => {
    expectZodError(cloneProfile({ batchNotes }));
  });
});

describe('classifyMaterialReadiness', () => {
  it('returns confirm with machine-readable and user-readable reasons for an identified uncalibrated material', () => {
    const result = classifyMaterialReadiness(validProfile);

    expect(result.status).toBe('confirm');
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'physical-calibration-required' }));
    expect(result.reasons.every(({ message }) => message.length > 0)).toBe(true);
  });

  it('blocks an unknown-composition custom material even if a date and checkbox were filled', () => {
    const result = classifyMaterialReadiness(cloneProfile({
      calibratedAt: '2026-07-19T00:00:00.000Z',
      physicalCouponVerified: true,
      safetyEvidence: {
        kind: 'custom',
        manufacturer: 'Mystery Sheet Vendor',
        productId: 'UNKNOWN-COMPOSITION-1',
        laserSafetyReference: 'https://manufacturer.invalid/unknown-composition',
        compositionKnown: false,
      },
    }));

    expect(result.status).toBe('block');
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'unknown-composition' }));
  });

  it('returns ready only for identified and physically calibrated material', () => {
    const result = classifyMaterialReadiness(cloneProfile({
      calibratedAt: '2026-07-19T00:00:00.000Z',
      physicalCouponVerified: true,
    }));

    expect(result).toEqual({ status: 'ready', reasons: [] });
  });

  it('blocks a forbidden identity instead of throwing an accidental runtime error', () => {
    const result = classifyMaterialReadiness(cloneProfile({ materialCode: 'p_v-c' }));

    expect(result.status).toBe('block');
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'material-not-laser-safe' }));
  });

  it('blocks generic plastic recorded in the product identity', () => {
    const result = classifyMaterialReadiness(cloneProfile({
      safetyEvidence: {
        ...validProfile.safetyEvidence,
        productId: 'GENERIC_PLASTIC_SHEET',
      },
    }));

    expect(result.status).toBe('block');
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'unknown-identity' }));
  });

  it('blocks an allowlisted category that does not match the recorded material identity', () => {
    const profile = cloneProfile({
      materialCode: 'POLYMER-X42',
      materialName: 'Opaque polymer sheet',
      calibratedAt: '2026-07-19T00:00:00.000Z',
      physicalCouponVerified: true,
      safetyEvidence: {
        kind: 'allowlisted',
        category: 'cork',
        manufacturer: 'Example Polymer Co.',
        productId: 'POLYMER-X42',
        laserSafetyReference: 'https://manufacturer.invalid/polymer-x42',
      },
    });

    expect(MaterialProfileSchema.safeParse(profile).success).toBe(false);
    expect(classifyMaterialReadiness(profile)).toEqual(expect.objectContaining({ status: 'block' }));
  });

  it('blocks explicit unknown composition even when an allowlisted category keyword is present', () => {
    const result = classifyMaterialReadiness(cloneProfile({
      materialCode: 'CAST-ACRYLIC-UNKNOWN',
      materialName: 'Plastic with unknown composition',
      calibratedAt: '2026-07-19T00:00:00.000Z',
      physicalCouponVerified: true,
      safetyEvidence: {
        kind: 'allowlisted',
        category: 'laser-rated-cast-acrylic',
        manufacturer: 'Mystery Polymer Co.',
        productId: 'UNKNOWN-CAST-ACRYLIC',
        laserSafetyReference: 'https://manufacturer.invalid/unknown-cast-acrylic',
      },
    }));

    expect(result.status).toBe('block');
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'unknown-composition' }));
  });
});

describe('createCalibrationCoupon', () => {
  it.each([3, 4, 5] as const)('creates deterministic valid geometry with exactly %i engraving swatches', (levels) => {
    const profile = cloneProfile();
    const before = structuredClone(profile);

    const first = createCalibrationCoupon(profile, levels);
    const second = createCalibrationCoupon(profile, levels);
    const roundTripped = JSON.parse(JSON.stringify(first));

    expect(profile).toEqual(before);
    expect(first.fitSamples.length).toBeGreaterThanOrEqual(5);
    expect(new Set(first.fitSamples.map(({ allowanceMm }) => allowanceMm)).size).toBe(first.fitSamples.length);
    expect(first.fitSamples.every(({ allowanceMm, label }) => label.includes(String(allowanceMm)))).toBe(true);
    for (const sample of first.fitSamples) {
      const yCoordinates = sample.polygon.points.map(([, y]) => y);
      const physicalSlotWidth = Math.max(...yCoordinates) - Math.min(...yCoordinates);
      expect(sample.slotWidthMm).toBeCloseTo(profile.thicknessMm + sample.allowanceMm, 10);
      expect(physicalSlotWidth).toBeCloseTo(sample.slotWidthMm, 10);
    }
    expect(first.kerfFeature.kind).toBe('kerf');
    expect(first.engravingSwatches).toHaveLength(levels);
    expect(first.engravingSwatches.map(({ level }) => level)).toEqual(Array.from({ length: levels }, (_, index) => index + 1));
    expect(first).toEqual(second);
    expect(roundTripped).toEqual(first);

    const polygons = featurePolygons(first);
    expect(validatePolygon(first.outline)).toBe(true);
    expect(polygons.every(validatePolygon)).toBe(true);
    expect(polygons.every((polygon) => polygon.points.every((point) => pointLocation(first.outline, point) === 1))).toBe(true);
    for (let left = 0; left < polygons.length; left += 1) {
      for (let right = left + 1; right < polygons.length; right += 1) {
        expect(polygonsOverlapArea(polygons[left], polygons[right])).toBe(false);
      }
    }
  });

  it('rejects unsupported engraving counts', () => {
    expect(() => createCalibrationCoupon(validProfile, 2 as never)).toThrowError(/3, 4, or 5/);
    expect(() => createCalibrationCoupon(validProfile, 6 as never)).toThrowError(/3, 4, or 5/);
  });

  it('preserves the exact recorded allowance value in coupon metadata', () => {
    const exactAllowance = 0.123456789123;
    const profile = cloneProfile({
      fitAllowanceMm: { ...validProfile.fitAllowanceMm, loose: exactAllowance },
    });

    const coupon = createCalibrationCoupon(profile, 3);
    const sample = coupon.fitSamples.find(({ allowanceMm }) => allowanceMm === exactAllowance);

    expect(sample?.allowanceMm).toBe(exactAllowance);
    expect(sample?.slotWidthMm).toBe(profile.thicknessMm + exactAllowance);
  });

  it('keeps every recorded and fallback fit sample finite with a positive physical slot width', () => {
    const profile = cloneProfile({
      thicknessMm: 1,
      minRemainingMm: 0.5,
      fitAllowanceMm: { loose: -0.99, slip: -0.99, snug: -0.99, press: -0.99 },
    });

    const coupon = createCalibrationCoupon(profile, 3);

    expect(coupon.fitSamples).toHaveLength(5);
    expect(coupon.fitSamples.every(({ allowanceMm, slotWidthMm }) => (
      Number.isFinite(allowanceMm)
      && Number.isFinite(slotWidthMm)
      && slotWidthMm > 0
      && slotWidthMm === profile.thicknessMm + allowanceMm
    ))).toBe(true);
  });

  it('terminates quickly with a typed error when finite inputs cannot produce finite coupon geometry', async () => {
    const profile = cloneProfile({
      fitAllowanceMm: { loose: 1e308, slip: 1e308, snug: 1e308, press: 1e308 },
    });

    const result = await probeCouponInIsolatedProcess(profile);

    expect(result.kind).toBe(CalibrationCouponError.name);
    expect(result.elapsedMs).toBeLessThan(250);
    expect(result.message).toMatch(/geometry|coupon/i);
  }, 7_000);

  it('blocks coupon generation for unknown-composition and forbidden material', () => {
    const unknown = cloneProfile({
      safetyEvidence: {
        kind: 'custom',
        manufacturer: 'Mystery Sheet Vendor',
        productId: 'UNKNOWN-1',
        laserSafetyReference: 'https://manufacturer.invalid/unknown-1',
        compositionKnown: false,
      },
    });

    expect(() => createCalibrationCoupon(unknown, 3)).toThrowError(/unknown composition|blocked/i);
    expect(() => createCalibrationCoupon(cloneProfile({ materialCode: 'vinyl' }), 3)).toThrowError(/not laser safe|blocked/i);
  });
});

export { validProfile };
