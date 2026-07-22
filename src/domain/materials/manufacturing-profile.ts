import { z } from 'zod';
import { MaterialProfileSchema, type MaterialProfileV1 } from './schema';

const boundedText = z.string().trim().min(1).max(500);
const finiteMillimetres = z.number().finite();

const ManufacturingGeometryProfileSchema = z.object({
  id: boundedText,
  name: boundedText,
  thicknessMm: finiteMillimetres.positive(),
  kerfMm: finiteMillimetres.nonnegative(),
  minFeatureMm: finiteMillimetres.positive(),
  minWebMm: finiteMillimetres.positive(),
  fitAllowanceMm: z.object({
    loose: finiteMillimetres,
    slip: finiteMillimetres,
    snug: finiteMillimetres,
    press: finiteMillimetres,
  }).strict(),
}).strict().superRefine((profile, context) => {
  for (const fit of ['loose', 'slip', 'snug', 'press'] as const) {
    if (profile.thicknessMm + profile.fitAllowanceMm[fit] <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['fitAllowanceMm', fit],
        message: `The ${fit} allowance must produce a positive slot width.`,
      });
    }
  }
});

export type ManufacturingGeometryProfile = {
  readonly id: string;
  readonly name: string;
  readonly thicknessMm: number;
  readonly kerfMm: number;
  readonly minFeatureMm: number;
  readonly minWebMm: number;
  readonly fitAllowanceMm: Readonly<Record<'loose' | 'slip' | 'snug' | 'press', number>>;
};

/** Revalidates the exact data permitted to cross into geometry workers. */
export function validateManufacturingGeometryProfile(value: unknown): ManufacturingGeometryProfile {
  return ManufacturingGeometryProfileSchema.parse(value);
}

/** Projects a complete, safety-validated material profile to geometry-only evidence. */
export function manufacturingGeometryProfile(profile: MaterialProfileV1): ManufacturingGeometryProfile {
  const parsed = MaterialProfileSchema.parse(profile);
  return validateManufacturingGeometryProfile({
    id: parsed.id,
    name: parsed.materialName,
    thicknessMm: parsed.thicknessMm,
    kerfMm: parsed.kerfMm,
    minFeatureMm: parsed.minFeatureMm,
    minWebMm: parsed.minWebMm,
    fitAllowanceMm: parsed.fitAllowanceMm,
  });
}
