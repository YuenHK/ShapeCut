import { describe, expect, it } from 'vitest';
import { runPreflight, type PreflightContext } from './run-preflight';

function context(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return {
    meshInspection: { triangleCount: 10, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, invertedVolume: false },
    axisConfirmed: true,
    balance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, angularMassError: 0, assumptions: [] },
    material: { safe: true, calibrated: true, minFeatureMm: 0.5, minWebMm: 1, minRemainingMm: 0.8 },
    measurements: { minimumFeatureMm: 1, minimumWebMm: 2, minimumRemainingMm: 1, minimumJointWebMm: 2 },
    layout: { outOfBoundsPartIds: [], overlapPairs: [], edgeClearanceMm: 5 },
    ...overrides,
  };
}

describe('runPreflight', () => {
  it('allows export only after blocking checks pass and confirmations are accepted', () => {
    const result = runPreflight(context());
    expect(result.issues).toEqual([]);
    expect(result.canExport).toBe(true);
  });

  it('covers mesh, axis, structure, engraving, layout, material, and balance failures', () => {
    const result = runPreflight(context({
      meshInspection: { triangleCount: 10, boundaryEdgeCount: 2, nonManifoldEdgeCount: 1, degenerateTriangleCount: 0, invertedVolume: false },
      axisConfirmed: false,
      balance: { kind: 'ideal-static-estimate', status: 'block', centroidOffsetMm: 4, angularMassError: 0.2, assumptions: [] },
      material: { safe: false, calibrated: false, minFeatureMm: 2, minWebMm: 3, minRemainingMm: 2 },
      measurements: { minimumFeatureMm: 1, minimumWebMm: 1, minimumRemainingMm: 1, minimumJointWebMm: 1 },
      layout: { outOfBoundsPartIds: ['rib-1'], overlapPairs: [['rib-1', 'hub-1']], edgeClearanceMm: 0.2 },
    }));
    expect(result.canExport).toBe(false);
    expect(new Set(result.issues.map(({ code }) => code))).toEqual(expect.objectContaining(new Set([
      'mesh-open', 'mesh-non-manifold', 'axis-unconfirmed', 'balance-block', 'forbidden-material', 'uncalibrated-material',
      'minimum-feature', 'minimum-web', 'engraving-remaining', 'joint-strength', 'layout-bounds', 'layout-overlap', 'layout-edge-clearance',
    ])));
    expect(result.issues.every(({ fixes }) => fixes.length > 0)).toBe(true);
  });

  it('requires explicit acceptance for confirm issues', () => {
    const pending = runPreflight(context({ material: { safe: true, calibrated: false, minFeatureMm: 0.5, minWebMm: 1, minRemainingMm: 0.8 } }));
    expect(pending.canExport).toBe(false);
    const accepted = runPreflight(context({ material: { safe: true, calibrated: false, minFeatureMm: 0.5, minWebMm: 1, minRemainingMm: 0.8 }, acceptedConfirmations: ['uncalibrated-material'] }));
    expect(accepted.canExport).toBe(true);
  });

  it('fails closed for non-finite manufacturing measurements', () => {
    const result = runPreflight(context({ measurements: { minimumFeatureMm: Number.NaN, minimumWebMm: 2, minimumRemainingMm: 1, minimumJointWebMm: 2 } }));
    expect(result.canExport).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid-measurements', severity: 'blocking' }));
  });
});
