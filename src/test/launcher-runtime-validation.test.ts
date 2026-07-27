import { describe, expect, test } from 'vitest';
import type { ManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import {
  planFixedLauncherClearance,
  type FixedLauncherPlan,
} from '../domain/outline-assembly/launcher';
import type { FeatureContour } from '../domain/outline-features/types';
import {
  validateLauncherRuntimeGeometry,
  type LauncherRuntimeGeometry,
} from '../../scripts/launcher-runtime-validation';

const material: ManufacturingGeometryProfile = {
  id: 'test-ready', name: 'Test ready material', thicknessMm: 3,
  kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.5,
  fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 },
};

function contour(id: string, extent: number): FeatureContour {
  return {
    id, role: 'CUT_BLACK',
    outer: [[-extent, -extent], [-extent, extent], [extent, extent], [extent, -extent]],
    boundsMm: { minX: -extent, minY: -extent, maxX: extent, maxY: extent },
    areaMm2: extent * extent * 4,
  };
}

function hole(id: string, extent: number): FeatureContour {
  const value = contour(id, extent);
  return { ...value, outer: [...value.outer].reverse() };
}

function fixedPlan(fitOffsetMm = 0): FixedLauncherPlan {
  return planFixedLauncherClearance({
    axisPoint: [0, 0],
    topExterior: contour('top-exterior', 30),
    secondExterior: contour('second-exterior', 30),
    topCentralHole: hole('top-hole', 2),
    secondCentralHole: hole('second-hole', 2),
    material,
    fitOffsetMm,
  });
}

function runtime(plan = fixedPlan()): LauncherRuntimeGeometry {
  return {
    mode: 'exact',
    material,
    launcher: {
      status: 'fixed',
      cutCount: 3,
      templateVersion: plan.templateVersion,
      templateFingerprint: plan.templateFingerprint,
      rotationRad: plan.rotationRad,
      fitOffsetMm: plan.fitOffsetMm,
      finishedAllowanceMm: plan.finishedAllowanceMm,
    },
    layers: [
      { id: 'lower', exterior: contour('lower-exterior', 30), launcherCuts: [] },
      { id: 'second', exterior: contour('second-exterior', 30), centralHole: hole('second-hole', 2), launcherCuts: plan.cuts },
      { id: 'top', exterior: contour('top-exterior', 30), centralHole: hole('top-hole', 2), launcherCuts: plan.cuts },
    ],
  };
}

describe('private release launcher runtime geometry gate', () => {
  test('accepts the fixed official launcher reconciled with both runtime layers and artifacts', () => {
    const result = validateLauncherRuntimeGeometry({
      caseId: 'reference-a',
      runtime: runtime(),
      artifactLauncherCutCount: 6,
    });

    expect(result).toMatchObject({
      caseId: 'reference-a',
      runtimeStatus: 'fixed',
      fixedPlan: 'safe',
      safePlanCount: 1,
      artifactCutCount: 6,
      templateVersion: 1,
      templateFingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      fitOffsetMm: 0,
    });
    expect(result.justification).toMatch(/fixed official template/i);
  });

  test.each([
    ['template version', (candidate: LauncherRuntimeGeometry) => {
      (candidate.launcher as { templateVersion: number }).templateVersion += 1;
    }],
    ['rotation range', (candidate: LauncherRuntimeGeometry) => {
      (candidate.launcher as { rotationRad: number }).rotationRad = Math.PI * 2;
    }],
    ['fit range', (candidate: LauncherRuntimeGeometry) => {
      (candidate.launcher as { fitOffsetMm: number }).fitOffsetMm = 0.21;
    }],
    ['fit step', (candidate: LauncherRuntimeGeometry) => {
      (candidate.launcher as { fitOffsetMm: number }).fitOffsetMm = 0.005;
    }],
    ['finished allowance', (candidate: LauncherRuntimeGeometry) => {
      (candidate.launcher as { finishedAllowanceMm: number }).finishedAllowanceMm += 0.01;
    }],
  ])('rejects invalid fixed %s metadata', (_label, mutate) => {
    const candidate = structuredClone(runtime());
    mutate(candidate);
    expect(() => validateLauncherRuntimeGeometry({
      caseId: 'reference-b',
      runtime: candidate,
      artifactLauncherCutCount: 6,
    })).toThrow(/fixed launcher|fit offset|official template/i);
  });

  test('rejects artifact count and top-two geometry drift', () => {
    expect(() => validateLauncherRuntimeGeometry({
      caseId: 'reference-a', runtime: runtime(), artifactLauncherCutCount: 0,
    })).toThrow(/six packaged/i);

    const changed = structuredClone(runtime());
    ((changed.layers.at(-1)!.launcherCuts[0].outer as [number, number][])[0])[0] += 0.01;
    expect(() => validateLauncherRuntimeGeometry({
      caseId: 'reference-a', runtime: changed, artifactLauncherCutCount: 6,
    })).toThrow(/identical|placement/i);

    const misplaced = structuredClone(runtime());
    (misplaced.layers[0].launcherCuts as FeatureContour[]).push(
      ...structuredClone(misplaced.layers.at(-1)!.launcherCuts),
    );
    expect(() => validateLauncherRuntimeGeometry({
      caseId: 'reference-a', runtime: misplaced, artifactLauncherCutCount: 6,
    })).toThrow(/exactly the top two layers/i);
  });
});
