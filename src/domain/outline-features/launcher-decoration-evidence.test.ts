import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { FeatureContour } from './types';
import { recomputeLauncherDecorationOverlap } from './launcher-decoration-evidence';

function regularContour(
  id: string,
  role: FeatureContour['role'],
  radius: number,
  pointCount: number,
): FeatureContour {
  const outer: Point2[] = Array.from({ length: pointCount }, (_, index) => {
    const angle = -index / pointCount * Math.PI * 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  return {
    id,
    role,
    outer,
    boundsMm: { minX: -radius, minY: -radius, maxX: radius, maxY: radius },
    areaMm2: Math.abs(outer.reduce((sum, point, index) => {
      const next = outer[(index + 1) % outer.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('internal launcher decoration overlap evidence', () => {
  it('stops a dense polygon operation at the absolute deadline instead of relying on its raw callback', () => {
    let checkpointCount = 0;
    const safetyAbort = new Error('dense operation escaped its deadline guard');
    vi.spyOn(Date, 'now').mockImplementation(() => checkpointCount >= 20 ? 101 : 99);
    const checkpoint = (): void => {
      checkpointCount += 1;
      if (checkpointCount >= 200) throw safetyAbort;
    };

    expect(() => recomputeLauncherDecorationOverlap({
      provisional: {
        red: [regularContour('dense-source', 'DEEP_RED', 1, 4_096)],
        blue: [],
      },
    }, {
      red: [],
      blue: [],
    }, [
      regularContour('dense-envelope', 'CUT_BLACK', 2, 4_096),
    ], 100, checkpoint)).toThrow(
      'Launcher decoration overlap recomputation exceeded the runtime budget',
    );
    expect(checkpointCount).toBeGreaterThanOrEqual(20);
    expect(checkpointCount).toBeLessThan(200);
  });

  it('propagates caller cancellation from a guarded geometry checkpoint by identity', () => {
    const cancellation = new Error('caller cancelled exact geometry work');
    let checkpointCount = 0;
    const checkpoint = (): void => {
      checkpointCount += 1;
      if (checkpointCount === 8) throw cancellation;
    };

    let caught: unknown;
    try {
      recomputeLauncherDecorationOverlap({
        provisional: {
          red: [regularContour('cancel-source', 'DEEP_RED', 1, 4_096)],
          blue: [],
        },
      }, {
        red: [],
        blue: [],
      }, [
        regularContour('cancel-envelope', 'CUT_BLACK', 2, 4_096),
      ], Infinity, checkpoint);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(cancellation);
    expect(checkpointCount).toBe(8);
  });
});
