import type { Point2 } from '../decomposition/types';
import { polygonsIntersectOrTouch, validatePolygon } from '../engraving/geometry';
import { simpleMiterPolygonKernel } from '../layout/polygon-kernel';
import type { ManufacturingGeometryProfile } from '../materials/manufacturing-profile';
import { isStrictlyContainedLoop } from '../outline-features/hole';
import type { FeatureContour } from '../outline-features/types';
import { contourBounds, signedArea } from '../outline-2.5d/simplify';
import {
  KNIGHT_FORTRESS_LAUNCHER_TEMPLATE,
  LAUNCHER_TEMPLATE_MAX_POINTS,
  normalizeLauncherLoops,
  OFFICIAL_THREE_PRONG_TEMPLATE,
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
  type LauncherLoops,
  type LauncherTemplate,
} from './launcher-template';
import { validateLauncherFitOffsetMm } from './launcher-fit';
import { finishedRemovalEnvelope } from './physical-cut-envelope';

export const LAUNCHER_ASSEMBLY_ALLOWANCE_MM = 0.2 as const;
export const LAUNCHER_OMISSION_WARNING = '無法安全保留原裝發射器相容性，已省略三個發射器開孔';
/** Source evidence below these bounded floors is never considered model-derived geometry. */
export const LAUNCHER_MIN_LOOP_SUPPORT = 0.1;
export const LAUNCHER_MIN_GROUP_EVIDENCE = 0.1;
export const LAUNCHER_MIN_RELIABLE_SCORE = 0.2;
export const LAUNCHER_SIZE_SCORE_WEIGHT = 0.1;

export type LauncherLoopEvidence = {
  readonly outer: readonly Point2[];
  readonly closed: boolean;
  readonly support: number;
};
export type LauncherCandidateGroup = {
  readonly loops: readonly [LauncherLoopEvidence, LauncherLoopEvidence, LauncherLoopEvidence];
  readonly evidenceStrength: number;
};
export type LauncherDetection =
  | {
    readonly status: 'detected';
    readonly loops: LauncherLoops;
    readonly score: number;
    readonly sourceCandidateIndex: number;
  }
  | { readonly status: 'omitted'; readonly reason: string };
export type LauncherDetectionRequest = {
  readonly candidates: readonly LauncherCandidateGroup[];
  readonly axisPoint: Point2;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};
export type LauncherPlan =
  | { readonly status: 'detected' | 'fallback'; readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour]; readonly assemblyAllowanceMm: 0.2 }
  | { readonly status: 'omitted'; readonly cuts: readonly []; readonly warning: string };
export type LauncherPlanningLayer = {
  readonly exterior: FeatureContour;
  readonly centralHole?: FeatureContour;
};
export type LauncherClearanceRequest = {
  readonly detection: LauncherDetection;
  readonly fallback?: LauncherTemplate;
  readonly axisPoint: Point2;
  readonly topExterior: FeatureContour;
  readonly secondExterior: FeatureContour;
  readonly topCentralHole?: FeatureContour;
  readonly secondCentralHole?: FeatureContour;
  readonly material: Pick<ManufacturingGeometryProfile, 'kerfMm' | 'minWebMm'>;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};
export type FixedLauncherPlan = {
  readonly status: 'fixed';
  readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour];
  readonly templateVersion: number;
  readonly templateFingerprint: string;
  readonly rotationRad: number;
  readonly fitOffsetMm: number;
  readonly finishedAllowanceMm: number;
};
export type FixedLauncherClearanceRequest = {
  readonly axisPoint: Point2;
  readonly topExterior: FeatureContour;
  readonly secondExterior: FeatureContour;
  readonly topCentralHole?: FeatureContour;
  readonly secondCentralHole?: FeatureContour;
  readonly decorationContours?: readonly FeatureContour[];
  readonly material: Pick<ManufacturingGeometryProfile, 'kerfMm' | 'minWebMm'>;
  readonly fitOffsetMm: number;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};
export type LauncherPhysicalSafetyRequest = {
  readonly cuts: readonly FeatureContour[];
  readonly top: LauncherPlanningLayer;
  readonly second: LauncherPlanningLayer;
  readonly material: Pick<ManufacturingGeometryProfile, 'kerfMm' | 'minWebMm'>;
  readonly deadline?: number;
  readonly checkpoint?: (label?: string) => void;
};
export type OfficialLauncherPlacementValidationRequest = {
  readonly cuts: readonly FeatureContour[];
  readonly axisPoint: Point2;
  readonly rotationRad: number;
  readonly fitOffsetMm: number;
  readonly material: Pick<ManufacturingGeometryProfile, 'kerfMm'>;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};

export class LauncherCompatibilityError extends RangeError {
  readonly name = 'LauncherCompatibilityError';
  readonly code = 'LAUNCHER_INCOMPATIBLE';
}

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Launcher detection exceeded the runtime budget');
}

class LauncherPlanningCheckpointInterruption {
  constructor(readonly original: unknown) {}
}

function polygonCentroid(
  points: readonly Point2[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): Point2 {
  const area = signedArea(points, deadline, checkpoint);
  let x = 0, y = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    const point = points[index], next = points[(index + 1) % points.length];
    const cross = point[0] * next[1] - next[0] * point[1];
    x += (point[0] + next[0]) * cross;
    y += (point[1] + next[1]) * cross;
  }
  return [x / (6 * area), y / (6 * area)];
}

function positiveAngle(angle: number): number {
  const full = Math.PI * 2;
  return (angle % full + full) % full;
}

function evaluateCandidate(
  candidate: LauncherCandidateGroup,
  axisPoint: Point2,
  deadline: number,
  checkpoint: () => void,
  validity: Map<readonly Point2[], boolean>,
): number | undefined {
  if (!Number.isFinite(candidate.evidenceStrength)
    || candidate.evidenceStrength < LAUNCHER_MIN_GROUP_EVIDENCE || candidate.evidenceStrength > 1
    || candidate.loops.length !== 3) return undefined;
  for (const loop of candidate.loops) {
    checkRuntime(deadline, checkpoint);
    let simple = validity.get(loop.outer);
    if (simple === undefined) {
      simple = loop.outer.length <= LAUNCHER_TEMPLATE_MAX_POINTS
        && validatePolygon({ points: loop.outer }, () => checkRuntime(deadline, checkpoint));
      validity.set(loop.outer, simple);
    }
    if (!loop.closed || !Number.isFinite(loop.support) || loop.support < LAUNCHER_MIN_LOOP_SUPPORT || loop.support > 1
      || !simple) return undefined;
  }
  const centers = candidate.loops.map(({ outer }) => polygonCentroid(outer, deadline, checkpoint));
  const angles = centers.map(([x, y]) => positiveAngle(Math.atan2(y - axisPoint[1], x - axisPoint[0])))
    .sort((left, right) => left - right);
  const gaps = angles.map((angle, index) => positiveAngle(angles[(index + 1) % 3] - angle) * 180 / Math.PI);
  if (gaps.some((gap) => gap < 112 - 1e-10 || gap > 128 + 1e-10)) return undefined;
  const radii = centers.map(([x, y]) => Math.hypot(x - axisPoint[0], y - axisPoint[1]));
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / 3;
  if (!Number.isFinite(meanRadius) || meanRadius <= 0) return undefined;
  const radialSpread = Math.max(...radii.map((radius) => Math.abs(radius - meanRadius))) / meanRadius;
  if (radialSpread > 0.08 + 1e-12) return undefined;
  const groupCenter: Point2 = [
    centers.reduce((sum, [x]) => sum + x, 0) / 3,
    centers.reduce((sum, [, y]) => sum + y, 0) / 3,
  ];
  const centeredError = Math.hypot(groupCenter[0] - axisPoint[0], groupCenter[1] - axisPoint[1]) / meanRadius;
  const symmetryError = gaps.reduce((sum, gap) => sum + Math.abs(gap - 120) / 8, 0) / 3;
  const support = (candidate.evidenceStrength + candidate.loops.reduce((sum, loop) => sum + loop.support, 0) / 3) / 2;
  const averageArea = candidate.loops.reduce(
    (sum, loop) => sum + Math.abs(signedArea(loop.outer, deadline, checkpoint)),
    0,
  ) / 3;
  const normalizedSize = Math.max(0, Math.min(1, averageArea / (meanRadius * meanRadius * 0.05)));
  return support - centeredError * 2 - symmetryError * 0.1 - radialSpread
    + normalizedSize * LAUNCHER_SIZE_SCORE_WEIGHT;
}

function copySelectedLauncherLoops(
  candidate: LauncherCandidateGroup,
  axisPoint: Point2,
  deadline: number,
  checkpoint: () => void,
): LauncherLoops {
  const copied: Point2[][] = [];
  for (const { outer } of candidate.loops) {
    const loop: Point2[] = [];
    for (let index = 0; index < outer.length; index += 1) {
      if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
      loop.push([outer[index][0] - axisPoint[0], outer[index][1] - axisPoint[1]]);
    }
    copied.push(loop);
  }
  return copied as unknown as LauncherLoops;
}

export function detectLauncherTemplate(request: LauncherDetectionRequest): LauncherDetection {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (request.axisPoint.some((value) => !Number.isFinite(value)) || request.candidates.length > 64) {
    throw new RangeError('Launcher detection requires finite bounded candidate evidence');
  }
  let selected: { readonly score: number; readonly index: number } | undefined;
  const validity = new Map<readonly Point2[], boolean>();
  for (let index = 0; index < request.candidates.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const score = evaluateCandidate(request.candidates[index], request.axisPoint, deadline, checkpoint, validity);
    if (score === undefined || score < LAUNCHER_MIN_RELIABLE_SCORE) continue;
    if (!selected || score > selected.score + 1e-12) selected = { score, index };
  }
  if (!selected) return { status: 'omitted', reason: 'No reliable three-hook launcher evidence' };
  const source = copySelectedLauncherLoops(
    request.candidates[selected.index], request.axisPoint, deadline, checkpoint,
  );
  return {
    status: 'detected',
    loops: normalizeLauncherLoops(source, deadline, checkpoint),
    score: selected.score,
    sourceCandidateIndex: selected.index,
  };
}

function translateLauncherLoop(
  loop: readonly Point2[],
  axisPoint: Point2,
  deadline: number,
  checkpoint: () => void,
): Point2[] {
  const translated: Point2[] = [];
  for (let index = 0; index < loop.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    translated.push([loop[index][0] + axisPoint[0], loop[index][1] + axisPoint[1]]);
  }
  return translated;
}

function distancePointToSegment(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const ratio = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator));
  return Math.hypot(point[0] - start[0] - dx * ratio, point[1] - start[1] - dy * ratio);
}

function boundaryDistance(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let distance = Infinity;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if ((leftIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    const leftStart = left[leftIndex], leftEnd = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if ((rightIndex & 255) === 0) checkRuntime(deadline, checkpoint);
      const rightStart = right[rightIndex], rightEnd = right[(rightIndex + 1) % right.length];
      distance = Math.min(distance,
        distancePointToSegment(leftStart, rightStart, rightEnd),
        distancePointToSegment(leftEnd, rightStart, rightEnd),
        distancePointToSegment(rightStart, leftStart, leftEnd),
        distancePointToSegment(rightEnd, leftStart, leftEnd));
    }
  }
  return distance;
}

type LauncherFinishedSafetyClearances = {
  /** Finished launcher opening to an exterior or central-hole toolpath. */
  readonly toolpathBoundaryMm: number;
  /** Finished launcher opening to another finished launcher opening. */
  readonly interLauncherMm: number;
};

function finishedSafetyClearances(
  material: Pick<ManufacturingGeometryProfile, 'kerfMm' | 'minWebMm'>,
): LauncherFinishedSafetyClearances {
  return {
    toolpathBoundaryMm: material.minWebMm + material.kerfMm / 2,
    interLauncherMm: material.minWebMm,
  };
}

function finishedCutsAreSafe(
  cuts: readonly FeatureContour[],
  layer: LauncherPlanningLayer,
  clearances: LauncherFinishedSafetyClearances,
  deadline: number,
  checkpoint: () => void,
): boolean {
  for (let index = 0; index < cuts.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const cut = cuts[index];
    if (!isStrictlyContainedLoop(
      layer.exterior.outer, cut.outer, clearances.toolpathBoundaryMm, deadline, checkpoint,
    )) return false;
    if (layer.centralHole && (polygonsIntersectOrTouch(
      { points: cut.outer }, { points: layer.centralHole.outer }, () => checkRuntime(deadline, checkpoint),
    ) || boundaryDistance(cut.outer, layer.centralHole.outer, deadline, checkpoint) + 1e-12
      < clearances.toolpathBoundaryMm)) return false;
    for (let other = 0; other < index; other += 1) {
      if (polygonsIntersectOrTouch(
        { points: cut.outer }, { points: cuts[other].outer }, () => checkRuntime(deadline, checkpoint),
      ) || boundaryDistance(cut.outer, cuts[other].outer, deadline, checkpoint) + 1e-12
        < clearances.interLauncherMm) return false;
    }
  }
  return true;
}

/** Independently revalidates canonical launcher toolpaths as finished laser-removal openings. */
export function launcherCutsArePhysicallySafe(request: LauncherPhysicalSafetyRequest): boolean {
  const deadline = request.deadline ?? Infinity;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (request.cuts.length !== 3
    || !Number.isFinite(request.material.kerfMm) || request.material.kerfMm < 0
    || !Number.isFinite(request.material.minWebMm) || request.material.minWebMm < 0) return false;
  const finished: FeatureContour[] = [];
  for (let index = 0; index < request.cuts.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const outer = finishedRemovalEnvelope(
      request.cuts[index].outer,
      request.material.kerfMm,
      deadline,
      checkpoint,
    );
    finished.push({
      id: `validated-launcher-finished-${index + 1}`,
      role: 'CUT_BLACK',
      outer,
      boundsMm: contourBounds(outer, deadline, checkpoint),
      areaMm2: Math.abs(signedArea(outer, deadline, checkpoint)),
    });
  }
  const clearances = finishedSafetyClearances(request.material);
  return finishedCutsAreSafe(finished, request.top, clearances, deadline, checkpoint)
    && finishedCutsAreSafe(finished, request.second, clearances, deadline, checkpoint);
}

const LAUNCHER_ROTATION_STEPS = 120;

function rotateLoop(loop: readonly Point2[], rotationRad: number, axis: Point2): readonly Point2[] {
  const cosine = Math.cos(rotationRad), sine = Math.sin(rotationRad);
  return loop.map(([x, y]): Point2 => [
    axis[0] + x * cosine - y * sine,
    axis[1] + x * sine + y * cosine,
  ]);
}

type ScoredFixedLauncherPlan = FixedLauncherPlan & {
  readonly minimumStructuralClearanceMm: number;
  readonly decorationOverlapCount: number;
};
type FixedLauncherGeometry = {
  readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour];
  readonly finishedCuts: readonly [FeatureContour, FeatureContour, FeatureContour];
  readonly finishedAllowanceMm: number;
};

function fixedStructuralClearance(
  finishedCuts: readonly FeatureContour[],
  request: FixedLauncherClearanceRequest,
  deadline: number,
  checkpoint: () => void,
): number {
  const clearances = finishedSafetyClearances(request.material);
  const layers = [
    { exterior: request.topExterior, centralHole: request.topCentralHole },
    { exterior: request.secondExterior, centralHole: request.secondCentralHole },
  ];
  let minimum = Infinity;
  for (let index = 0; index < finishedCuts.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const cut = finishedCuts[index];
    for (const layer of layers) {
      minimum = Math.min(
        minimum,
        boundaryDistance(cut.outer, layer.exterior.outer, deadline, checkpoint)
          - clearances.toolpathBoundaryMm,
      );
      if (layer.centralHole) {
        minimum = Math.min(
          minimum,
          boundaryDistance(cut.outer, layer.centralHole.outer, deadline, checkpoint)
            - clearances.toolpathBoundaryMm,
        );
      }
    }
    for (let other = 0; other < index; other += 1) {
      minimum = Math.min(
        minimum,
        boundaryDistance(cut.outer, finishedCuts[other].outer, deadline, checkpoint)
          - clearances.interLauncherMm,
      );
    }
  }
  return minimum;
}

function decorationOverlapCount(
  finishedCuts: readonly FeatureContour[],
  decorationContours: readonly FeatureContour[],
  deadline: number,
  checkpoint: () => void,
): number {
  let count = 0;
  for (const decoration of decorationContours) {
    checkRuntime(deadline, checkpoint);
    if (finishedCuts.some((cut) => polygonsIntersectOrTouch(
      { points: cut.outer },
      { points: decoration.outer },
      () => checkRuntime(deadline, checkpoint),
    ))) count += 1;
  }
  return count;
}

function buildFixedLauncherGeometry(
  loops: LauncherLoops,
  material: Pick<ManufacturingGeometryProfile, 'kerfMm'>,
  fitOffsetMm: number,
  deadline: number,
  checkpoint: () => void,
): FixedLauncherGeometry | undefined {
  const kernelCheckpoint = (): void => checkRuntime(deadline, checkpoint);
  const finishedAllowanceMm = LAUNCHER_ASSEMBLY_ALLOWANCE_MM + fitOffsetMm;
  const finishedCuts: FeatureContour[] = [];
  const cuts: FeatureContour[] = [];
  for (let index = 0; index < 3; index += 1) {
    checkRuntime(deadline, checkpoint);
    const finished = simpleMiterPolygonKernel.offset(
      { points: loops[index] }, finishedAllowanceMm, kernelCheckpoint,
    );
    if (finished.length !== 1 || !validatePolygon(finished[0], kernelCheckpoint)) return undefined;
    const path = simpleMiterPolygonKernel.offset(
      finished[0], -material.kerfMm / 2, kernelCheckpoint,
    );
    if (path.length !== 1 || !validatePolygon(path[0], kernelCheckpoint)) return undefined;
    const finishedOuter = finished[0].points;
    finishedCuts.push({
      id: `fixed-launcher-finished-envelope-${index + 1}`,
      role: 'CUT_BLACK',
      outer: finishedOuter,
      boundsMm: contourBounds(finishedOuter, deadline, checkpoint),
      areaMm2: Math.abs(signedArea(finishedOuter, deadline, checkpoint)),
    });
    const pathOuter = path[0].points;
    const outer = signedArea(pathOuter, deadline, checkpoint) > 0
      ? pathOuter
      : pathOuter.map((_, pointIndex) => {
        if ((pointIndex & 63) === 0) checkpoint();
        return pathOuter[pathOuter.length - 1 - pointIndex];
      });
    cuts.push({
      id: `fixed-launcher-clearance-${index + 1}`,
      role: 'CUT_BLACK',
      outer,
      boundsMm: contourBounds(outer, deadline, checkpoint),
      areaMm2: Math.abs(signedArea(outer, deadline, checkpoint)),
    });
  }
  return {
    cuts: cuts as unknown as readonly [FeatureContour, FeatureContour, FeatureContour],
    finishedCuts: finishedCuts as unknown as readonly [FeatureContour, FeatureContour, FeatureContour],
    finishedAllowanceMm,
  };
}

function recoverableLauncherOffsetError(error: unknown): boolean {
  return error instanceof RangeError
    && !/runtime budget/i.test(error.message)
    && /^(?:Offset |Built-in offset|Launcher (?:finished opening|toolpath))/.test(error.message);
}

function materializeFixedCuts(
  loops: LauncherLoops,
  request: FixedLauncherClearanceRequest,
  fitOffsetMm: number,
  rotationRad: number,
): ScoredFixedLauncherPlan | undefined {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  const guardedCheckpoint = (): void => {
    try {
      checkpoint();
    } catch (error) {
      throw new LauncherPlanningCheckpointInterruption(error);
    }
  };
  let geometry: FixedLauncherGeometry | undefined;
  let minimumStructuralClearanceMm: number;
  let overlapCount: number;
  try {
    geometry = buildFixedLauncherGeometry(
      loops, request.material, fitOffsetMm, deadline, guardedCheckpoint,
    );
    if (!geometry) return undefined;
    minimumStructuralClearanceMm = fixedStructuralClearance(
      geometry.finishedCuts, request, deadline, guardedCheckpoint,
    );
    overlapCount = decorationOverlapCount(
      geometry.finishedCuts, request.decorationContours ?? [], deadline, guardedCheckpoint,
    );
  } catch (error) {
    if (error instanceof LauncherPlanningCheckpointInterruption) throw error.original;
    if (recoverableLauncherOffsetError(error)) return undefined;
    throw error;
  }
  return {
    status: 'fixed',
    cuts: geometry.cuts,
    templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
    rotationRad,
    fitOffsetMm,
    finishedAllowanceMm: geometry.finishedAllowanceMm,
    minimumStructuralClearanceMm,
    decorationOverlapCount: overlapCount,
  };
}

/** Rebuilds the official template placement and reconciles it with canonical launcher toolpaths. */
export function launcherCutsMatchOfficialPlacement(
  request: OfficialLauncherPlacementValidationRequest,
): boolean {
  const deadline = request.deadline ?? Infinity;
  const checkpoint = request.checkpoint ?? (() => undefined);
  const guardedCheckpoint = (): void => {
    try {
      checkpoint();
    } catch (error) {
      throw new LauncherPlanningCheckpointInterruption(error);
    }
  };
  try {
    checkRuntime(deadline, guardedCheckpoint);
    if (request.cuts.length !== 3
      || request.axisPoint.some((value) => !Number.isFinite(value))
      || !Number.isFinite(request.rotationRad)
      || request.rotationRad < 0
      || request.rotationRad >= Math.PI * 2
      || !Number.isFinite(request.material.kerfMm)
      || request.material.kerfMm < 0) return false;
    const fitOffsetMm = validateLauncherFitOffsetMm(request.fitOffsetMm);
    const loops = OFFICIAL_THREE_PRONG_TEMPLATE.loops.map(
      (loop) => rotateLoop(loop, request.rotationRad, request.axisPoint),
    ) as unknown as LauncherLoops;
    const expected = buildFixedLauncherGeometry(
      loops, request.material, fitOffsetMm, deadline, guardedCheckpoint,
    );
    if (!expected) return false;
    return expected.cuts.every((cut, index) => {
      checkRuntime(deadline, guardedCheckpoint);
      const actual = request.cuts[index];
      if (actual.role !== cut.role
        || actual.areaMm2 !== cut.areaMm2
        || JSON.stringify(actual.boundsMm) !== JSON.stringify(cut.boundsMm)
        || actual.outer.length !== cut.outer.length) return false;
      for (let pointIndex = 0; pointIndex < cut.outer.length; pointIndex += 1) {
        if ((pointIndex & 63) === 0) checkRuntime(deadline, guardedCheckpoint);
        if (actual.outer[pointIndex][0] !== cut.outer[pointIndex][0]
          || actual.outer[pointIndex][1] !== cut.outer[pointIndex][1]) return false;
      }
      return true;
    });
  } catch (error) {
    if (error instanceof LauncherPlanningCheckpointInterruption) throw error.original;
    if (recoverableLauncherOffsetError(error)) return false;
    if (error instanceof RangeError && /fit offset/i.test(error.message)) return false;
    throw error;
  }
}

function withoutPrivatePlacementScore(plan: ScoredFixedLauncherPlan): FixedLauncherPlan {
  const {
    minimumStructuralClearanceMm: _minimumStructuralClearanceMm,
    decorationOverlapCount: _decorationOverlapCount,
    ...publicPlan
  } = plan;
  return publicPlan;
}

export function compareLauncherPlacementScores(
  left: Readonly<{
    minimumStructuralClearanceMm: number;
    decorationOverlapCount: number;
    rotationRad: number;
  }>,
  right: Readonly<{
    minimumStructuralClearanceMm: number;
    decorationOverlapCount: number;
    rotationRad: number;
  }>,
): number {
  return right.minimumStructuralClearanceMm - left.minimumStructuralClearanceMm
    || left.decorationOverlapCount - right.decorationOverlapCount
    || left.rotationRad - right.rotationRad;
}

export function planFixedLauncherClearance(request: FixedLauncherClearanceRequest): FixedLauncherPlan {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (request.axisPoint.some((value) => !Number.isFinite(value))
    || !Number.isFinite(request.material.kerfMm) || request.material.kerfMm < 0
    || !Number.isFinite(request.material.minWebMm) || request.material.minWebMm < 0) {
    throw new RangeError('Fixed launcher planning requires finite non-negative material geometry');
  }
  const fitOffsetMm = validateLauncherFitOffsetMm(request.fitOffsetMm);
  if (OFFICIAL_THREE_PRONG_TEMPLATE.loops.length !== 3
    || OFFICIAL_THREE_PRONG_TEMPLATE.loops.some((loop) => !validatePolygon(
      { points: loop }, () => checkRuntime(deadline, checkpoint),
    ))) {
    throw new LauncherCompatibilityError('官方三爪孔模板無效，已停止所有輸出');
  }
  const candidates: ScoredFixedLauncherPlan[] = [];
  for (let step = 0; step < LAUNCHER_ROTATION_STEPS; step += 1) {
    checkRuntime(deadline, checkpoint);
    const rotationRad = step * Math.PI / 180;
    const loops = OFFICIAL_THREE_PRONG_TEMPLATE.loops.map(
      (loop) => rotateLoop(loop, rotationRad, request.axisPoint),
    ) as unknown as LauncherLoops;
    const planned = materializeFixedCuts(loops, request, fitOffsetMm, rotationRad);
    if (planned) candidates.push(planned);
  }
  const ranked = candidates.sort(compareLauncherPlacementScores);
  const selected = ranked.find((planned) => launcherCutsArePhysicallySafe({
    cuts: planned.cuts,
    top: { exterior: request.topExterior, centralHole: request.topCentralHole },
    second: { exterior: request.secondExterior, centralHole: request.secondCentralHole },
    material: request.material,
    deadline,
    checkpoint,
  }));
  if (!selected) throw new LauncherCompatibilityError(
    '官方三爪孔會破壞外框或必要承托結構，已停止所有輸出',
  );
  return withoutPrivatePlacementScore(selected);
}

export function planLauncherClearance(request: LauncherClearanceRequest): LauncherPlan {
  const deadline = request.deadline ?? Date.now() + 30_000;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  if (request.axisPoint.some((value) => !Number.isFinite(value))
    || !Number.isFinite(request.material.kerfMm) || request.material.kerfMm < 0
    || !Number.isFinite(request.material.minWebMm) || request.material.minWebMm < 0) {
    throw new RangeError('Launcher planning requires finite non-negative material geometry');
  }
  const selection = request.detection.status === 'detected'
    ? { status: 'detected' as const, loops: request.detection.loops }
    : { status: 'fallback' as const, loops: (request.fallback ?? KNIGHT_FORTRESS_LAUNCHER_TEMPLATE).loops };
  const guardedCheckpoint = (): void => {
    try {
      checkpoint();
    } catch (error) {
      throw new LauncherPlanningCheckpointInterruption(error);
    }
  };
  const kernelCheckpoint = (): void => checkRuntime(deadline, guardedCheckpoint);
  const finishedContours: FeatureContour[] = [];
  const cuts: FeatureContour[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      checkRuntime(deadline, guardedCheckpoint);
      const translated = translateLauncherLoop(
        selection.loops[index], request.axisPoint, deadline, guardedCheckpoint,
      );
      const finished = simpleMiterPolygonKernel.offset(
        { points: translated }, LAUNCHER_ASSEMBLY_ALLOWANCE_MM, kernelCheckpoint,
      );
      if (finished.length !== 1 || !validatePolygon(finished[0], kernelCheckpoint)) {
        throw new RangeError('Launcher finished opening must remain one simple loop');
      }
      const path = simpleMiterPolygonKernel.offset(finished[0], -request.material.kerfMm / 2, kernelCheckpoint);
      if (path.length !== 1 || !validatePolygon(path[0], kernelCheckpoint)) {
        throw new RangeError('Launcher toolpath must remain one simple loop');
      }
      const finishedOuter = finished[0].points;
      finishedContours.push({
        id: `launcher-finished-envelope-${index + 1}`,
        role: 'CUT_BLACK',
        outer: finishedOuter,
        boundsMm: contourBounds(finishedOuter, deadline, guardedCheckpoint),
        areaMm2: Math.abs(signedArea(finishedOuter, deadline, guardedCheckpoint)),
      });
      const pathOuter = path[0].points;
      const outer = signedArea(pathOuter, deadline, guardedCheckpoint) > 0
        ? pathOuter
        : pathOuter.map((_, pointIndex) => {
          if ((pointIndex & 63) === 0) guardedCheckpoint();
          return pathOuter[pathOuter.length - 1 - pointIndex];
        });
      cuts.push({
        id: `launcher-clearance-${index + 1}`,
        role: 'CUT_BLACK',
        outer,
        boundsMm: contourBounds(outer, deadline, guardedCheckpoint),
        areaMm2: Math.abs(signedArea(outer, deadline, guardedCheckpoint)),
      });
    }
  } catch (error) {
    if (error instanceof LauncherPlanningCheckpointInterruption) throw error.original;
    if (!(error instanceof RangeError)
      || /runtime budget/i.test(error.message)
      || !/^(?:Offset |Built-in offset|Launcher (?:finished opening|toolpath))/.test(error.message)) throw error;
    return { status: 'omitted', cuts: [], warning: LAUNCHER_OMISSION_WARNING };
  }
  const tuple = cuts as unknown as readonly [FeatureContour, FeatureContour, FeatureContour];
  const finishedTuple = finishedContours as unknown as readonly [FeatureContour, FeatureContour, FeatureContour];
  const top = { exterior: request.topExterior, centralHole: request.topCentralHole };
  const second = { exterior: request.secondExterior, centralHole: request.secondCentralHole };
  const clearances = finishedSafetyClearances(request.material);
  if (!finishedCutsAreSafe(finishedTuple, top, clearances, deadline, checkpoint)
    || !finishedCutsAreSafe(finishedTuple, second, clearances, deadline, checkpoint)) {
    return { status: 'omitted', cuts: [], warning: LAUNCHER_OMISSION_WARNING };
  }
  return { status: selection.status, cuts: tuple, assemblyAllowanceMm: LAUNCHER_ASSEMBLY_ALLOWANCE_MM };
}
