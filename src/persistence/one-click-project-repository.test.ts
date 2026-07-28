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
  type StoredOneClickProjectV2,
} from './one-click-project-repository';

const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function record(): StoredOneClickProjectV2 {
  return {
    schemaVersion: 2,
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
    canonicalSourceHash: 'b'.repeat(32),
    status: 'ready',
  };
}

describe('one-click project persistence', () => {
  it('reopens sanitized decisions without retaining source bytes or a filename', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const first = createMaterialDatabase(name);
    await new OneClickProjectRepository(first).save(record());
    first.close();

    const reopened = await new OneClickProjectRepository(createMaterialDatabase(name)).load();

    expect(reopened).toEqual(record());
    expect(JSON.stringify(reopened)).not.toMatch(
      /bytes|fileName|preview|provisional|artifact|\.stl/i,
    );
  });

  it('migrates a strict v1 record to a regeneration-required v2 shell without invented expansion evidence', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const database = createMaterialDatabase(name);
    const { launcherExteriorExpansion: _expansion, ...current } = record();
    await database.oneClickProjects.put({
      ...current,
      schemaVersion: 1,
      status: 'ready',
    } as never);

    await expect(new OneClickProjectRepository(database).load()).resolves.toEqual({
      ...current,
      schemaVersion: 2,
      launcherExteriorExpansion: null,
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
    const repository = new OneClickProjectRepository(createMaterialDatabase(name));
    await expect(repository.save({
      ...record(),
      launcherExteriorExpansion: {
        ...record().launcherExteriorExpansion!,
        ...expansionMutation,
      },
    } as StoredOneClickProjectV2)).rejects.toThrow();
  });

  it('allows null expansion evidence only for regeneration-required records', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(createMaterialDatabase(name));

    await expect(repository.save({
      ...record(),
      launcherExteriorExpansion: null,
    })).rejects.toThrow();

    const regeneration = {
      ...record(),
      launcherExteriorExpansion: null,
      status: 'regeneration-required' as const,
    };
    await repository.save(regeneration);
    await expect(repository.load()).resolves.toEqual(regeneration);
  });

  it('marks an unavailable template fingerprint as regeneration-required on read', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const database = createMaterialDatabase(name);
    await database.oneClickProjects.put({
      ...record(),
      launcherTemplateFingerprint: 'f'.repeat(32),
    } as never);

    await expect(new OneClickProjectRepository(database).load()).resolves.toMatchObject({
      schemaVersion: 2,
      status: 'regeneration-required',
      launcherTemplateFingerprint: 'f'.repeat(32),
      launcherExteriorExpansion: record().launcherExteriorExpansion,
    });
  });

  it('reopens a regenerated v2 record with the exact stored canonical expansion', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(createMaterialDatabase(name));
    const regenerated = {
      ...record(),
      updatedAt: '2026-07-28T01:00:00.000Z',
      launcherExteriorExpansion: {
        ...record().launcherExteriorExpansion!,
        offsetMm: 0,
      },
    };

    await repository.save(regenerated);

    await expect(repository.load()).resolves.toEqual(regenerated);
  });

  it('explicitly deletes the current saved job before a replacement model can start', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const repository = new OneClickProjectRepository(createMaterialDatabase(name));
    await repository.save(record());

    await repository.delete();

    await expect(repository.load()).resolves.toBeUndefined();
  });
});
