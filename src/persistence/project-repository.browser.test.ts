import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT, OFFICIAL_THREE_PRONG_TEMPLATE_VERSION } from '../domain/outline-assembly/launcher-template';
import { createMaterialDatabase } from './database';
import { ProjectRepository, sha256Hex, type StoredProjectV1 } from './project-repository';

const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe('project browser persistence', () => {
  it('reopens from IndexedDB and verifies the reattached STL fingerprint', async () => {
    const name = `project-browser-${crypto.randomUUID()}`;
    names.push(name);
    const source = new TextEncoder().encode('solid browser spinner');
    const stored: StoredProjectV1 = {
      schemaVersion: 1, id: 'browser-project', name: 'Browser project', step: 'axis',
      axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: true },
      settings: { splitPositionPercent: 50, ribCount: 6, ringLayers: 2, shaftMm: 3, fit: 'snug', materialId: 'plywood-3', engravingLevels: 3, textureStrength: 0.6, sheetWidthMm: 300, sheetHeightMm: 200, launcherFitOffsetMm: 0, launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION, launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT },
      repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1', meshSha256: 'c'.repeat(64) },
      sourceSha256: await sha256Hex(source), updatedAt: new Date().toISOString(),
    };
    const firstDatabase = createMaterialDatabase(name);
    await new ProjectRepository(firstDatabase).save(stored);
    firstDatabase.close();

    const reopenedDatabase = createMaterialDatabase(name);
    const reopened = new ProjectRepository(reopenedDatabase);
    await expect(reopened.attachSource(stored.id, source)).resolves.toEqual(stored);
    await expect(reopened.attachSource(stored.id, new TextEncoder().encode('wrong'))).rejects.toThrow('STL fingerprint mismatch');
    reopenedDatabase.close();
  });
});
