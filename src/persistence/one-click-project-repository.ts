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
import { createMaterialDatabase, type MaterialDatabase } from './database';

export type StoredOneClickProjectV1 = {
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

function parse(value: unknown): StoredOneClickProjectV1 {
  const record = z.object({
    schemaVersion: z.literal(1),
    id: z.literal('one-click-current'),
    updatedAt: z.string().datetime({ offset: true }),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    material: z.unknown(),
    launcherFitOffsetMm: z.number(),
    launcherTemplateVersion: z.number().int().positive(),
    launcherTemplateFingerprint: z.string().regex(/^[0-9a-f]{32}$/i),
    canonicalSourceHash: z.string().regex(/^[0-9a-f]{32}$/i),
    status: z.enum(['ready', 'regeneration-required']),
  }).strict().parse(value);
  const current = record.launcherTemplateVersion === OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
    && record.launcherTemplateFingerprint === OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT;
  return {
    ...record,
    material: validateManufacturingGeometryProfile(record.material),
    launcherFitOffsetMm: validateLauncherFitOffsetMm(record.launcherFitOffsetMm),
    status: current ? record.status : 'regeneration-required',
  };
}

export interface OneClickProjectRepositoryPort {
  load(): Promise<StoredOneClickProjectV1 | undefined>;
  save(value: StoredOneClickProjectV1): Promise<void>;
  delete(): Promise<void>;
}

export class OneClickProjectRepository implements OneClickProjectRepositoryPort {
  constructor(readonly database: MaterialDatabase = createMaterialDatabase()) {}
  async load(): Promise<StoredOneClickProjectV1 | undefined> {
    const value = await this.database.oneClickProjects.get('one-click-current');
    return value === undefined ? undefined : structuredClone(parse(value));
  }
  async save(value: StoredOneClickProjectV1): Promise<void> {
    await this.database.oneClickProjects.put(structuredClone(parse(value)));
  }
  async delete(): Promise<void> {
    await this.database.oneClickProjects.delete('one-click-current');
  }
}
