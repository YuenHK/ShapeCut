import { DEFAULT_PENDING_MATERIAL_PROFILES, defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import {
  classifyMaterialReadiness,
  type MaterialProfileV1,
  type MaterialReadiness,
} from '../domain/materials/schema';
import { GEOMETRY_ESTIMATE_MATERIALS } from '../domain/materials/geometry-estimates';
import type { MaterialRepository } from '../persistence/material-repository';

export type MaterialCatalogEntry = {
  readonly source: 'builtin' | 'stored';
  readonly profile: MaterialProfileV1;
  readonly readiness: MaterialReadiness;
};

export type MaterialRepositoryPort = Pick<MaterialRepository, 'get' | 'list' | 'importJson'>;

const BUILTIN_IDS = new Set(DEFAULT_PENDING_MATERIAL_PROFILES.map(({ id }) => id));
const GEOMETRY_ESTIMATE_IDS = new Set(GEOMETRY_ESTIMATE_MATERIALS.map(({ id }) => id));

export async function listMaterialCatalog(repository?: MaterialRepositoryPort): Promise<readonly MaterialCatalogEntry[]> {
  const builtins = DEFAULT_PENDING_MATERIAL_PROFILES.map((profile): MaterialCatalogEntry => ({
    source: 'builtin',
    profile: structuredClone(profile),
    readiness: classifyMaterialReadiness(profile),
  }));
  const stored = repository ? await repository.list() : [];
  const storedEntries = stored.map(storedEntry);
  const approvedReplacements = new Map(
    storedEntries
      .filter(({ profile, readiness }) => (
        BUILTIN_IDS.has(profile.id)
        && GEOMETRY_ESTIMATE_IDS.has(profile.id)
        && readiness.status === 'ready'
      ))
      .map((entry) => [entry.profile.id, entry]),
  );
  return [
    ...builtins.map((entry) => approvedReplacements.get(entry.profile.id) ?? entry),
    ...storedEntries.filter(({ profile }) => !BUILTIN_IDS.has(profile.id)),
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
    if (!GEOMETRY_ESTIMATE_IDS.has(decoded.id.trim())) {
      throw new Error('Built-in material profile IDs are reserved and remain read-only');
    }
    if (classifyMaterialReadiness(decoded).status !== 'ready') {
      throw new Error('A same-ID geometry estimate replacement must be readiness-approved');
    }
  }
  return repository.importJson(source).then(storedEntry);
}

export async function resolveMaterialProfile(repository: MaterialRepositoryPort | undefined, id: string): Promise<MaterialProfileV1 | undefined> {
  const stored = await repository?.get(id);
  if (stored && (
    !BUILTIN_IDS.has(id)
    || (GEOMETRY_ESTIMATE_IDS.has(id) && classifyMaterialReadiness(stored).status === 'ready')
  )) return stored;
  const builtin = defaultPendingMaterialProfile(id);
  if (builtin) return builtin;
  return stored;
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
