import { z } from 'zod';

import { MaterialProfileSchema, classifyMaterialReadiness, type MaterialProfileV1 } from '../domain/materials/schema';
import { createMaterialDatabase, type MaterialDatabase, type StoredMaterialProfile } from './database';

const MaterialIdSchema = z.string().trim().min(1).max(500);
const CalibrationStatusSchema = z.enum(['ready', 'confirm', 'block']);

function decodeStoredProfile(value: unknown): MaterialProfileV1 {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const clone = structuredClone(value) as Record<string, unknown>;
    const storedStatus = CalibrationStatusSchema.parse(clone.calibrationStatus);
    delete clone.calibrationStatus;
    const profile = MaterialProfileSchema.parse(clone);
    z.literal(classifyMaterialReadiness(profile).status).parse(storedStatus);
    return profile;
  }
  return MaterialProfileSchema.parse(value);
}

function encodeStoredProfile(profile: MaterialProfileV1): StoredMaterialProfile {
  const clone = structuredClone(profile);
  return {
    ...clone,
    calibrationStatus: classifyMaterialReadiness(clone).status,
  };
}

export class MaterialRepository {
  readonly database: MaterialDatabase;

  constructor(database: MaterialDatabase = createMaterialDatabase()) {
    this.database = database;
  }

  async put(value: unknown): Promise<MaterialProfileV1> {
    const profile = MaterialProfileSchema.parse(value);
    await this.database.materials.put(encodeStoredProfile(profile));
    return structuredClone(profile);
  }

  async get(id: string): Promise<MaterialProfileV1 | undefined> {
    const value = await this.database.materials.get(MaterialIdSchema.parse(id));
    return value === undefined ? undefined : decodeStoredProfile(value);
  }

  async list(): Promise<MaterialProfileV1[]> {
    const values = await this.database.materials.toArray();
    return values.map(decodeStoredProfile);
  }

  async delete(id: string): Promise<void> {
    await this.database.materials.delete(MaterialIdSchema.parse(id));
  }

  async clear(): Promise<void> {
    await this.database.materials.clear();
  }

  close(): void {
    this.database.close();
  }
}
