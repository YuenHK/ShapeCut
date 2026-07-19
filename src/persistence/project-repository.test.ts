import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMaterialDatabase, type MaterialDatabase } from './database';
import { createProjectAutosave, ProjectRepository, sha256Hex, type StoredProjectV1 } from './project-repository';

const source = new TextEncoder().encode('solid spinner');

async function project(overrides: Partial<StoredProjectV1> = {}): Promise<StoredProjectV1> {
  return {
    schemaVersion: 1,
    id: 'spinner-project',
    name: 'Spinner project',
    step: 'decomposition',
    axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.95, confirmed: true },
    settings: {
      splitPositionPercent: 50, ribCount: 6, ringLayers: 2, shaftMm: 3, fit: 'snug', materialId: 'plywood-3',
      engravingLevels: 4, textureStrength: 0.6, sheetWidthMm: 300, sheetHeightMm: 200,
    },
    sourceSha256: await sha256Hex(source),
    repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1', meshSha256: 'b'.repeat(64) },
    updatedAt: '2026-07-19T08:00:00.000Z',
    ...overrides,
  };
}

describe('ProjectRepository', () => {
  let databaseName: string;
  let database: MaterialDatabase;
  let repository: ProjectRepository;

  beforeEach(() => {
    databaseName = `spinner-project-test-${crypto.randomUUID()}`;
    database = createMaterialDatabase(databaseName);
    repository = new ProjectRepository(database);
  });

  afterEach(async () => {
    vi.useRealTimers();
    database.close();
    await Dexie.delete(databaseName);
  });

  it('round-trips immutable V1 project data', async () => {
    const expected = await project();
    await repository.save(expected);
    const loaded = await repository.get(expected.id);
    expect(loaded).toEqual(expected);
    (loaded!.settings as { ribCount: number }).ribCount = 12;
    expect((await repository.get(expected.id))?.settings.ribCount).toBe(6);
  });

  it.each([9, 91])('rejects persisted split positions outside the 10-90 radial boundary: %s', async (splitPositionPercent) => {
    const value = await project();
    await expect(repository.save({
      ...value,
      settings: { ...value.settings, splitPositionPercent },
    })).rejects.toThrow(/splitPositionPercent/);
  });

  it('rejects downstream project state without repair provenance and repaired mesh fingerprint', async () => {
    await expect(repository.save(await project({ repair: undefined }))).rejects.toThrow(/repair provenance/i);
  });

  it('lists saved projects newest first for the startup chooser', async () => {
    const older = await project({ id: 'older', updatedAt: '2026-07-19T08:00:00.000Z' });
    const newer = await project({ id: 'newer', updatedAt: '2026-07-19T09:00:00.000Z' });
    await database.projects.bulkPut([older, newer]);

    const list = await (repository as ProjectRepository & { list(): Promise<readonly StoredProjectV1[]> }).list();

    expect(list.map(({ id }) => id)).toEqual(['newer', 'older']);
  });

  it('migrates legacy downstream records without repair provenance to a locked import checkpoint', async () => {
    const legacy = await project({ repair: undefined, step: 'export' });
    await database.projects.put(legacy);

    await expect(repository.get(legacy.id)).resolves.toMatchObject({
      id: legacy.id,
      step: 'import',
      axis: undefined,
      repair: undefined,
    });
  });

  it('requires the original STL fingerprint on reopen', async () => {
    const saved = await project();
    await repository.save(saved);
    await expect(repository.attachSource(saved.id, new TextEncoder().encode('other STL'))).rejects.toThrow('STL fingerprint mismatch');
    await expect(repository.attachSource(saved.id, source)).resolves.toEqual(saved);
  });

  it('normalizes a valid uppercase SHA-256 fingerprint before comparing source data', async () => {
    const saved = await project({ sourceSha256: (await sha256Hex(source)).toUpperCase() });
    const normalized = await repository.save(saved);
    expect(normalized.sourceSha256).toBe(saved.sourceSha256.toLowerCase());
    await expect(repository.attachSource(saved.id, source)).resolves.toMatchObject({ id: saved.id });
  });

  it('debounces autosave for 500 ms and reports persistent failures', async () => {
    vi.useFakeTimers();
    const save = vi.spyOn(repository, 'save');
    const onError = vi.fn();
    const autosave = createProjectAutosave(repository, onError);
    autosave.schedule(await project({ name: 'first' }));
    autosave.schedule(await project({ name: 'latest' }));
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'latest' }));

    save.mockRejectedValueOnce(new Error('disk unavailable'));
    autosave.schedule(await project({ name: 'failure' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith('disk unavailable');
    autosave.dispose();
  });

  it('rejects malformed persisted schema instead of silently opening it', async () => {
    await database.projects.put({ schemaVersion: 99, id: 'future' } as never);
    await expect(repository.get('future')).rejects.toThrow(/schema/i);
    await expect(repository.save(await project({ step: 'export', axis: undefined }))).rejects.toThrow(/confirmed axis/i);
  });
});
