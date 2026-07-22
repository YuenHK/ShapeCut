import type { Point2 } from '../decomposition/types';
import { validatePolygon } from '../engraving/geometry';
import { simpleMiterPolygonKernel } from '../layout/polygon-kernel';
import type { ManufacturingGeometryProfile } from '../materials/manufacturing-profile';
import type { FeatureContour } from '../outline-features/types';

export const MAX_PHYSICAL_INTERNAL_CUTS = 7;

export type PhysicalCutProtection = {
  /** Material remaining between engraving and the exterior laser-removal edge. */
  readonly exteriorClearanceMm: number;
  /** Finished material-removal envelopes for every internal black cut. */
  readonly removalEnvelopes: readonly (readonly Point2[])[];
  /** Material remaining outside each finished internal removal envelope. */
  readonly requiredClearanceMm: number;
};

export type PhysicalCutProtectionRequest = {
  readonly centralHole?: FeatureContour;
  readonly launcherCuts: readonly FeatureContour[];
  readonly fastenerHoles: readonly FeatureContour[];
  readonly material: Pick<ManufacturingGeometryProfile, 'kerfMm' | 'minWebMm'>;
  readonly deadline?: number;
  readonly checkpoint?: (label?: string) => void;
};

function poll(deadline: number, checkpoint: (label?: string) => void): void {
  checkpoint('assembly:physical-cut-envelope-loop');
  if (Date.now() > deadline) {
    throw new RangeError('Physical cut envelope processing exceeded the runtime budget');
  }
}

export function finishedRemovalEnvelope(
  toolpath: readonly Point2[],
  kerfMm: number,
  deadline = Infinity,
  checkpoint: (label?: string) => void = () => undefined,
): readonly Point2[] {
  poll(deadline, checkpoint);
  if (!Number.isFinite(kerfMm) || kerfMm < 0 || toolpath.length < 3 || toolpath.length > 4_096) {
    throw new RangeError('Physical cut envelope requires bounded toolpath and finite non-negative kerf');
  }
  const guardedCheckpoint = (): void => poll(deadline, checkpoint);
  const envelopes = simpleMiterPolygonKernel.offset({ points: toolpath }, kerfMm / 2, guardedCheckpoint);
  if (envelopes.length !== 1 || !validatePolygon(envelopes[0], guardedCheckpoint)) {
    throw new RangeError('Physical cut toolpath must produce one finite simple removal envelope');
  }
  return envelopes[0].points;
}

export function createPhysicalCutProtection(request: PhysicalCutProtectionRequest): PhysicalCutProtection {
  const deadline = request.deadline ?? Infinity;
  const checkpoint = request.checkpoint ?? (() => undefined);
  poll(deadline, checkpoint);
  if (!Number.isFinite(request.material.kerfMm) || request.material.kerfMm < 0
    || !Number.isFinite(request.material.minWebMm) || request.material.minWebMm < 0) {
    throw new RangeError('Physical cut protection requires finite non-negative material geometry');
  }
  const cuts = [
    ...(request.centralHole ? [request.centralHole] : []),
    ...request.launcherCuts,
    ...request.fastenerHoles,
  ];
  if (cuts.length > MAX_PHYSICAL_INTERNAL_CUTS) {
    throw new RangeError('Physical cut protection exceeds the bounded internal-cut count');
  }
  const removalEnvelopes: (readonly Point2[])[] = [];
  for (const cut of cuts) {
    poll(deadline, checkpoint);
    removalEnvelopes.push(finishedRemovalEnvelope(cut.outer, request.material.kerfMm, deadline, checkpoint));
  }
  return {
    exteriorClearanceMm: request.material.kerfMm / 2 + request.material.minWebMm,
    removalEnvelopes,
    requiredClearanceMm: request.material.minWebMm,
  };
}
