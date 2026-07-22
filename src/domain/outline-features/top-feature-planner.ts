import type { FeatureContour } from './types';

export type TopFeatureCandidate = {
  readonly contour: FeatureContour;
  /** Larger depth range is a stronger engraving signal. */
  readonly contrastMm: number;
  /** Smaller values are less ambiguous. */
  readonly ambiguity: number;
};

/**
 * Produces a stable bounded order for independently traced top-layer marks.
 * Geometry strength wins first; coordinates and IDs make equal evidence reproducible.
 */
export function rankTopFeatures<T extends TopFeatureCandidate>(
  candidates: readonly T[],
  limit: number,
  deadline = Infinity,
): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12) {
    throw new RangeError('Top feature ranking requires a limit from 1 through 12');
  }
  if (candidates.length > 64) throw new RangeError('Top feature ranking exceeds the 64-candidate bound');
  const ranked = [...candidates];
  let comparisons = 0;
  ranked.sort((left, right) => {
    if ((comparisons++ & 63) === 0 && Date.now() > deadline) {
      throw new RangeError('Top feature ranking exceeded the runtime budget');
    }
    return right.contour.areaMm2 - left.contour.areaMm2
      || right.contrastMm - left.contrastMm
      || left.ambiguity - right.ambiguity
      || left.contour.boundsMm.minX - right.contour.boundsMm.minX
      || left.contour.boundsMm.minY - right.contour.boundsMm.minY
      || (left.contour.id < right.contour.id ? -1 : left.contour.id > right.contour.id ? 1 : 0);
  });
  if (Date.now() > deadline) throw new RangeError('Top feature ranking exceeded the runtime budget');
  return ranked.slice(0, limit);
}
