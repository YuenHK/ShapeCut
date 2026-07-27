import { polygonsIntersectOrTouch, polygonsOverlapArea } from '../engraving/geometry';
import type { FeatureContour } from './types';

export const MAX_INTERNAL_PROVISIONAL_CONTOURS_PER_ROLE = 12;

export type LauncherDecorationOverlap = {
  readonly clipped: { readonly red: number; readonly blue: number };
  readonly removed: { readonly red: number; readonly blue: number };
};

export type InternalLauncherDecorationEvidence = {
  readonly provisional: {
    readonly red: readonly FeatureContour[];
    readonly blue: readonly FeatureContour[];
  };
  readonly protectedCutClearanceMm: number;
};

export function recomputeLauncherDecorationOverlap(
  evidence: Pick<InternalLauncherDecorationEvidence, 'provisional'>,
  retained: { readonly red: readonly FeatureContour[]; readonly blue: readonly FeatureContour[] },
  finishedLauncherEnvelopes: readonly FeatureContour[],
  deadline: number,
  checkpoint: () => void,
): LauncherDecorationOverlap {
  const guardedCheckpoint = (): void => {
    checkpoint();
    if (Date.now() > deadline) {
      throw new RangeError('Launcher decoration overlap recomputation exceeded the runtime budget');
    }
  };
  const result = {
    clipped: { red: 0, blue: 0 },
    removed: { red: 0, blue: 0 },
  };
  const classify = (
    sources: readonly FeatureContour[],
    remainders: readonly FeatureContour[],
    role: 'red' | 'blue',
  ): void => {
    if (sources.length > MAX_INTERNAL_PROVISIONAL_CONTOURS_PER_ROLE) {
      throw new RangeError('Internal provisional launcher decoration evidence exceeds the per-role bound');
    }
    for (const source of sources) {
      guardedCheckpoint();
      const overlapsLauncher = finishedLauncherEnvelopes.some((envelope) => polygonsIntersectOrTouch(
        { points: source.outer },
        { points: envelope.outer },
        guardedCheckpoint,
      ));
      if (!overlapsLauncher) continue;
      const survives = remainders.some((remainder) => polygonsOverlapArea(
        { points: source.outer },
        { points: remainder.outer },
        guardedCheckpoint,
      ));
      result[survives ? 'clipped' : 'removed'][role] += 1;
    }
  };
  classify(evidence.provisional.red, retained.red, 'red');
  classify(evidence.provisional.blue, retained.blue, 'blue');
  return result;
}

export function copyInternalLauncherDecorationEvidence(
  evidence: InternalLauncherDecorationEvidence,
): InternalLauncherDecorationEvidence {
  const copyContours = (contours: readonly FeatureContour[]): readonly FeatureContour[] => {
    if (contours.length > MAX_INTERNAL_PROVISIONAL_CONTOURS_PER_ROLE) {
      throw new RangeError('Internal provisional launcher decoration evidence exceeds the per-role bound');
    }
    return contours.map((contour) => ({
      id: contour.id,
      role: contour.role,
      outer: contour.outer.map(([x, y]) => [x, y] as const),
      boundsMm: { ...contour.boundsMm },
      areaMm2: contour.areaMm2,
    }));
  };
  return {
    provisional: {
      red: copyContours(evidence.provisional.red),
      blue: copyContours(evidence.provisional.blue),
    },
    protectedCutClearanceMm: evidence.protectedCutClearanceMm,
  };
}
