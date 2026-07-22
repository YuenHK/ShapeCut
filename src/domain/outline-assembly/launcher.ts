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
  type LauncherLoops,
  type LauncherTemplate,
} from './launcher-template';

export const LAUNCHER_ASSEMBLY_ALLOWANCE_MM = 0.2 as const;
export const LAUNCHER_OMISSION_WARNING = '無法安全保留原裝發射器相容性，已省略三個發射器開孔';

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

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Launcher detection exceeded the runtime budget');
}

function polygonCentroid(points: readonly Point2[]): Point2 {
  const area = signedArea(points);
  let x = 0, y = 0;
  for (let index = 0; index < points.length; index += 1) {
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
  if (!Number.isFinite(candidate.evidenceStrength) || candidate.evidenceStrength < 0 || candidate.evidenceStrength > 1
    || candidate.loops.length !== 3) return undefined;
  for (const loop of candidate.loops) {
    checkRuntime(deadline, checkpoint);
    let simple = validity.get(loop.outer);
    if (simple === undefined) {
      simple = loop.outer.length <= LAUNCHER_TEMPLATE_MAX_POINTS
        && validatePolygon({ points: loop.outer }, () => checkRuntime(deadline, checkpoint));
      validity.set(loop.outer, simple);
    }
    if (!loop.closed || !Number.isFinite(loop.support) || loop.support < 0 || loop.support > 1
      || !simple) return undefined;
  }
  const centers = candidate.loops.map(({ outer }) => polygonCentroid(outer));
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
  return support - centeredError * 2 - symmetryError * 0.1 - radialSpread;
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
    if (score === undefined) continue;
    if (!selected || score > selected.score + 1e-12) selected = { score, index };
  }
  if (!selected) return { status: 'omitted', reason: 'No reliable three-hook launcher evidence' };
  const source = request.candidates[selected.index].loops.map(({ outer }) => outer.map(([x, y]): Point2 => [
    x - request.axisPoint[0], y - request.axisPoint[1],
  ]));
  return {
    status: 'detected',
    loops: normalizeLauncherLoops(source, deadline, checkpoint),
    score: selected.score,
    sourceCandidateIndex: selected.index,
  };
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

function cutsAreSafe(
  cuts: readonly FeatureContour[],
  layer: LauncherPlanningLayer,
  minimumWebMm: number,
  deadline: number,
  checkpoint: () => void,
): boolean {
  for (let index = 0; index < cuts.length; index += 1) {
    checkRuntime(deadline, checkpoint);
    const cut = cuts[index];
    if (!isStrictlyContainedLoop(layer.exterior.outer, cut.outer, minimumWebMm, deadline, checkpoint)) return false;
    if (layer.centralHole && (polygonsIntersectOrTouch(
      { points: cut.outer }, { points: layer.centralHole.outer }, () => checkRuntime(deadline, checkpoint),
    ) || boundaryDistance(cut.outer, layer.centralHole.outer, deadline, checkpoint) + 1e-12 < minimumWebMm)) return false;
    for (let other = 0; other < index; other += 1) {
      if (polygonsIntersectOrTouch(
        { points: cut.outer }, { points: cuts[other].outer }, () => checkRuntime(deadline, checkpoint),
      ) || boundaryDistance(cut.outer, cuts[other].outer, deadline, checkpoint) + 1e-12 < minimumWebMm) return false;
    }
  }
  return true;
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
  const radialOffsetMm = LAUNCHER_ASSEMBLY_ALLOWANCE_MM - request.material.kerfMm / 2;
  const cuts: FeatureContour[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      checkRuntime(deadline, checkpoint);
      const translated = selection.loops[index].map(([x, y]): Point2 => [x + request.axisPoint[0], y + request.axisPoint[1]]);
      const offset = simpleMiterPolygonKernel.offset({ points: translated }, radialOffsetMm);
      if (offset.length !== 1 || !validatePolygon(offset[0], () => checkRuntime(deadline, checkpoint))) {
        throw new RangeError('Launcher offset must remain one simple loop');
      }
      const outer = offset[0].points;
      cuts.push({
        id: `launcher-clearance-${index + 1}`,
        role: 'CUT_BLACK',
        outer,
        boundsMm: contourBounds(outer, deadline, checkpoint),
        areaMm2: Math.abs(signedArea(outer, deadline, checkpoint)),
      });
    }
  } catch (error) {
    if (error instanceof RangeError && /runtime budget/i.test(error.message)) throw error;
    return { status: 'omitted', cuts: [], warning: LAUNCHER_OMISSION_WARNING };
  }
  const tuple = cuts as unknown as readonly [FeatureContour, FeatureContour, FeatureContour];
  const top = { exterior: request.topExterior, centralHole: request.topCentralHole };
  const second = { exterior: request.secondExterior, centralHole: request.secondCentralHole };
  if (!cutsAreSafe(tuple, top, request.material.minWebMm, deadline, checkpoint)
    || !cutsAreSafe(tuple, second, request.material.minWebMm, deadline, checkpoint)) {
    return { status: 'omitted', cuts: [], warning: LAUNCHER_OMISSION_WARNING };
  }
  return { status: selection.status, cuts: tuple, assemblyAllowanceMm: LAUNCHER_ASSEMBLY_ALLOWANCE_MM };
}
