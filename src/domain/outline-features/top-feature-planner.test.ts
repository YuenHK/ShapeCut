import { describe, expect, it } from 'vitest';
import type { FeatureContour } from './types';
import { rankTopFeatures, type TopFeatureCandidate } from './top-feature-planner';

function candidate(id: string, areaMm2: number, contrastMm: number, ambiguity: number, minX: number, minY: number): TopFeatureCandidate {
  const contour: FeatureContour = {
    id,
    role: 'DEEP_RED',
    outer: [[minX, minY], [minX + 1, minY], [minX + 1, minY + 1], [minX, minY + 1]],
    boundsMm: { minX, minY, maxX: minX + 1, maxY: minY + 1 },
    areaMm2,
  };
  return { contour, contrastMm, ambiguity };
}

describe('top feature planner', () => {
  it('keeps the bounded deterministic area, contrast, ambiguity, and coordinate order', () => {
    const candidates = [
      candidate('later-coordinate', 9, 3, 0, 2, 0),
      candidate('higher-ambiguity', 9, 3, 1, 0, 0),
      candidate('lower-contrast', 9, 2, 0, 0, 0),
      candidate('largest', 10, 1, 9, 10, 10),
      candidate('first-coordinate', 9, 3, 0, -1, 1),
    ];

    expect(rankTopFeatures(candidates, 4, Infinity).map(({ contour }) => contour.id))
      .toEqual(['largest', 'first-coordinate', 'later-coordinate', 'higher-ambiguity']);
  });
});
