import type { ManufacturingGeometryProfile } from '../src/domain/materials/manufacturing-profile';
import { validateManufacturingGeometryProfile } from '../src/domain/materials/manufacturing-profile';
import type { OutlineMode } from '../src/domain/outline-2.5d/types';
import {
  LAUNCHER_ASSEMBLY_ALLOWANCE_MM,
  launcherCutsArePhysicallySafe,
  launcherCutsMatchOfficialPlacement,
} from '../src/domain/outline-assembly/launcher';
import { validateLauncherFitOffsetMm } from '../src/domain/outline-assembly/launcher-fit';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../src/domain/outline-assembly/launcher-template';
import {
  LAUNCHER_EXTERIOR_EXPANSION_MAX_MM,
  LAUNCHER_EXTERIOR_EXPANSION_MODE,
  normalizeLauncherExteriorExpansionMm,
} from '../src/domain/outline-assembly/launcher-exterior-expansion';
import type {
  AutomaticLauncherAssembly,
  DecorationOmission,
  FeatureContour,
} from '../src/domain/outline-features/types';

const MAX_RUNTIME_LAYERS = 24;
const FIXED_ARTIFACT_LAUNCHER_CUTS = 6;

export type LauncherRuntimeGeometry = {
  readonly mode: OutlineMode;
  readonly material?: ManufacturingGeometryProfile;
  readonly launcher: AutomaticLauncherAssembly;
  readonly decorationOmissions: readonly DecorationOmission[];
  readonly layers: readonly {
    readonly id: string;
    readonly exterior: FeatureContour;
    readonly centralHole?: FeatureContour;
    readonly launcherCuts: readonly FeatureContour[];
    readonly deepFeatures: readonly FeatureContour[];
    readonly lightFeatures: readonly FeatureContour[];
  }[];
};

export type LauncherRuntimeValidation = {
  readonly caseId: 'reference-a' | 'reference-b';
  readonly runtimeStatus: 'fixed';
  readonly fixedPlan: 'safe';
  readonly safePlanCount: 1;
  readonly artifactCutCount: 6;
  readonly templateVersion: number;
  readonly templateFingerprint: string;
  readonly fitOffsetMm: number;
  readonly rotationRad: number;
  readonly exteriorExpansionMm: number;
  readonly decorationOmissionLayerIds: readonly string[];
  readonly justification: string;
};

export type LauncherRuntimeValidationRequest = {
  readonly caseId: LauncherRuntimeValidation['caseId'];
  readonly runtime: LauncherRuntimeGeometry;
  readonly artifactLauncherCutCount: number;
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

/** Independently revalidates the fixed official launcher from bounded runtime geometry. */
export function validateLauncherRuntimeGeometry(
  request: LauncherRuntimeValidationRequest,
): LauncherRuntimeValidation {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (request.runtime.layers.length < 2 || request.runtime.layers.length > MAX_RUNTIME_LAYERS) {
    throw new RangeError('Launcher runtime validation requires 2 to 24 ordered layers');
  }
  if (request.artifactLauncherCutCount !== FIXED_ARTIFACT_LAUNCHER_CUTS) {
    throw new RangeError('Fixed launcher runtime requires exactly six packaged launcher cuts');
  }
  const material = validateManufacturingGeometryProfile(request.runtime.material);
  const launcher = request.runtime.launcher;
  let fitOffsetMm: number;
  try {
    fitOffsetMm = validateLauncherFitOffsetMm(launcher.fitOffsetMm);
  } catch {
    throw new RangeError('Fixed launcher runtime fit offset must use the bounded 0.01 mm contract');
  }
  if (launcher.status !== 'fixed'
    || launcher.cutCount !== 3
    || launcher.templateVersion !== OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
    || launcher.templateFingerprint !== OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT
    || !Number.isFinite(launcher.rotationRad)
    || launcher.rotationRad < 0
    || launcher.rotationRad >= Math.PI * 2
    || launcher.finishedAllowanceMm !== LAUNCHER_ASSEMBLY_ALLOWANCE_MM + fitOffsetMm) {
    throw new RangeError('Fixed launcher runtime metadata does not match the official template contract');
  }
  const top = request.runtime.layers.at(-1)!;
  const second = request.runtime.layers.at(-2)!;
  const lower = request.runtime.layers.slice(0, -2);
  const expansion = launcher.exteriorExpansion;
  let normalizedExpansion: number;
  try {
    normalizedExpansion = normalizeLauncherExteriorExpansionMm(expansion.offsetMm);
  } catch {
    throw new RangeError('Fixed launcher exterior expansion must use the bounded 0.01 mm contract');
  }
  if (expansion.mode !== LAUNCHER_EXTERIOR_EXPANSION_MODE
    || normalizedExpansion !== expansion.offsetMm
    || expansion.maxOffsetMm !== LAUNCHER_EXTERIOR_EXPANSION_MAX_MM
    || expansion.affectedLayerIds[0] !== second.id
    || expansion.affectedLayerIds[1] !== top.id) {
    throw new RangeError('Fixed launcher exterior expansion does not identify the canonical top two layers');
  }
  if (top.launcherCuts.length !== 3 || second.launcherCuts.length !== 3
    || lower.some(({ launcherCuts }) => launcherCuts.length !== 0)
    || !sameCuts(top.launcherCuts, second.launcherCuts, deadline, checkpoint)) {
    throw new RangeError('Fixed launcher runtime must expose three identical cuts on exactly the top two layers');
  }
  if (!launcherCutsMatchOfficialPlacement({
    cuts: top.launcherCuts,
    axisPoint: [0, 0],
    rotationRad: launcher.rotationRad,
    fitOffsetMm,
    material,
    deadline,
    checkpoint,
  })) {
    throw new RangeError('Fixed launcher runtime geometry does not match official template placement');
  }
  if (!launcherCutsArePhysicallySafe({
    cuts: top.launcherCuts,
    top: { exterior: top.exterior, centralHole: top.centralHole },
    second: { exterior: second.exterior, centralHole: second.centralHole },
    material,
    deadline,
    checkpoint,
  })) {
    throw new RangeError('Fixed launcher runtime geometry fails independent physical safety validation');
  }
  if (!Array.isArray(request.runtime.decorationOmissions)
    || request.runtime.decorationOmissions.length > request.runtime.layers.length) {
    throw new RangeError('Launcher runtime decoration omission evidence exceeds the layer bound');
  }
  let previousOmissionPosition = -1;
  const decorationOmissionLayerIds: string[] = [];
  for (const omission of request.runtime.decorationOmissions) {
    checkRuntime(deadline, checkpoint);
    const position = request.runtime.layers.findIndex(({ id }) => id === omission.layerId);
    const layer = request.runtime.layers[position];
    if (Object.keys(omission).length !== 3
      || omission.reason !== 'protected-cut-work-budget'
      || omission.roles.length !== 2
      || omission.roles[0] !== 'DEEP_RED'
      || omission.roles[1] !== 'LIGHT_BLUE'
      || position <= previousOmissionPosition
      || !layer
      || layer.deepFeatures.length !== 0
      || layer.lightFeatures.length !== 0) {
      throw new RangeError('Launcher runtime decoration omission evidence is invalid or inconsistent');
    }
    decorationOmissionLayerIds.push(omission.layerId);
    previousOmissionPosition = position;
  }
  return {
    caseId: request.caseId,
    runtimeStatus: 'fixed',
    fixedPlan: 'safe',
    safePlanCount: 1,
    artifactCutCount: 6,
    templateVersion: launcher.templateVersion,
    templateFingerprint: launcher.templateFingerprint,
    fitOffsetMm,
    rotationRad: launcher.rotationRad,
    exteriorExpansionMm: normalizedExpansion,
    decorationOmissionLayerIds,
    justification: 'Runtime launcher geometry matches the independently revalidated fixed official template.',
  };
}
