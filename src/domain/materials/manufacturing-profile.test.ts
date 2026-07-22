import { describe, expect, it } from 'vitest';
import type { MaterialProfileV1 } from './schema';
import {
  manufacturingGeometryProfile,
  validateManufacturingGeometryProfile,
} from './manufacturing-profile';

const validProfile: MaterialProfileV1 = {
  schemaVersion: 1,
  id: 'q400-birch-24-2.94',
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
  recipes: { cut: null, score: null, engrave1: null, engrave2: null, engrave3: null, engrave4: null, engrave5: null },
  calibratedAt: null,
  physicalCouponVerified: false,
  safetyEvidence: {
    kind: 'allowlisted', category: 'laser-approved-plywood', compositionKnown: true,
    manufacturer: 'Example Timber Co.', productId: 'Birch Laser Ply B24',
    laserSafetyReference: 'https://manufacturer.invalid/birch-b24-laser-safety',
  },
};

describe('manufacturing geometry profile', () => {
  it('projects a validated material profile to only the geometry contract', () => {
    const geometry = manufacturingGeometryProfile(validProfile);

    expect(geometry).toEqual({
      id: validProfile.id,
      name: validProfile.materialName,
      thicknessMm: validProfile.thicknessMm,
      kerfMm: validProfile.kerfMm,
      minFeatureMm: validProfile.minFeatureMm,
      minWebMm: validProfile.minWebMm,
      fitAllowanceMm: validProfile.fitAllowanceMm,
    });
    expect(JSON.stringify(geometry)).not.toMatch(/operator|batch|signature|manufacturer/i);
  });

  it('rejects an invalid geometry value after structured cloning', () => {
    const geometry = structuredClone(manufacturingGeometryProfile(validProfile));

    expect(() => validateManufacturingGeometryProfile({ ...geometry, kerfMm: -1 })).toThrow(/kerf/i);
  });
});
