import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type { MaterialProfileV1 } from '../domain/materials/schema';
import { createMaterialDatabase, type MaterialDatabase } from './database';
import { MaterialRepository } from './material-repository';

const completeProfile: MaterialProfileV1 = {
  schemaVersion: 1,
  id: 'repo-q400-cast-acrylic-2.91',
  machine: 'Trotec Q400 #1',
  materialCode: 'CAST-ACRYLIC-LASER-RATED-B42',
  materialName: 'Laser-rated cast acrylic',
  batchNotes: 'Batch B42, protective film removed before testing',
  thicknessMm: 2.91,
  sheetWidthMm: 610,
  sheetHeightMm: 305,
  kerfMm: 0.17,
  fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.05, press: -0.03 },
  minFeatureMm: 0.9,
  minWebMm: 1.8,
  minRemainingMm: 1.3,
  recipes: {
    cut: { powerPercent: 90, speedMmPerSecond: 9, passes: 1, notes: 'Starting point only' },
    score: null,
    engrave1: { powerPercent: 12, speedMmPerSecond: 180, passes: 1, notes: 'Level 1' },
    engrave2: null,
    engrave3: { powerPercent: 22, speedMmPerSecond: 150, passes: 1, notes: 'Level 3' },
    engrave4: null,
    engrave5: { powerPercent: 35, speedMmPerSecond: 120, passes: 2, notes: 'Level 5' },
  },
  calibratedAt: '2026-07-19T01:02:03.000Z',
  physicalCouponVerified: true,
  operatorApproval: {
    operatorName: 'Alex Chan',
    qualification: 'Qualified laser cutter operator',
    signedAt: '2026-07-19T01:02:03.000Z',
    signature: 'A-CHAN-Q400-B42',
    couponId: 'Q400-CAST-B42-20260719',
  },
  safetyEvidence: {
    kind: 'allowlisted',
    category: 'laser-rated-cast-acrylic',
    compositionKnown: true,
    manufacturer: 'Example Acrylic Co.',
    productId: 'Cast B42 Laser Rated',
    laserSafetyReference: 'https://example.com/materials/cast-b42-laser-safety',
  },
};

describe('MaterialRepository', () => {
  let databaseName: string;
  let database: MaterialDatabase;
  let repository: MaterialRepository;

  beforeEach(() => {
    databaseName = `spinner-material-test-${crypto.randomUUID()}`;
    database = createMaterialDatabase(databaseName);
    repository = new MaterialRepository(database);
  });

  afterEach(async () => {
    database.close();
    await Dexie.delete(databaseName);
  });

  it('migrates the database to V2 while retaining the required material indexes', () => {
    expect(database.verno).toBe(2);
    const indexes = database.materials.schema.indexes.map(({ name }) => name);
    expect(indexes).toEqual(expect.arrayContaining([
      'machine',
      'materialCode',
      'calibratedAt',
      'physicalCouponVerified',
    ]));
    expect(database.projects.schema.indexes.map(({ name }) => name)).toEqual(expect.arrayContaining(['name', 'updatedAt', 'sourceSha256', 'step']));
  });

  it('round-trips the complete V1 record through genuine IndexedDB and does not leak mutable references', async () => {
    const input = structuredClone(completeProfile);
    await repository.put(input);
    input.batchNotes = 'mutated after put';
    input.fitAllowanceMm.loose = 999;

    const first = await repository.get(completeProfile.id);
    expect(first).toEqual(completeProfile);
    expect(first?.schemaVersion).toBe(1);
    expect(first?.fitAllowanceMm).toEqual(completeProfile.fitAllowanceMm);
    expect(first?.recipes.score).toBeNull();
    expect(first?.safetyEvidence).toEqual(completeProfile.safetyEvidence);
    expect(first?.calibratedAt).toBe('2026-07-19T01:02:03.000Z');

    if (first) {
      first.recipes.engrave2 = { powerPercent: 1, speedMmPerSecond: 1, passes: 1, notes: 'mutated' };
      first.fitAllowanceMm.press = 999;
    }
    expect(await repository.get(completeProfile.id)).toEqual(completeProfile);
    expect(await repository.list()).toEqual([completeProfile]);

    await repository.delete(completeProfile.id);
    expect(await repository.get(completeProfile.id)).toBeUndefined();
    expect(await repository.list()).toEqual([]);
  });

  it('supports clear lifecycle operations', async () => {
    await repository.put(completeProfile);
    await repository.put({ ...completeProfile, id: 'second-profile', materialCode: 'SECOND-SHEET' });

    await repository.clear();

    expect(await repository.list()).toEqual([]);
  });

  it('validates writes and rejects malformed persisted records on reads', async () => {
    await expect(repository.put({ ...completeProfile, schemaVersion: 2 })).rejects.toBeInstanceOf(ZodError);

    await database.materials.put({ id: 'malformed', schemaVersion: 2 } as never);

    await expect(repository.get('malformed')).rejects.toBeInstanceOf(ZodError);
    await expect(repository.list()).rejects.toBeInstanceOf(ZodError);
  });

  it('rejects a persisted calibration status that contradicts the validated profile', async () => {
    await database.materials.put({
      ...structuredClone(completeProfile),
      calibrationStatus: 'confirm',
    });

    await expect(repository.get(completeProfile.id)).rejects.toBeInstanceOf(ZodError);
  });
});
