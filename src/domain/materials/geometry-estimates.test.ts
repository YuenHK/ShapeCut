import { describe, expect, it } from 'vitest';
import { validateManufacturingGeometryProfile } from './manufacturing-profile';
import { GEOMETRY_ESTIMATE_MATERIALS } from './geometry-estimates';

describe('GEOMETRY_ESTIMATE_MATERIALS', () => {
  it('contains exactly the five approved geometry estimates in display order', () => {
    expect(GEOMETRY_ESTIMATE_MATERIALS.map(({ id, name, thicknessMm }) => ({
      id, name, thicknessMm,
    }))).toEqual([
      { id: 'plywood-3', name: '木夾板（幾何估算）', thicknessMm: 3 },
      { id: 'plywood-5', name: '木夾板（幾何估算）', thicknessMm: 5 },
      { id: 'acrylic-3', name: '鑄造壓克力（幾何估算）', thicknessMm: 3 },
      { id: 'acrylic-5', name: '鑄造壓克力（幾何估算）', thicknessMm: 5 },
      { id: 'cardboard-2', name: '紙板（幾何估算）', thicknessMm: 2 },
    ]);
  });

  it('contains only valid geometry fields and no process or approval evidence', () => {
    for (const profile of GEOMETRY_ESTIMATE_MATERIALS) {
      expect(validateManufacturingGeometryProfile(profile)).toEqual(profile);
      expect(Object.keys(profile).sort()).toEqual([
        'fitAllowanceMm', 'id', 'kerfMm', 'minFeatureMm',
        'minWebMm', 'name', 'thicknessMm',
      ]);
      expect(JSON.stringify(profile)).not.toMatch(
        /power|speed|passes|recipe|calibrat|operator|approv|verified/i,
      );
    }
  });

  it('uses the approved conservative geometry values', () => {
    expect(GEOMETRY_ESTIMATE_MATERIALS).toEqual([
      expect.objectContaining({ id: 'plywood-3', thicknessMm: 3, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'plywood-5', thicknessMm: 5, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'acrylic-3', thicknessMm: 3, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'acrylic-5', thicknessMm: 5, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'cardboard-2', thicknessMm: 2, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
    ]);
  });

  it('deeply freezes the catalogue, every profile, and every fit allowance map', () => {
    expect(Object.isFrozen(GEOMETRY_ESTIMATE_MATERIALS)).toBe(true);
    for (const profile of GEOMETRY_ESTIMATE_MATERIALS) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.fitAllowanceMm)).toBe(true);
    }
  });
});
