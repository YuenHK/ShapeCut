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
    estimate('plywood-3', '木夾板（幾何估算）', 3),
    estimate('plywood-5', '木夾板（幾何估算）', 5),
    estimate('acrylic-3', '鑄造壓克力（幾何估算）', 3),
    estimate('acrylic-5', '鑄造壓克力（幾何估算）', 5),
    estimate('cardboard-2', '紙板（幾何估算）', 2),
  ]);
