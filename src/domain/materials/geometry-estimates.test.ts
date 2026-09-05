import { describe, expect, it } from 'vitest';
import { validateManufacturingGeometryProfile } from './manufacturing-profile';
import { GEOMETRY_ESTIMATE_MATERIALS } from './geometry-estimates';

describe('GEOMETRY_ESTIMATE_MATERIALS', () => {
  it('contains exactly the four geometry estimates in display order', () => {
    expect(GEOMETRY_ESTIMATE_MATERIALS.map(({ id, name, thicknessMm }) => ({
      id, name, thicknessMm,
    }))).toEqual([
      { id: 'acrylic-6', name: '壓克力（幾何估算）', thicknessMm: 6 },
      { id: 'acrylic-3', name: '壓克力（幾何估算）', thicknessMm: 3 },
      { id: 'plywood-6', name: '木（幾何估算）', thicknessMm: 6 },
      { id: 'plywood-3', name: '木（幾何估算）', thicknessMm: 3 },
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
      expect.objectContaining({ id: 'acrylic-6', thicknessMm: 6, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'acrylic-3', thicknessMm: 3, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'plywood-6', thicknessMm: 6, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'plywood-3', thicknessMm: 3, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
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
