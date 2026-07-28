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
import { createMaterialDatabase, type MaterialDatabase } from './database';

type StoredOneClickProjectLegacyV1 = {
  readonly schemaVersion: 1;
  readonly id: 'one-click-current';
  readonly updatedAt: string;
  readonly sourceSha256: string;
  readonly material: ManufacturingGeometryProfile;
  readonly launcherFitOffsetMm: number;
  readonly launcherTemplateVersion: number;
  readonly launcherTemplateFingerprint: string;
  readonly canonicalSourceHash: string;
  readonly status: 'ready' | 'regeneration-required';
};

export type StoredOneClickProjectV2 = {
  readonly schemaVersion: 2;
  readonly id: 'one-click-current';
  readonly updatedAt: string;
  readonly sourceSha256: string;
  readonly material: ManufacturingGeometryProfile;
  readonly launcherFitOffsetMm: number;
  readonly launcherTemplateVersion: number;
  readonly launcherTemplateFingerprint: string;
  readonly launcherExteriorExpansion: LauncherExteriorExpansion | null;
  readonly canonicalSourceHash: string;
  readonly status: 'ready' | 'regeneration-required';
};

/** @deprecated Compatibility alias for consumers predating the v2 migration. */
export type StoredOneClickProjectV1 = StoredOneClickProjectV2;

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

const legacyRecordSchema = z.object({
  schemaVersion: z.literal(1),
  ...commonRecordShape,
}).strict();

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

const currentRecordSchema = z.object({
  schemaVersion: z.literal(2),
  ...commonRecordShape,
  launcherExteriorExpansion: launcherExteriorExpansionSchema.nullable(),
}).strict().refine((record) => (
  record.launcherExteriorExpansion !== null || record.status === 'regeneration-required'
), {
  message: 'Ready one-click projects require canonical launcher exterior expansion evidence',
  path: ['launcherExteriorExpansion'],
});

const storedRecordSchema = z.discriminatedUnion('schemaVersion', [
  legacyRecordSchema,
  currentRecordSchema,
]);

function parse(value: unknown): StoredOneClickProjectV2 {
  const record = storedRecordSchema.parse(value);
  const material = validateManufacturingGeometryProfile(record.material);
  const launcherFitOffsetMm = validateLauncherFitOffsetMm(record.launcherFitOffsetMm);
  if (record.schemaVersion === 1) {
    const legacy: StoredOneClickProjectLegacyV1 = {
      ...record,
      material,
      launcherFitOffsetMm,
    };
    return {
      ...legacy,
      schemaVersion: 2,
      launcherExteriorExpansion: null,
      status: 'regeneration-required',
    };
  }
  const currentTemplate = record.launcherTemplateVersion === OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
    && record.launcherTemplateFingerprint === OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT;
  return {
    ...record,
    material,
    launcherFitOffsetMm,
    launcherExteriorExpansion: record.launcherExteriorExpansion === null
      ? null
      : {
        ...record.launcherExteriorExpansion,
        affectedLayerIds: [
          record.launcherExteriorExpansion.affectedLayerIds[0],
          record.launcherExteriorExpansion.affectedLayerIds[1],
        ],
      },
    status: currentTemplate ? record.status : 'regeneration-required',
  };
}

export interface OneClickProjectRepositoryPort {
  load(): Promise<StoredOneClickProjectV2 | undefined>;
  save(value: StoredOneClickProjectV2): Promise<void>;
  delete(): Promise<void>;
}

export class OneClickProjectRepository implements OneClickProjectRepositoryPort {
  constructor(readonly database: MaterialDatabase = createMaterialDatabase()) {}
  async load(): Promise<StoredOneClickProjectV2 | undefined> {
    const value = await this.database.oneClickProjects.get('one-click-current');
    return value === undefined ? undefined : structuredClone(parse(value));
  }
  async save(value: StoredOneClickProjectV2): Promise<void> {
    await this.database.oneClickProjects.put(structuredClone(parse(value)));
  }
  async delete(): Promise<void> {
    await this.database.oneClickProjects.delete('one-click-current');
  }
}
