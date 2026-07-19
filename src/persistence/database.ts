import Dexie, { type Table } from 'dexie';

import type { MaterialProfileV1 } from '../domain/materials/schema';
import type { StoredProjectV1 } from './project-repository';

export type StoredMaterialProfile = MaterialProfileV1 & {
  calibrationStatus: 'ready' | 'confirm' | 'block';
};

export class MaterialDatabase extends Dexie {
  materials!: Table<StoredMaterialProfile, string>;
  projects!: Table<StoredProjectV1, string>;

  constructor(name = 'spinner-laser-kit') {
    super(name);
    this.version(1).stores({
      materials: '&id,machine,materialCode,calibratedAt,calibrationStatus,physicalCouponVerified,[machine+materialCode]',
    });
    this.version(2).stores({
      materials: '&id,machine,materialCode,calibratedAt,calibrationStatus,physicalCouponVerified,[machine+materialCode]',
      projects: '&id,name,updatedAt,sourceSha256,step',
    });
  }
}

export function createMaterialDatabase(name?: string): MaterialDatabase {
  return new MaterialDatabase(name);
}
