import Dexie, { type Table } from 'dexie';

import type { MaterialProfileV1 } from '../domain/materials/schema';

export type StoredMaterialProfile = MaterialProfileV1 & {
  calibrationStatus: 'ready' | 'confirm' | 'block';
};

export class MaterialDatabase extends Dexie {
  materials!: Table<StoredMaterialProfile, string>;

  constructor(name = 'spinner-laser-kit') {
    super(name);
    this.version(1).stores({
      materials: '&id,machine,materialCode,calibratedAt,calibrationStatus,physicalCouponVerified,[machine+materialCode]',
    });
  }
}

export function createMaterialDatabase(name?: string): MaterialDatabase {
  return new MaterialDatabase(name);
}
