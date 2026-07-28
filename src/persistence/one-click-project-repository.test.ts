import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { GEOMETRY_ESTIMATE_MATERIALS } from '../domain/materials/geometry-estimates';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import { createMaterialDatabase } from './database';
import {
  OneClickProjectRepository,
  type StoredOneClickProjectV3,
  type StoredOneClickProjectV2,
} from './one-click-project-repository';

const names: string[] = [];
const openDatabases: ReturnType<typeof createMaterialDatabase>[] = [];
function trackedDatabase(name: string) {
  const database = createMaterialDatabase(name);
  openDatabases.push(database);
  return database;
}
afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function record(): StoredOneClickProjectV3 {
  return {
    schemaVersion: 3,
    id: 'one-click-current',
    updatedAt: '2026-07-28T00:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
    material: GEOMETRY_ESTIMATE_MATERIALS[0],
    launcherFitOffsetMm: 0.05,
    launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
    launcherExteriorExpansion: {
      mode: 'shared-uniform',
      offsetMm: 2.35,
      maxOffsetMm: 6,
      affectedLayerIds: ['layer-5', 'layer-6'],
    },
    decorationOmissions: [
      {
        layerId: 'outline-layer-1',
        reason: 'protected-cut-work-budget',
        roles: ['DEEP_RED', 'LIGHT_BLUE'],
      },
      {
        layerId: 'outline-layer-3',
        reason: 'protected-cut-work-budget',
        roles: ['DEEP_RED', 'LIGHT_BLUE'],
      },
    ],
    canonicalSourceHash: 'b'.repeat(32),
    status: 'ready',
  };
}

describe('one-click project persistence', () => {
  it('reopens sanitized decisions without retaining source bytes or a filename', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const first = trackedDatabase(name);
    await new OneClickProjectRepository(first).save(record());
    first.close();

    const reopened = await new OneClickProjectRepository(trackedDatabase(name)).load();

    expect(reopened).toEqual(record());
    expect(JSON.stringify(reopened)).not.toMatch(
      /bytes|fileName|preview|provisional|artifact|\.stl/i,
    );
  });

  it('accepts an empty non-null omission decision for a ready v3 record', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));
    const noOmissions = { ...record(), decorationOmissions: [] };

    await repository.save(noOmissions);

    await expect(repository.load()).resolves.toEqual(noOmissions);
  });

  it('migrates a strict v2 record to a regeneration-required v3 shell without inventing omission decisions', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const database = trackedDatabase(name);
    const { decorationOmissions: _omissions, ...current } = record();
    const legacy: StoredOneClickProjectV2 = {
      ...current,
      schemaVersion: 2,
      status: 'ready',
    };
    await database.oneClickProjects.put(legacy as never);

    await expect(new OneClickProjectRepository(database).load()).resolves.toEqual({
      ...current,
      schemaVersion: 3,
      decorationOmissions: null,
      status: 'regeneration-required',
    });
  });

  it.each([
    ['non-grid offset', { offsetMm: 2.351 }],
    ['over-limit offset', { offsetMm: 6.01 }],
    ['wrong mode', { mode: 'independent' }],
    ['wrong maximum', { maxOffsetMm: 7 }],
    ['duplicated layer IDs', { affectedLayerIds: ['layer-5', 'layer-5'] }],
  ])('rejects %s expansion evidence', async (_label, expansionMutation) => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));
    await expect(repository.save({
      ...record(),
      launcherExteriorExpansion: {
        ...record().launcherExteriorExpansion!,
        ...expansionMutation,
      },
    } as StoredOneClickProjectV3)).rejects.toThrow();
  });

  it('requires non-null launcher exterior expansion evidence for every v3 record', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));

    await expect(repository.save({
      ...record(),
      launcherExteriorExpansion: null,
    } as unknown as StoredOneClickProjectV3)).rejects.toThrow();

    await expect(repository.save({
      ...record(),
      launcherExteriorExpansion: null,
      status: 'regeneration-required' as const,
    } as unknown as StoredOneClickProjectV3)).rejects.toThrow();
  });

  it('allows null omission decisions only for regeneration-required v3 records', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));

    await expect(repository.save({
      ...record(),
      decorationOmissions: null,
    })).rejects.toThrow();

    const regeneration = {
      ...record(),
      decorationOmissions: null,
      status: 'regeneration-required' as const,
    };
    await repository.save(regeneration);
    await expect(repository.load()).resolves.toEqual(regeneration);
  });

  it.each([
    ['extra key', [{ ...record().decorationOmissions![0], privateDetail: true }]],
    ['duplicate layer', [
      record().decorationOmissions![0],
      record().decorationOmissions![0],
    ]],
    ['reversed order', [...record().decorationOmissions!].reverse()],
    ['unsafe layer ID', [{
      ...record().decorationOmissions![0],
      layerId: '../private',
    }]],
    ['noncanonical layer ID', [{
      ...record().decorationOmissions![0],
      layerId: 'missing',
    }]],
    ['wrong reason', [{
      ...record().decorationOmissions![0],
      reason: 'other',
    }]],
    ['missing role', [{
      ...record().decorationOmissions![0],
      roles: ['DEEP_RED'],
    }]],
    ['reversed roles', [{
      ...record().decorationOmissions![0],
      roles: ['LIGHT_BLUE', 'DEEP_RED'],
    }]],
  ])('rejects omission evidence with %s', async (_label, decorationOmissions) => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));

    await expect(repository.save({
      ...record(),
      decorationOmissions,
    } as StoredOneClickProjectV3)).rejects.toThrow();
  });

  it('marks an unavailable template fingerprint as regeneration-required on read', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const database = trackedDatabase(name);
    await database.oneClickProjects.put({
      ...record(),
      launcherTemplateFingerprint: 'f'.repeat(32),
    } as never);

    await expect(new OneClickProjectRepository(database).load()).resolves.toMatchObject({
      schemaVersion: 3,
      status: 'regeneration-required',
      launcherTemplateFingerprint: 'f'.repeat(32),
      launcherExteriorExpansion: record().launcherExteriorExpansion,
      decorationOmissions: record().decorationOmissions,
    });
  });

  it('reopens a regenerated v3 record with exact canonical expansion and ordered omissions', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));
    const regenerated = {
      ...record(),
      updatedAt: '2026-07-28T01:00:00.000Z',
      launcherExteriorExpansion: {
        ...record().launcherExteriorExpansion!,
        offsetMm: 0,
      },
      decorationOmissions: [
        record().decorationOmissions![1],
      ],
    };

    await repository.save(regenerated);

    await expect(repository.load()).resolves.toEqual(regenerated);
  });

  it('explicitly deletes the current saved job before a replacement model can start', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(trackedDatabase(name));
    await repository.save(record());

    await repository.delete();

    await expect(repository.load()).resolves.toBeUndefined();
  });
});
