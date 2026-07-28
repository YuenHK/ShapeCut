import { z } from 'zod';
import {
  validateManufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from '../domain/materials/manufacturing-profile';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import { validateLauncherFitOffsetMm } from '../domain/outline-assembly/launcher-fit';
import {
  LAUNCHER_EXTERIOR_EXPANSION_MAX_MM,
  LAUNCHER_EXTERIOR_EXPANSION_MODE,
  normalizeLauncherExteriorExpansionMm,
  type LauncherExteriorExpansion,
} from '../domain/outline-assembly/launcher-exterior-expansion';
import type { DecorationOmission } from '../domain/outline-features/types';
import { createMaterialDatabase, type MaterialDatabase } from './database';

export type StoredOneClickProjectV2 = {
  readonly schemaVersion: 2;
  readonly id: 'one-click-current';
  readonly updatedAt: string;
  readonly sourceSha256: string;
  readonly material: ManufacturingGeometryProfile;
  readonly launcherFitOffsetMm: number;
  readonly launcherTemplateVersion: number;
  readonly launcherTemplateFingerprint: string;
  readonly launcherExteriorExpansion: LauncherExteriorExpansion;
  readonly canonicalSourceHash: string;
  readonly status: 'ready' | 'regeneration-required';
};

export type StoredOneClickProjectV3 = {
  readonly schemaVersion: 3;
  readonly id: 'one-click-current';
  readonly updatedAt: string;
  readonly sourceSha256: string;
  readonly material: ManufacturingGeometryProfile;
  readonly launcherFitOffsetMm: number;
  readonly launcherTemplateVersion: number;
  readonly launcherTemplateFingerprint: string;
  readonly launcherExteriorExpansion: LauncherExteriorExpansion;
  readonly decorationOmissions: readonly DecorationOmission[] | null;
  readonly canonicalSourceHash: string;
  readonly status: 'ready' | 'regeneration-required';
};

/** @deprecated Compatibility alias for consumers predating the v3 migration. */
export type StoredOneClickProjectV1 = StoredOneClickProjectV3;

const commonRecordShape = {
  id: z.literal('one-click-current'),
  updatedAt: z.string().datetime({ offset: true }),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  material: z.unknown(),
  launcherFitOffsetMm: z.number(),
  launcherTemplateVersion: z.number().int().positive(),
  launcherTemplateFingerprint: z.string().regex(/^[0-9a-f]{32}$/i),
  canonicalSourceHash: z.string().regex(/^[0-9a-f]{32}$/i),
  status: z.enum(['ready', 'regeneration-required']),
} as const;

const normalizedExpansionOffsetSchema = z.number().refine((value) => {
  try {
    return normalizeLauncherExteriorExpansionMm(value) === value;
  } catch {
    return false;
  }
}, {
  message: 'Launcher exterior expansion offset must be on the 0.01 mm grid from 0.00 mm to 6.00 mm',
}).transform((value) => normalizeLauncherExteriorExpansionMm(value));

const launcherExteriorExpansionSchema = z.object({
  mode: z.literal(LAUNCHER_EXTERIOR_EXPANSION_MODE),
  offsetMm: normalizedExpansionOffsetSchema,
  maxOffsetMm: z.literal(LAUNCHER_EXTERIOR_EXPANSION_MAX_MM),
  affectedLayerIds: z.tuple([
    z.string().trim().min(1),
    z.string().trim().min(1),
  ]).refine(([first, second]) => first !== second, {
    message: 'Launcher exterior expansion affected layer IDs must be distinct',
  }),
}).strict();

const previousRecordSchema = z.object({
  schemaVersion: z.literal(2),
  ...commonRecordShape,
  launcherExteriorExpansion: launcherExteriorExpansionSchema,
}).strict();

const canonicalLayerIdSchema = z.string()
  .regex(/^outline-layer-(?:0|[1-9]\d*)$/)
  .refine((layerId) => Number(layerId.slice('outline-layer-'.length)) < 24, {
    message: 'Decoration omission layer ID exceeds the canonical 24-layer bound',
  });
const decorationOmissionSchema = z.object({
  layerId: canonicalLayerIdSchema,
  reason: z.literal('protected-cut-work-budget'),
  roles: z.tuple([
    z.literal('DEEP_RED'),
    z.literal('LIGHT_BLUE'),
  ]),
}).strict();

function compareCanonicalLayerIds(left: string, right: string): number {
  return Number(left.slice('outline-layer-'.length))
    - Number(right.slice('outline-layer-'.length));
}

const decorationOmissionsSchema = z.array(decorationOmissionSchema)
  .max(24)
  .refine((omissions) => omissions.every((omission, index) => (
    index === 0
    || compareCanonicalLayerIds(omissions[index - 1].layerId, omission.layerId) < 0
  )), {
    message: 'Decoration omission layer IDs must be unique and ordered',
  });

const currentRecordSchema = z.object({
  schemaVersion: z.literal(3),
  ...commonRecordShape,
  launcherExteriorExpansion: launcherExteriorExpansionSchema,
  decorationOmissions: decorationOmissionsSchema.nullable(),
}).strict().refine((record) => (
  record.decorationOmissions !== null || record.status === 'regeneration-required'
), {
  message: 'Ready one-click projects require canonical decoration omission decisions',
  path: ['decorationOmissions'],
});

const storedRecordSchema = z.discriminatedUnion('schemaVersion', [
  previousRecordSchema,
  currentRecordSchema,
]);

function cloneLauncherExteriorExpansion(
  expansion: LauncherExteriorExpansion,
): LauncherExteriorExpansion {
  return {
    ...expansion,
    affectedLayerIds: [
      expansion.affectedLayerIds[0],
      expansion.affectedLayerIds[1],
    ],
  };
}

function parse(value: unknown): StoredOneClickProjectV3 {
  const record = storedRecordSchema.parse(value);
  const material = validateManufacturingGeometryProfile(record.material);
  const launcherFitOffsetMm = validateLauncherFitOffsetMm(record.launcherFitOffsetMm);
  if (record.schemaVersion === 2) {
    return {
      ...record,
      schemaVersion: 3,
      material,
      launcherFitOffsetMm,
      launcherExteriorExpansion: cloneLauncherExteriorExpansion(
        record.launcherExteriorExpansion,
      ),
      decorationOmissions: null,
      status: 'regeneration-required',
    };
  }
  const currentTemplate = record.launcherTemplateVersion === OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
    && record.launcherTemplateFingerprint === OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT;
  return {
    ...record,
    material,
    launcherFitOffsetMm,
    launcherExteriorExpansion: cloneLauncherExteriorExpansion(
      record.launcherExteriorExpansion,
    ),
    decorationOmissions: record.decorationOmissions === null
      ? null
      : record.decorationOmissions.map((omission) => ({
        layerId: omission.layerId,
        reason: omission.reason,
        roles: [omission.roles[0], omission.roles[1]],
      })),
    status: currentTemplate ? record.status : 'regeneration-required',
  };
}

export interface OneClickProjectRepositoryPort {
  load(): Promise<StoredOneClickProjectV3 | undefined>;
  save(value: StoredOneClickProjectV3): Promise<void>;
  delete(): Promise<void>;
}

export class OneClickProjectRepository implements OneClickProjectRepositoryPort {
  constructor(readonly database: MaterialDatabase = createMaterialDatabase()) {}
  async load(): Promise<StoredOneClickProjectV3 | undefined> {
    const value = await this.database.oneClickProjects.get('one-click-current');
    return value === undefined ? undefined : structuredClone(parse(value));
  }
  async save(value: StoredOneClickProjectV3): Promise<void> {
    await this.database.oneClickProjects.put(structuredClone(parse(value)));
  }
  async delete(): Promise<void> {
    await this.database.oneClickProjects.delete('one-click-current');
  }
}
