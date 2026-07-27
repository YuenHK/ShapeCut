import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { GEOMETRY_ESTIMATE_MATERIALS } from '../domain/materials/geometry-estimates';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import { createMaterialDatabase } from './database';
import { OneClickProjectRepository, type StoredOneClickProjectV1 } from './one-click-project-repository';

const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function record(): StoredOneClickProjectV1 {
  return {
    schemaVersion: 1,
    id: 'one-click-current',
    updatedAt: '2026-07-28T00:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
    material: GEOMETRY_ESTIMATE_MATERIALS[0],
    launcherFitOffsetMm: 0.05,
    launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
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
    expect(JSON.stringify(reopened)).not.toMatch(/bytes|fileName|\.stl/i);
  });

  it('marks an unavailable template fingerprint as regeneration-required on read', async () => {
    const name = `one-click-${crypto.randomUUID()}`;
    names.push(name);
    const database = createMaterialDatabase(name);
    await database.oneClickProjects.put({
      ...record(),
      launcherTemplateFingerprint: 'f'.repeat(32),
    });

    await expect(new OneClickProjectRepository(database).load()).resolves.toMatchObject({
      status: 'regeneration-required',
      launcherTemplateFingerprint: 'f'.repeat(32),
    });
  });
});
