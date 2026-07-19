import type { MaterialProfileV1 } from './schema';

const recipes: MaterialProfileV1['recipes'] = {
  cut: { powerPercent: 50, speedMmPerSecond: 20, passes: 1, notes: 'Unverified starting point; replace from operator coupon evidence.' },
  score: null,
  engrave1: { powerPercent: 10, speedMmPerSecond: 100, passes: 1, notes: 'Unverified level 1.' },
  engrave2: { powerPercent: 15, speedMmPerSecond: 100, passes: 1, notes: 'Unverified level 2.' },
  engrave3: { powerPercent: 20, speedMmPerSecond: 100, passes: 1, notes: 'Unverified level 3.' },
  engrave4: null,
  engrave5: null,
};

function pendingProfile(
  id: string,
  materialCode: string,
  materialName: string,
  category: Extract<MaterialProfileV1['safetyEvidence'], { kind: 'allowlisted' }>['category'],
  thicknessMm: number,
): MaterialProfileV1 {
  return {
    schemaVersion: 1,
    id,
    machine: 'REPLACE-WITH-QUALIFIED-MACHINE',
    materialCode,
    materialName,
    batchNotes: 'PRE-CALIBRATION BATCH - replace with exact product lot and signed operator evidence',
    thicknessMm,
    sheetWidthMm: 300,
    sheetHeightMm: 200,
    kerfMm: 0.15,
    fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 },
    minFeatureMm: 0.8,
    minWebMm: 0.4,
    minRemainingMm: Math.min(1.2, thicknessMm * 0.5),
    recipes: structuredClone(recipes),
    calibratedAt: null,
    physicalCouponVerified: false,
    safetyEvidence: {
      kind: 'allowlisted',
      category,
      compositionKnown: true,
      manufacturer: 'REPLACE-WITH-MANUFACTURER',
      productId: materialCode,
      laserSafetyReference: 'https://manufacturer.invalid/replace-before-use',
    },
  };
}

export const DEFAULT_PENDING_MATERIAL_PROFILES: readonly MaterialProfileV1[] = [
  pendingProfile('plywood-3', 'BIRCH-PLY-PENDING', 'Laser-approved birch plywood pending batch verification', 'laser-approved-plywood', 3),
  pendingProfile('acrylic-3', 'CAST-PMMA-PENDING', 'Laser-rated cast acrylic pending product verification', 'laser-rated-cast-acrylic', 3),
  pendingProfile('cardboard-2', 'CARDBOARD-PENDING', 'Cardboard pending batch verification', 'cardboard', 2),
  pendingProfile('cork-3', 'CORK-PENDING', 'Cork pending batch verification', 'cork', 3),
];

export function defaultPendingMaterialProfile(id: string): MaterialProfileV1 | undefined {
  const profile = DEFAULT_PENDING_MATERIAL_PROFILES.find((candidate) => candidate.id === id);
  return profile ? structuredClone(profile) : undefined;
}
