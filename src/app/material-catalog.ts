import { DEFAULT_PENDING_MATERIAL_PROFILES, defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import {
  classifyMaterialReadiness,
  type MaterialProfileV1,
  type MaterialReadiness,
} from '../domain/materials/schema';
import type { MaterialRepository } from '../persistence/material-repository';

export type MaterialCatalogEntry = {
  readonly source: 'builtin' | 'stored';
  readonly profile: MaterialProfileV1;
  readonly readiness: MaterialReadiness;
};

export type MaterialRepositoryPort = Pick<MaterialRepository, 'get' | 'list' | 'importJson'>;

const BUILTIN_IDS = new Set(DEFAULT_PENDING_MATERIAL_PROFILES.map(({ id }) => id));

export async function listMaterialCatalog(repository?: MaterialRepositoryPort): Promise<readonly MaterialCatalogEntry[]> {
  const builtins = DEFAULT_PENDING_MATERIAL_PROFILES.map((profile): MaterialCatalogEntry => ({
    source: 'builtin',
    profile: structuredClone(profile),
    readiness: classifyMaterialReadiness(profile),
  }));
  const stored = repository ? await repository.list() : [];
  return [
    ...builtins,
    ...stored
      .filter(({ id }) => !BUILTIN_IDS.has(id))
      .map((profile): MaterialCatalogEntry => ({
        source: 'stored',
        profile: structuredClone(profile),
        readiness: classifyMaterialReadiness(profile),
      })),
  ];
}

export async function saveStoredMaterialJson(repository: MaterialRepositoryPort | undefined, source: string): Promise<MaterialCatalogEntry> {
  if (!repository) throw new Error('材料設定檔儲存空間不可用');
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    return repository.importJson(source).then(storedEntry);
  }
  if (isRecord(decoded) && typeof decoded.id === 'string' && BUILTIN_IDS.has(decoded.id.trim())) {
    throw new Error('Built-in material profile IDs are reserved and remain read-only');
  }
  return repository.importJson(source).then(storedEntry);
}

export async function resolveMaterialProfile(repository: MaterialRepositoryPort | undefined, id: string): Promise<MaterialProfileV1 | undefined> {
  const builtin = defaultPendingMaterialProfile(id);
  if (builtin) return builtin;
  return repository?.get(id);
}

function storedEntry(profile: MaterialProfileV1): MaterialCatalogEntry {
  return {
    source: 'stored',
    profile: structuredClone(profile),
    readiness: classifyMaterialReadiness(profile),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
