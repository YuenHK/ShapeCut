import {
  validateManufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from './manufacturing-profile';

const FIT_ALLOWANCE_MM = Object.freeze({
  loose: 0.2,
  slip: 0.12,
  snug: 0.06,
  press: 0,
});

function estimate(
  id: string,
  name: string,
  thicknessMm: number,
): ManufacturingGeometryProfile {
  const profile = validateManufacturingGeometryProfile({
    id,
    name,
    thicknessMm,
    kerfMm: 0.15,
    minFeatureMm: 0.8,
    minWebMm: 0.4,
    fitAllowanceMm: FIT_ALLOWANCE_MM,
  });
  Object.freeze(profile.fitAllowanceMm);
  return Object.freeze(profile);
}

export const GEOMETRY_ESTIMATE_MATERIALS: readonly ManufacturingGeometryProfile[] =
  Object.freeze([
    estimate('acrylic-6', '壓克力（幾何估算）', 6),
    estimate('acrylic-3', '壓克力（幾何估算）', 3),
    estimate('plywood-6', '木（幾何估算）', 6),
    estimate('plywood-3', '木（幾何估算）', 3),
  ]);
