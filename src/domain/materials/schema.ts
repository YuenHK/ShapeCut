import { z } from 'zod';

export const FIT_NAMES = ['loose', 'slip', 'snug', 'press'] as const;
export const PROCESS_NAMES = ['cut', 'score', 'engrave1', 'engrave2', 'engrave3', 'engrave4', 'engrave5'] as const;

const requiredText = z.string().trim().min(1).max(500);
const notesText = z.string().max(4_000);
const batchNotesText = notesText
  .refine((value) => value.trim().length > 0, {
    message: 'Batch notes must identify the exact material batch.',
  })
  .refine((value) => !hasUnknownBatchIdentity(value), {
    message: 'Batch notes cannot identify the material batch as unknown or unidentified.',
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
  'laser-approved-plywood': ['plywood', 'ply', 'laserply', 'woodply', 'birchply'],
  'laser-approved-wood': ['wood', 'timber', 'balsa', 'basswood'],
  paper: ['paper'],
  cardboard: ['cardboard', 'cardstock', 'corrugatedcard'],
  cork: ['cork'],
  'laser-rated-cast-acrylic': ['acrylic', 'pmma', 'castacrylic', 'acryliccast', 'laserratedacrylic'],
} as const satisfies Record<z.infer<typeof AllowlistedMaterialCategorySchema>, readonly string[]>;

const allowlistedCategoryContradictionTokens = {
  'laser-approved-plywood': ['metal', 'steel', 'stainless', 'plastic', 'polymer', 'acrylic', 'paper', 'cardboard', 'cork'],
  'laser-approved-wood': ['metal', 'steel', 'stainless', 'plastic', 'polymer', 'acrylic', 'paper', 'cardboard', 'cork'],
  paper: ['clip', 'paperclip', 'metal', 'steel', 'stainless', 'plastic', 'polymer', 'acrylic', 'wood', 'plywood', 'cork'],
  cardboard: ['metal', 'steel', 'stainless', 'plastic', 'polymer', 'acrylic', 'wood', 'plywood', 'cork'],
  cork: ['metal', 'steel', 'stainless', 'plastic', 'polymer', 'acrylic', 'paper', 'cardboard', 'wood', 'plywood'],
  'laser-rated-cast-acrylic': ['metal', 'steel', 'stainless', 'plastic', 'polymer', 'wood', 'plywood', 'paper', 'cardboard', 'cork'],
} as const satisfies Record<z.infer<typeof AllowlistedMaterialCategorySchema>, readonly string[]>;

const EvidenceFields = {
  manufacturer: requiredText,
  productId: requiredText,
  laserSafetyReference: requiredText,
  compositionKnown: z.boolean(),
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
  }).strict(),
]);

export const QualifiedOperatorApprovalSchema = z.object({
  operatorName: requiredText,
  qualification: requiredText,
  signedAt: z.string().datetime({ offset: true }),
  signature: requiredText,
  couponId: requiredText,
}).strict();

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
  'halogenated',
  'halide',
  'chloro',
  'chlorine',
  'chloride',
  'chlorinated',
  'fluorine',
  'fluoro',
  'fluoride',
  'bromine',
  'bromo',
  'bromide',
  'brominated',
  'fluorinated',
  'iodine',
  'iodo',
  'iodide',
  'iodinated',
  'astatine',
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

function identityTerms(value: string): string[] {
  const words = value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((word) => word.length > 0);
  return [...new Set([...words, words.join('')])];
}

function hasUnknownBatchIdentity(value: string): boolean {
  const compact = normalizeMaterialIdentity(value);
  const terms = new Set(identityTerms(value));
  const hasUnknownMarker = ['unknown', 'unidentified', 'mystery'].some((term) => terms.has(term));
  return (terms.has('batch') && hasUnknownMarker)
    || ['unknownbatch', 'batchunknown', 'unidentifiedbatch', 'batchunidentified']
      .some((token) => compact.includes(token));
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
  const tokens = [
    'unknowncomposition', 'compositionunknown',
    'unknownmaterial', 'materialunknown',
    'unknownpolymer', 'polymerunknown',
    'unidentifiedmaterial', 'materialunidentified',
    'mysterymaterial', 'mysterypolymer',
  ];
  return [code, name, productId].some((value) => {
    const compact = normalizeMaterialIdentity(value);
    const terms = new Set(identityTerms(value));
    const hasUnknownMarker = ['unknown', 'unidentified', 'mystery'].some((term) => terms.has(term));
    const namesComposition = ['composition', 'material', 'polymer'].some((term) => terms.has(term));
    return (hasUnknownMarker && namesComposition)
      || tokens.some((token) => compact.includes(token));
  });
}

function allowlistedCategoryMatchesIdentity(
  category: z.infer<typeof AllowlistedMaterialCategorySchema>,
  code: string,
  name: string,
  productId: string,
): boolean {
  const expectedTokens = allowlistedCategoryIdentityTokens[category];
  const contradictionTokens = allowlistedCategoryContradictionTokens[category];
  const terms = new Set([code, name, productId].flatMap(identityTerms));
  return expectedTokens.some((token) => terms.has(token))
    && !contradictionTokens.some((token) => terms.has(token));
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
  operatorApproval: QualifiedOperatorApprovalSchema.optional(),
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
  if (profile.safetyEvidence.kind === 'allowlisted' && !profile.safetyEvidence.compositionKnown) {
    context.addIssue({
      code: 'custom',
      path: ['safetyEvidence', 'compositionKnown'],
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
  if (profile.operatorApproval !== undefined && (!profile.physicalCouponVerified || profile.calibratedAt === null)) {
    context.addIssue({
      code: 'custom',
      path: ['operatorApproval'],
      message: 'Signed operator approval requires a verified physical coupon and calibration date.',
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
  | 'physical-calibration-required'
  | 'operator-approval-required'
  | 'material-identity-incomplete';

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
  const reasons: MaterialReadiness['reasons'] = [];
  if ([
    profile.machine,
    profile.materialCode,
    profile.materialName,
    profile.batchNotes,
    profile.safetyEvidence.manufacturer,
    profile.safetyEvidence.productId,
    profile.safetyEvidence.laserSafetyReference,
  ].some(hasPlaceholderEvidence)) {
    reasons.push({ code: 'material-identity-incomplete', message: 'Replace every pending machine, product, batch, manufacturer, and safety-reference placeholder with exact evidence.' });
  }
  if (profile.calibratedAt === null || !profile.physicalCouponVerified) {
    reasons.push({ code: 'physical-calibration-required', message: 'Cut and inspect a physical calibration coupon for this exact machine, material batch, and thickness.' });
  }
  if (profile.operatorApproval === undefined) {
    reasons.push({ code: 'operator-approval-required', message: 'A qualified operator must sign the physical coupon evidence before production export.' });
  }
  return reasons.length === 0 ? { status: 'ready', reasons } : { status: 'confirm', reasons };
}

function hasPlaceholderEvidence(value: string): boolean {
  const normalized = value.normalize('NFKC').toLowerCase().replaceAll(/[^a-z0-9.]+/gu, '');
  return normalized.includes('replace')
    || normalized.includes('pending')
    || normalized.includes('precalibration')
    || normalized.includes('manufacturer.invalid');
}

export function parseMaterialProfile(value: unknown): MaterialProfileV1 {
  return MaterialProfileSchema.parse(value);
}
