import { z } from 'zod';

export const FIT_NAMES = ['loose', 'slip', 'snug', 'press'] as const;
export const PROCESS_NAMES = ['cut', 'score', 'engrave1', 'engrave2', 'engrave3', 'engrave4', 'engrave5'] as const;

const requiredText = z.string().trim().min(1).max(500);
const notesText = z.string().max(4_000);
const batchNotesText = notesText.refine((value) => value.trim().length > 0, {
  message: 'Batch notes must identify the exact material batch.',
});
const finiteMillimetres = z.number().finite();

export const ProcessRecipeSchema = z.object({
  powerPercent: z.number().finite().min(0).max(100),
  speedMmPerSecond: z.number().finite().gt(0).max(10_000),
  passes: z.number().int().positive().max(100),
  notes: notesText,
}).strict();

const FitAllowanceSchema = z.object({
  loose: finiteMillimetres,
  slip: finiteMillimetres,
  snug: finiteMillimetres,
  press: finiteMillimetres,
}).strict();

const RecipesSchema = z.object({
  cut: ProcessRecipeSchema.nullable(),
  score: ProcessRecipeSchema.nullable(),
  engrave1: ProcessRecipeSchema.nullable(),
  engrave2: ProcessRecipeSchema.nullable(),
  engrave3: ProcessRecipeSchema.nullable(),
  engrave4: ProcessRecipeSchema.nullable(),
  engrave5: ProcessRecipeSchema.nullable(),
}).strict();

export const AllowlistedMaterialCategorySchema = z.enum([
  'laser-approved-plywood',
  'laser-approved-wood',
  'paper',
  'cardboard',
  'cork',
  'laser-rated-cast-acrylic',
]);

const allowlistedCategoryIdentityTokens = {
  'laser-approved-plywood': ['plywood', 'laserply', 'woodply'],
  'laser-approved-wood': ['wood', 'timber', 'balsa'],
  paper: ['paper'],
  cardboard: ['cardboard', 'cardstock', 'corrugatedcard'],
  cork: ['cork'],
  'laser-rated-cast-acrylic': ['castacrylic', 'acryliccast', 'laserratedacrylic'],
} as const satisfies Record<z.infer<typeof AllowlistedMaterialCategorySchema>, readonly string[]>;

const EvidenceFields = {
  manufacturer: requiredText,
  productId: requiredText,
  laserSafetyReference: requiredText,
} as const;

export const MaterialSafetyEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('allowlisted'),
    category: AllowlistedMaterialCategorySchema,
    ...EvidenceFields,
  }).strict(),
  z.object({
    kind: z.literal('custom'),
    ...EvidenceFields,
    compositionKnown: z.boolean(),
  }).strict(),
]);

const normalizedForbiddenTokens = [
  'pvc',
  'polyvinylchloride',
  'vinyl',
  'pvb',
  'polyvinylbutyral',
  'ptfe',
  'teflon',
  'polytetrafluoroethylene',
  'carbonfibre',
  'carbonfiber',
  'berylliumoxide',
  'chromiumvileather',
  'chromium6leather',
  'halogen',
  'chlorine',
  'chloride',
  'chlorinated',
  'fluorine',
  'fluoride',
  'bromine',
  'bromide',
  'brominated',
  'fluorinated',
  'iodine',
  'iodide',
  'iodinated',
  'epoxy',
  'epoxyresin',
  'phenolic',
  'phenolicresin',
] as const;

/** Normalization is intentionally exported so import/migration boundaries can apply the same denylist rule. */
export function normalizeMaterialIdentity(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[\s_-]+/gu, '')
    .replace(/[^\p{Letter}\p{Number}]/gu, '');
}

function normalizedMaterialIdentities(code: string, name: string, productId: string): string[] {
  return [code, name, productId].map(normalizeMaterialIdentity);
}

export function isForbiddenMaterialIdentity(code: string, name = '', productId = ''): boolean {
  const identities = normalizedMaterialIdentities(code, name, productId);
  return identities.some((identity) => normalizedForbiddenTokens.some((token) => identity.includes(token)));
}

function isUnknownPlasticIdentity(code: string, name: string, productId: string): boolean {
  const identities = normalizedMaterialIdentities(code, name, productId);
  return identities.some((identity) => identity === 'plastic' || identity.includes('genericplastic') || identity.includes('unknownplastic'));
}

function hasUnknownCompositionIdentity(code: string, name: string, productId: string): boolean {
  const tokens = ['unknowncomposition', 'unknownmaterial', 'unknownpolymer', 'unidentifiedmaterial', 'mysterymaterial', 'mysterypolymer'];
  return normalizedMaterialIdentities(code, name, productId)
    .some((identity) => tokens.some((token) => identity.includes(token)));
}

function allowlistedCategoryMatchesIdentity(
  category: z.infer<typeof AllowlistedMaterialCategorySchema>,
  code: string,
  name: string,
  productId: string,
): boolean {
  const expectedTokens = allowlistedCategoryIdentityTokens[category];
  return normalizedMaterialIdentities(code, name, productId)
    .some((identity) => expectedTokens.some((token) => identity.includes(token)));
}

const MaterialProfileShape = z.object({
  schemaVersion: z.literal(1),
  id: requiredText,
  machine: requiredText,
  materialCode: requiredText,
  materialName: requiredText,
  batchNotes: batchNotesText,
  thicknessMm: finiteMillimetres.positive(),
  sheetWidthMm: finiteMillimetres.positive(),
  sheetHeightMm: finiteMillimetres.positive(),
  kerfMm: finiteMillimetres.nonnegative(),
  fitAllowanceMm: FitAllowanceSchema,
  minFeatureMm: finiteMillimetres.positive(),
  minWebMm: finiteMillimetres.positive(),
  minRemainingMm: finiteMillimetres.positive(),
  recipes: RecipesSchema,
  calibratedAt: z.string().datetime({ offset: true }).nullable(),
  physicalCouponVerified: z.boolean(),
  safetyEvidence: MaterialSafetyEvidenceSchema,
}).strict();

export const MaterialProfileSchema = MaterialProfileShape.superRefine((profile, context) => {
  if (isForbiddenMaterialIdentity(profile.materialCode, profile.materialName, profile.safetyEvidence.productId)) {
    context.addIssue({
      code: 'custom',
      path: ['materialCode'],
      message: 'This material identity is not laser safe.',
    });
  }
  if (isUnknownPlasticIdentity(profile.materialCode, profile.materialName, profile.safetyEvidence.productId)) {
    context.addIssue({
      code: 'custom',
      path: ['materialCode'],
      message: 'Generic or unknown plastic is not an allowlisted material identity.',
    });
  }
  if (hasUnknownCompositionIdentity(profile.materialCode, profile.materialName, profile.safetyEvidence.productId)) {
    context.addIssue({
      code: 'custom',
      path: ['materialCode'],
      message: 'Unknown material composition cannot be laser verified.',
    });
  }
  if (profile.safetyEvidence.kind === 'allowlisted' && !allowlistedCategoryMatchesIdentity(
    profile.safetyEvidence.category,
    profile.materialCode,
    profile.materialName,
    profile.safetyEvidence.productId,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['safetyEvidence', 'category'],
      message: 'Allowlisted category does not match the recorded material identity.',
    });
  }
  if (profile.minRemainingMm > profile.thicknessMm) {
    context.addIssue({
      code: 'custom',
      path: ['minRemainingMm'],
      message: 'Minimum safe remaining thickness cannot exceed sheet thickness.',
    });
  }
  for (const fit of FIT_NAMES) {
    const slotWidthMm = profile.thicknessMm + profile.fitAllowanceMm[fit];
    if (!Number.isFinite(slotWidthMm) || slotWidthMm <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['fitAllowanceMm', fit],
        message: `The ${fit} allowance must produce a finite positive physical slot width.`,
      });
    }
  }
  if (profile.physicalCouponVerified && profile.calibratedAt === null) {
    context.addIssue({
      code: 'custom',
      path: ['calibratedAt'],
      message: 'A verified physical coupon requires a calibration date.',
    });
  }
});

/** Alias retained for callers that name the version explicitly. */
export const MaterialProfileV1Schema = MaterialProfileSchema;

export type ProcessRecipe = z.infer<typeof ProcessRecipeSchema>;
export type MaterialSafetyEvidence = z.infer<typeof MaterialSafetyEvidenceSchema>;
export type MaterialProfileV1 = z.infer<typeof MaterialProfileSchema>;

export type MaterialReadinessReasonCode =
  | 'material-not-laser-safe'
  | 'unknown-identity'
  | 'unknown-composition'
  | 'invalid-profile'
  | 'physical-calibration-required';

export type MaterialReadiness = {
  status: 'ready' | 'confirm' | 'block';
  reasons: Array<{
    code: MaterialReadinessReasonCode;
    message: string;
  }>;
};

export function classifyMaterialReadiness(value: unknown): MaterialReadiness {
  const parsed = MaterialProfileSchema.safeParse(value);
  if (!parsed.success) {
    const messages = parsed.error.issues.map(({ message }) => message);
    if (messages.some((message) => /not laser safe/i.test(message))) {
      return {
        status: 'block',
        reasons: [{ code: 'material-not-laser-safe', message: 'The recorded material identity is not laser safe.' }],
      };
    }
    if (messages.some((message) => /generic or unknown plastic/i.test(message))) {
      return {
        status: 'block',
        reasons: [{ code: 'unknown-identity', message: 'Generic or unknown plastic has no reliable laser-safe identity.' }],
      };
    }
    if (messages.some((message) => /unknown material composition/i.test(message))) {
      return {
        status: 'block',
        reasons: [{ code: 'unknown-composition', message: 'The recorded material composition is unknown and remains blocked.' }],
      };
    }
    if (messages.some((message) => /allowlisted category does not match/i.test(message))) {
      return {
        status: 'block',
        reasons: [{ code: 'unknown-identity', message: 'The allowlisted category does not match the recorded material identity.' }],
      };
    }
    return {
      status: 'block',
      reasons: [{ code: 'invalid-profile', message: 'The material profile is malformed or uses an unsupported schema version.' }],
    };
  }

  const profile = parsed.data;
  if (profile.safetyEvidence.kind === 'custom' && !profile.safetyEvidence.compositionKnown) {
    return {
      status: 'block',
      reasons: [{ code: 'unknown-composition', message: 'The custom material composition is unknown and remains blocked.' }],
    };
  }
  if (profile.calibratedAt === null || !profile.physicalCouponVerified) {
    return {
      status: 'confirm',
      reasons: [{ code: 'physical-calibration-required', message: 'Cut and inspect a physical calibration coupon for this exact machine, material batch, and thickness.' }],
    };
  }
  return { status: 'ready', reasons: [] };
}

export function parseMaterialProfile(value: unknown): MaterialProfileV1 {
  return MaterialProfileSchema.parse(value);
}
