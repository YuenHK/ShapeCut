import { describe, expect, test } from 'vitest';
import type { ManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import type { HoleCandidateProbeEvidence } from '../domain/outline-2.5d/extract';
import { launcherCandidateGroupsFromHoleCandidates } from '../domain/outline-2.5d/extract';
import type { FeatureContour } from '../domain/outline-features/types';
import { detectLauncherTemplate, planLauncherClearance } from '../domain/outline-assembly/launcher';
import { normalizeLauncherLoops, type LauncherTemplate } from '../domain/outline-assembly/launcher-template';
import {
  validateLauncherRuntimeGeometry,
  type LauncherRuntimeGeometry,
} from '../../scripts/launcher-runtime-validation';

const material: ManufacturingGeometryProfile = {
  id: 'test-ready', name: 'Test ready material', thicknessMm: 3,
  kerfMm: 0.15, minFeatureMm: 0.5, minWebMm: 0.7,
  fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 },
};

const syntheticLoops = normalizeLauncherLoops([
  [[19.5, -0.5], [20.5, -0.5], [20.5, 0.5], [19.5, 0.5]],
  [[-10.5, 16.8205080767], [-9.5, 16.8205080767], [-9.5, 17.8205080767], [-10.5, 17.8205080767]],
  [[-10.5, -17.8205080767], [-9.5, -17.8205080767], [-9.5, -16.8205080767], [-10.5, -16.8205080767]],
]);
const syntheticTemplate: LauncherTemplate = {
  version: 1, loops: syntheticLoops,
  provenanceHashes: ['a'.repeat(64), 'b'.repeat(64)] as [string, string],
};

function contour(id: string, extent: number): FeatureContour {
  return {
    id, role: 'CUT_BLACK',
    outer: [[-extent, -extent], [extent, -extent], [extent, extent], [-extent, extent]],
    boundsMm: { minX: -extent, minY: -extent, maxX: extent, maxY: extent },
    areaMm2: extent * extent * 4,
  };
}

function runtime(
  status: LauncherRuntimeGeometry['launcher']['status'],
  cuts: readonly FeatureContour[],
  extent = 100,
): LauncherRuntimeGeometry {
  return {
    mode: 'exact', material,
    launcher: status === 'omitted'
      ? { status, cutCount: 0 }
      : { status, cutCount: 3, assemblyAllowanceMm: 0.2 },
    layers: [
      { id: 'lower', exterior: contour('lower-exterior', 100), launcherCuts: [] },
      { id: 'second', exterior: contour('second-exterior', extent), launcherCuts: cuts },
      { id: 'top', exterior: contour('top-exterior', extent), launcherCuts: cuts },
    ],
  };
}

function evidence(candidates: HoleCandidateProbeEvidence['candidates'] = []): readonly HoleCandidateProbeEvidence[] {
  return [{
    extractionMode: 'exact', layerId: 'top', candidates,
    exterior: contour('ignored', 100).outer,
    axisPoint: [0, 0], layerWidthMm: 200, planarDiameterMm: 200, cellSizeMm: 0,
  }];
}

function plannedFallback(): readonly FeatureContour[] {
  const plan = planLauncherClearance({
    detection: { status: 'omitted', reason: 'test' },
    axisPoint: [0, 0],
    topExterior: contour('top-exterior', 100),
    secondExterior: contour('second-exterior', 100),
    material, fallback: syntheticTemplate,
  });
  if (plan.status === 'omitted') throw new Error('The synthetic fallback geometry must be safe');
  return plan.cuts;
}

describe('private release launcher runtime geometry gate', () => {
  test('accepts a non-mocked safe fallback plan reconciled with both runtime layers and artifacts', () => {
    const result = validateLauncherRuntimeGeometry({
      caseId: 'reference-a', runtime: runtime('fallback', plannedFallback()),
      evidence: evidence(), artifactLauncherCutCount: 6, fallbackTemplate: syntheticTemplate,
    });
    expect(result).toEqual({
      caseId: 'reference-a', runtimeStatus: 'fallback', detectedPlan: 'unavailable',
      fallbackPlan: 'safe', safePlanCount: 1, artifactCutCount: 6,
      justification: 'Runtime launcher geometry matches the independently recomputed safe fallback plan.',
    });
  });

  test('accepts a non-mocked detected plan recomputed from bounded runtime candidate evidence', () => {
    const candidates = syntheticLoops.map((outer) => ({
      outer, occupiedCellCount: 100, closed: true,
    }));
    const detection = detectLauncherTemplate({
      candidates: launcherCandidateGroupsFromHoleCandidates(candidates), axisPoint: [0, 0],
    });
    if (detection.status === 'omitted') throw new Error('The synthetic evidence must be detectable');
    const detectedPlan = planLauncherClearance({
      detection,
      axisPoint: [0, 0], topExterior: contour('top-exterior', 100),
      secondExterior: contour('second-exterior', 100), material,
    });
    if (detectedPlan.status === 'omitted') throw new Error('The synthetic detected geometry must be safe');

    const result = validateLauncherRuntimeGeometry({
      caseId: 'reference-b', runtime: runtime('detected', detectedPlan.cuts),
      evidence: evidence(candidates), artifactLauncherCutCount: 6, fallbackTemplate: syntheticTemplate,
    });
    expect(result.runtimeStatus).toBe('detected');
    expect(result.detectedPlan).toBe('safe');
    expect(result.safePlanCount).toBe(2);
  });

  test('rejects a runtime omission whenever independent planning finds a safe fallback', () => {
    expect(() => validateLauncherRuntimeGeometry({
      caseId: 'reference-a', runtime: runtime('omitted', []),
      evidence: evidence(), artifactLauncherCutCount: 0, fallbackTemplate: syntheticTemplate,
    })).toThrow(/omitted.*safe fallback/i);
  });

  test('accepts omission only when detected evidence is unavailable and fallback geometry is unsafe', () => {
    const result = validateLauncherRuntimeGeometry({
      caseId: 'reference-a', runtime: runtime('omitted', [], 2),
      evidence: evidence(), artifactLauncherCutCount: 0,
    });
    expect(result).toMatchObject({
      runtimeStatus: 'omitted', detectedPlan: 'unavailable', fallbackPlan: 'unsafe',
      safePlanCount: 0, artifactCutCount: 0,
    });
  });
});
