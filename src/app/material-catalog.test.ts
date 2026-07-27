import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import { classifyMaterialReadiness } from '../domain/materials/schema';
import { createMaterialDatabase, type MaterialDatabase } from '../persistence/database';
import { MaterialRepository } from '../persistence/material-repository';
import { BLOCKED_TEST_MATERIAL, READY_TEST_MATERIAL } from '../test/ready-material';
import {
  listMaterialCatalog,
  resolveMaterialProfile,
  saveStoredMaterialJson,
} from './material-catalog';

describe('material catalog stored estimate replacements', () => {
  let databaseName: string;
  let database: MaterialDatabase;
  let repository: MaterialRepository;

  beforeEach(() => {
    databaseName = `spinner-material-catalog-test-${crypto.randomUUID()}`;
    database = createMaterialDatabase(databaseName);
    repository = new MaterialRepository(database);
  });

  afterEach(async () => {
    database.close();
    await Dexie.delete(databaseName);
  });

  it('saves and surfaces a ready same-ID replacement through the real repository path', async () => {
    const replacement = {
      ...READY_TEST_MATERIAL,
      id: 'plywood-3',
      materialName: 'TEST ONLY production-path calibrated plywood',
    };

    await expect(saveStoredMaterialJson(repository, JSON.stringify(replacement))).resolves.toMatchObject({
      source: 'stored',
      profile: replacement,
      readiness: { status: 'ready', reasons: [] },
    });

    const catalog = await listMaterialCatalog(repository);
    expect(catalog.filter(({ profile }) => profile.id === replacement.id)).toEqual([
      expect.objectContaining({
        source: 'stored',
        profile: replacement,
        readiness: { status: 'ready', reasons: [] },
      }),
    ]);
    await expect(resolveMaterialProfile(repository, replacement.id)).resolves.toEqual(replacement);
  });

  it('rejects non-ready or non-estimate collisions before they can be persisted', async () => {
    const pending = defaultPendingMaterialProfile('plywood-3')!;
    const blocked = { ...BLOCKED_TEST_MATERIAL, id: 'acrylic-3' };
    const forbidden = { ...READY_TEST_MATERIAL, id: 'cork-3' };

    expect(classifyMaterialReadiness(pending).status).toBe('confirm');
    expect(classifyMaterialReadiness(blocked).status).toBe('block');
    expect(classifyMaterialReadiness(forbidden).status).toBe('ready');

    await expect(saveStoredMaterialJson(repository, JSON.stringify(pending))).rejects.toThrow(/ready|approved/i);
    await expect(saveStoredMaterialJson(repository, JSON.stringify(blocked))).rejects.toThrow(/ready|approved/i);
    await expect(saveStoredMaterialJson(repository, JSON.stringify(forbidden))).rejects.toThrow(/reserved|read-only/i);
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('classifies an unsafe legacy stored ID as blocked without throwing during catalog rendering', async () => {
    const unsafe = { ...READY_TEST_MATERIAL, id: 'legacy material id' };
    const catalog = await listMaterialCatalog({
      list: async () => [unsafe],
      get: async () => unsafe,
      importJson: async () => unsafe,
    });
    const entry = catalog.find(({ source }) => source === 'stored');

    expect(entry?.readiness).toEqual({
      status: 'block',
      reasons: [expect.objectContaining({
        code: 'invalid-profile',
        message: expect.stringMatching(/material id.*1-80.*ASCII/i),
      })],
    });
  });
});
