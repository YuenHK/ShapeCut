import type { ManufacturingGeometryProfile } from '../src/domain/materials/manufacturing-profile';
import { validateManufacturingGeometryProfile } from '../src/domain/materials/manufacturing-profile';
import {
  launcherCandidateGroupsFromHoleCandidates,
  type HoleCandidateProbeEvidence,
} from '../src/domain/outline-2.5d/extract';
import type { OutlineMode } from '../src/domain/outline-2.5d/types';
import {
  detectLauncherTemplate,
  planLauncherClearance,
  type LauncherPlan,
} from '../src/domain/outline-assembly/launcher';
import type { LauncherTemplate } from '../src/domain/outline-assembly/launcher-template';
import type { AutomaticOutlineAssembly, FeatureContour } from '../src/domain/outline-features/types';

const MAX_RUNTIME_LAYERS = 24;
const MAX_ARTIFACT_LAUNCHER_CUTS = 6;

export type LauncherRuntimeGeometry = {
  readonly mode: OutlineMode;
  readonly material?: ManufacturingGeometryProfile;
  readonly launcher: AutomaticOutlineAssembly['launcher'];
  readonly layers: readonly {
    readonly id: string;
    readonly exterior: FeatureContour;
    readonly centralHole?: FeatureContour;
    readonly launcherCuts: readonly FeatureContour[];
  }[];
};

export type LauncherRuntimeValidation = {
  readonly caseId: 'reference-a' | 'reference-b';
  readonly runtimeStatus: 'detected' | 'fallback' | 'omitted';
  readonly detectedPlan: 'safe' | 'unsafe' | 'unavailable';
  readonly fallbackPlan: 'safe' | 'unsafe';
  readonly safePlanCount: number;
  readonly artifactCutCount: number;
  readonly justification: string;
};

export type LauncherRuntimeValidationRequest = {
  readonly caseId: LauncherRuntimeValidation['caseId'];
  readonly runtime: LauncherRuntimeGeometry;
  readonly evidence: readonly HoleCandidateProbeEvidence[];
  readonly artifactLauncherCutCount: number;
  /** Test seam for proving the gate's fallback-positive branch with synthetic geometry. */
  readonly fallbackTemplate?: LauncherTemplate;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (!Number.isFinite(deadline) || Date.now() > deadline) {
    throw new RangeError('Launcher runtime validation exceeded the bounded deadline');
  }
}

function sameCuts(
  actual: readonly FeatureContour[],
  expected: readonly FeatureContour[],
  deadline: number,
  checkpoint: () => void,
): boolean {
  if (actual.length !== expected.length) return false;
  for (let cutIndex = 0; cutIndex < actual.length; cutIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const left = actual[cutIndex].outer, right = expected[cutIndex].outer;
    if (left.length !== right.length) return false;
    for (let pointIndex = 0; pointIndex < left.length; pointIndex += 1) {
      if ((pointIndex & 63) === 0) checkRuntime(deadline, checkpoint);
      if (left[pointIndex][0] !== right[pointIndex][0]
        || left[pointIndex][1] !== right[pointIndex][1]) return false;
    }
  }
  return true;
}

function planStatus(plan: LauncherPlan | undefined): 'safe' | 'unsafe' | 'unavailable' {
  return plan === undefined ? 'unavailable' : plan.status === 'omitted' ? 'unsafe' : 'safe';
}

/** Recomputes launcher safety from runtime geometry instead of trusting the worker summary. */
export function validateLauncherRuntimeGeometry(
  request: LauncherRuntimeValidationRequest,
): LauncherRuntimeValidation {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (request.runtime.layers.length < 2 || request.runtime.layers.length > MAX_RUNTIME_LAYERS) {
    throw new RangeError('Launcher runtime validation requires 2 to 24 ordered layers');
  }
  if (!Number.isInteger(request.artifactLauncherCutCount)
    || request.artifactLauncherCutCount < 0
    || request.artifactLauncherCutCount > MAX_ARTIFACT_LAUNCHER_CUTS) {
    throw new RangeError('Launcher artifact evidence exceeds the bounded cut count');
  }
  const material = validateManufacturingGeometryProfile(request.runtime.material);
  const top = request.runtime.layers.at(-1)!;
  const second = request.runtime.layers.at(-2)!;
  const extractionMode = request.runtime.mode === 'exact' ? 'exact' : 'projected';
  const matchingEvidence = request.evidence.filter((item) => (
    item.extractionMode === extractionMode && item.layerId === top.id
  ));
  if (matchingEvidence.length !== 1) {
    throw new RangeError('Launcher runtime validation requires exactly one top-layer candidate record');
  }
  const planningBase = {
    axisPoint: [0, 0] as const,
    topExterior: top.exterior,
    secondExterior: second.exterior,
    topCentralHole: top.centralHole,
    secondCentralHole: second.centralHole,
    material,
    deadline,
    checkpoint,
  };
  const candidateGroups = launcherCandidateGroupsFromHoleCandidates(
    matchingEvidence[0].candidates, deadline, checkpoint,
  );
  const detection = detectLauncherTemplate({
    candidates: candidateGroups, axisPoint: [0, 0], deadline, checkpoint,
  });
  const detectedPlan = detection.status === 'detected'
    ? planLauncherClearance({ ...planningBase, detection })
    : undefined;
  const fallbackPlan = planLauncherClearance({
    ...planningBase,
    detection: { status: 'omitted', reason: 'Independent fallback validation' },
    fallback: request.fallbackTemplate,
  });
  const detectedStatus = planStatus(detectedPlan);
  const fallbackStatus = planStatus(fallbackPlan) as 'safe' | 'unsafe';
  const safePlanCount = Number(detectedStatus === 'safe') + Number(fallbackStatus === 'safe');
  const runtimeStatus = request.runtime.launcher.status;
  const expectedArtifactCuts = runtimeStatus === 'omitted' ? 0 : 6;
  if (request.artifactLauncherCutCount !== expectedArtifactCuts) {
    throw new RangeError('Launcher runtime summary does not match packaged artifact cut geometry');
  }
  const activeLayers = request.runtime.layers.filter(({ launcherCuts }) => launcherCuts.length !== 0);
  if (runtimeStatus === 'omitted') {
    if (request.runtime.launcher.cutCount !== 0 || activeLayers.length !== 0) {
      throw new RangeError('Omitted launcher runtime must contain no canonical launcher cuts');
    }
    if (detectedStatus === 'safe') {
      throw new RangeError('Runtime omitted launcher geometry despite a safe detected plan');
    }
    if (fallbackStatus === 'safe') {
      throw new RangeError('Runtime omitted launcher geometry despite a safe fallback plan');
    }
    return {
      caseId: request.caseId, runtimeStatus, detectedPlan: detectedStatus,
      fallbackPlan: fallbackStatus, safePlanCount, artifactCutCount: request.artifactLauncherCutCount,
      justification: 'Independent detected and fallback geometry checks found no safe launcher plan.',
    };
  }
  if (request.runtime.launcher.cutCount !== 3
    || activeLayers.length !== 2
    || activeLayers[0] !== second || activeLayers[1] !== top
    || second.launcherCuts.length !== 3 || top.launcherCuts.length !== 3) {
    throw new RangeError('Active launcher runtime must expose three identical cuts on exactly the top two layers');
  }
  const selectedPlan = runtimeStatus === 'detected' ? detectedPlan : fallbackPlan;
  if (!selectedPlan || selectedPlan.status !== runtimeStatus
    || !sameCuts(second.launcherCuts, selectedPlan.cuts, deadline, checkpoint)
    || !sameCuts(top.launcherCuts, selectedPlan.cuts, deadline, checkpoint)) {
    throw new RangeError(`Runtime ${runtimeStatus} launcher geometry does not match independent recomputation`);
  }
  if (runtimeStatus === 'fallback' && detectedStatus === 'safe') {
    throw new RangeError('Runtime used fallback launcher geometry despite a safe detected plan');
  }
  return {
    caseId: request.caseId, runtimeStatus, detectedPlan: detectedStatus,
    fallbackPlan: fallbackStatus, safePlanCount, artifactCutCount: request.artifactLauncherCutCount,
    justification: runtimeStatus === 'detected'
      ? 'Runtime launcher geometry matches the independently recomputed safe detected plan.'
      : 'Runtime launcher geometry matches the independently recomputed safe fallback plan.',
  };
}
