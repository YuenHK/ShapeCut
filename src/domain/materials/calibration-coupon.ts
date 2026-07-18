import type { Point2, Polygon2 } from '../decomposition/types';
import { pointLocation, polygonsOverlapArea, validatePolygon } from '../engraving/geometry';
import { classifyMaterialReadiness, MaterialProfileSchema, type MaterialProfileV1, type ProcessRecipe } from './schema';

export type EngravingLevelCount = 3 | 4 | 5;

export type CalibrationCoupon = {
  schemaVersion: 1;
  profileId: string;
  machine: string;
  materialCode: string;
  thicknessMm: number;
  engravingLevels: EngravingLevelCount;
  outline: Polygon2;
  fitSamples: Array<{
    id: string;
    kind: 'fit-slot';
    allowanceMm: number;
    slotWidthMm: number;
    polygon: Polygon2;
    label: string;
  }>;
  kerfFeature: {
    id: string;
    kind: 'kerf';
    expectedKerfMm: number;
    polygon: Polygon2;
    label: string;
    measurementMethod: string;
  };
  engravingSwatches: Array<{
    id: string;
    kind: 'engraving-swatch';
    level: number;
    recipeName: `engrave${1 | 2 | 3 | 4 | 5}`;
    recipe: ProcessRecipe | null;
    polygon: Polygon2;
    label: string;
  }>;
  labels: Array<{
    text: string;
    position: Point2;
    layer: 'annotation';
  }>;
  metadata: {
    units: 'mm';
    purpose: 'physical-material-calibration';
    profileFingerprint: string;
  };
};

export class CalibrationCouponError extends Error {
  readonly name = 'CalibrationCouponError';
}

function rectangle(x: number, y: number, width: number, height: number): Polygon2 {
  return { points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]] };
}

function fitAllowances(profile: MaterialProfileV1): number[] {
  const values: number[] = [];
  const add = (candidate: number): void => {
    const slotWidthMm = profile.thicknessMm + candidate;
    if (!Number.isFinite(candidate) || !Number.isFinite(slotWidthMm) || slotWidthMm <= 0) return;
    if (!values.includes(candidate)) values.push(candidate);
  };
  add(profile.fitAllowanceMm.loose);
  add(profile.fitAllowanceMm.slip);
  add(profile.fitAllowanceMm.snug);
  add(profile.fitAllowanceMm.press);
  add(0);
  const base = profile.fitAllowanceMm.snug;
  const increment = Math.max(
    0.05,
    profile.thicknessMm * 0.01,
    Math.abs(base) * Number.EPSILON * 8,
  );
  for (let step = 1; step <= 16 && values.length < 5; step += 1) {
    add(base + increment * step);
    add(base - increment * step);
  }
  if (values.length < 5) {
    throw new CalibrationCouponError('Calibration coupon could not generate five finite positive fit samples.');
  }
  return values.slice(0, 5);
}

function assertCouponGeometry(coupon: CalibrationCoupon): void {
  const features = [
    ...coupon.fitSamples.map(({ polygon }) => polygon),
    coupon.kerfFeature.polygon,
    ...coupon.engravingSwatches.map(({ polygon }) => polygon),
  ];
  if (!validatePolygon(coupon.outline) || features.some((polygon) => !validatePolygon(polygon))) {
    throw new CalibrationCouponError('Calibration coupon contains invalid polygon geometry.');
  }
  if (features.some((polygon) => polygon.points.some((point) => pointLocation(coupon.outline, point) !== 1))) {
    throw new CalibrationCouponError('Calibration coupon feature lies outside its outline.');
  }
  for (let left = 0; left < features.length; left += 1) {
    for (let right = left + 1; right < features.length; right += 1) {
      if (polygonsOverlapArea(features[left], features[right])) {
        throw new CalibrationCouponError('Calibration coupon removal features overlap.');
      }
    }
  }
}

export function createCalibrationCoupon(value: unknown, engravingLevels: EngravingLevelCount): CalibrationCoupon {
  if (engravingLevels !== 3 && engravingLevels !== 4 && engravingLevels !== 5) {
    throw new CalibrationCouponError('Calibration coupons require exactly 3, 4, or 5 engraving levels.');
  }
  const profile = MaterialProfileSchema.parse(value);
  const readiness = classifyMaterialReadiness(profile);
  if (readiness.status === 'block') {
    throw new CalibrationCouponError(`Calibration coupon is blocked: ${readiness.reasons.map(({ message }) => message).join(' ')}`);
  }

  const allowances = fitAllowances(profile);
  const slotWidths = allowances.map((allowanceMm) => profile.thicknessMm + allowanceMm);
  const fitRowY = 12;
  const engravingRowY = fitRowY + Math.max(...slotWidths) + 17;
  const fitSamples = allowances.map((allowanceMm, index) => ({
    id: `fit-${index + 1}`,
    kind: 'fit-slot' as const,
    allowanceMm,
    slotWidthMm: slotWidths[index],
    polygon: rectangle(6 + index * 22, fitRowY, 14, slotWidths[index]),
    label: `Fit ${index + 1}: ${allowanceMm} mm`,
  }));
  const engravingSwatches = Array.from({ length: engravingLevels }, (_, index) => {
    const level = index + 1 as 1 | 2 | 3 | 4 | 5;
    const recipeName = `engrave${level}` as const;
    return {
      id: `engraving-${level}`,
      kind: 'engraving-swatch' as const,
      level,
      recipeName,
      recipe: profile.recipes[recipeName] === null ? null : { ...profile.recipes[recipeName] },
      polygon: rectangle(38 + index * 16, engravingRowY, 12, 12),
      label: `Engraving level ${level}`,
    };
  });
  const kerfFeature = {
    id: 'kerf-measurement',
    kind: 'kerf' as const,
    expectedKerfMm: profile.kerfMm,
    polygon: rectangle(6, engravingRowY, 24, 12),
    label: `Kerf measurement: ${profile.kerfMm} mm recorded`,
    measurementMethod: 'Cut the marked feature, measure the removed width, and update the profile with the physical result.',
  };
  const coupon: CalibrationCoupon = {
    schemaVersion: 1,
    profileId: profile.id,
    machine: profile.machine,
    materialCode: profile.materialCode,
    thicknessMm: profile.thicknessMm,
    engravingLevels,
    outline: rectangle(0, 0, 120, engravingRowY + 18),
    fitSamples,
    kerfFeature,
    engravingSwatches,
    labels: [
      { text: `${profile.machine} / ${profile.materialCode} / ${profile.thicknessMm} mm`, position: [6, 5], layer: 'annotation' },
      ...fitSamples.map(({ label }, index) => ({ text: label, position: [6 + index * 22, fitRowY - 3] as Point2, layer: 'annotation' as const })),
      { text: kerfFeature.label, position: [6, engravingRowY - 4], layer: 'annotation' },
      ...engravingSwatches.map(({ label }, index) => ({ text: label, position: [38 + index * 16, engravingRowY - 4] as Point2, layer: 'annotation' as const })),
    ],
    metadata: {
      units: 'mm',
      purpose: 'physical-material-calibration',
      profileFingerprint: `${profile.id}|${profile.machine}|${profile.materialCode}|${profile.thicknessMm}`,
    },
  };
  assertCouponGeometry(coupon);
  return coupon;
}

/** Verb alias for downstream callers that use generation terminology. */
export const generateCalibrationCoupon = createCalibrationCoupon;
