import type { BalanceResult } from '../decomposition/types';
import type { MeshInspection } from '../mesh/types';
import { issue, type PreflightIssue } from './rules';

export type PreflightContext = {
  readonly meshInspection: MeshInspection;
  readonly axisConfirmed: boolean;
  readonly balance: BalanceResult;
  readonly material: { readonly safe: boolean; readonly calibrated: boolean; readonly minFeatureMm: number; readonly minWebMm: number; readonly minRemainingMm: number };
  readonly measurements: { readonly minimumFeatureMm: number; readonly minimumWebMm: number; readonly minimumRemainingMm: number; readonly minimumJointWebMm: number };
  readonly layout: { readonly outOfBoundsPartIds: readonly string[]; readonly overlapPairs: readonly (readonly [string, string])[]; readonly edgeClearanceMm: number };
  readonly acceptedConfirmations?: readonly string[];
};

export function runPreflight(context: PreflightContext): { readonly issues: readonly PreflightIssue[]; readonly canExport: boolean } {
  const issues: PreflightIssue[] = [];
  const add = (condition: boolean, value: PreflightIssue): void => { if (condition) issues.push(value); };
  const manufacturingValues = [...Object.values(context.measurements), ...Object.values(context.material).filter((value): value is number => typeof value === 'number'), context.layout.edgeClearanceMm];
  add(manufacturingValues.some((value) => !Number.isFinite(value) || value < 0), issue('invalid-measurements', 'blocking', 'Manufacturing measurements must be finite and non-negative.', 'decomposition', 'manufacturing-measurements'));
  add(context.meshInspection.boundaryEdgeCount > 0, issue('mesh-open', 'blocking', 'Mesh has open boundary edges.', 'import', 'mesh-boundary'));
  add(context.meshInspection.nonManifoldEdgeCount > 0, issue('mesh-non-manifold', 'blocking', 'Mesh has non-manifold edges.', 'import', 'mesh-non-manifold'));
  add(context.meshInspection.degenerateTriangleCount > 0, issue('mesh-degenerate', 'blocking', 'Mesh contains degenerate triangles.', 'import', 'mesh-degenerate'));
  add(context.meshInspection.invertedVolume, issue('mesh-inverted', 'confirm', 'Mesh orientation appears inverted.', 'import', 'mesh-orientation'));
  add(!context.axisConfirmed, issue('axis-unconfirmed', 'blocking', 'Rotation axis is not confirmed.', 'axis', 'rotation-axis'));
  add(context.balance.status === 'block', issue('balance-block', 'blocking', 'Estimated ideal balance exceeds the safe limit.', 'decomposition', 'balance-centroid'));
  add(context.balance.status === 'confirm', issue('balance-confirm', 'confirm', 'Estimated ideal balance is close to the limit.', 'decomposition', 'balance-centroid'));
  add(!context.material.safe, issue('forbidden-material', 'blocking', 'Material is not laser-safe.', 'engraving', 'material-profile'));
  add(!context.material.calibrated, issue('uncalibrated-material', 'confirm', 'Material profile has not been physically calibrated.', 'engraving', 'material-profile'));
  add(context.measurements.minimumFeatureMm < context.material.minFeatureMm, issue('minimum-feature', 'blocking', 'A feature is below the calibrated minimum.', 'decomposition', 'minimum-feature'));
  add(context.measurements.minimumWebMm < context.material.minWebMm, issue('minimum-web', 'blocking', 'A structural web is too narrow.', 'decomposition', 'minimum-web'));
  add(context.measurements.minimumRemainingMm < context.material.minRemainingMm, issue('engraving-remaining', 'blocking', 'Engraving leaves insufficient material.', 'engraving', 'engraving-depth'));
  add(context.measurements.minimumJointWebMm < context.material.minWebMm, issue('joint-strength', 'blocking', 'Joint web is below the structural minimum.', 'decomposition', 'joint-web'));
  add(context.layout.outOfBoundsPartIds.length > 0, issue('layout-bounds', 'blocking', 'Parts exceed sheet boundaries.', 'export', context.layout.outOfBoundsPartIds[0]));
  add(context.layout.overlapPairs.length > 0, issue('layout-overlap', 'blocking', 'Nested parts overlap.', 'export', context.layout.overlapPairs[0]?.[0]));
  add(context.layout.edgeClearanceMm < context.material.minFeatureMm, issue('layout-edge-clearance', 'confirm', 'Parts are close to the sheet edge.', 'export', 'sheet-edge'));
  const accepted = new Set(context.acceptedConfirmations ?? []);
  return { issues, canExport: issues.every(({ severity, code }) => severity === 'info' || (severity === 'confirm' && accepted.has(code))) };
}
