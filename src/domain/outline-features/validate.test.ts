import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import { contourBounds, signedArea } from '../outline-2.5d/simplify';
import type { FeatureContour, FeatureRole } from './types';
import { validateDepthFeatureContours } from './validate';

function contour(id: string, role: FeatureRole, outer: readonly Point2[]): FeatureContour {
  return {
    id,
    role,
    outer,
    boundsMm: contourBounds(outer),
    areaMm2: Math.abs(signedArea(outer)),
  };
}

const exterior = [[-10, -10], [-10, 10], [10, 10], [10, -10]] as const;
const hole = [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const;
const red = contour('layer-0-deep', 'DEEP_RED', [[-8, -4], [-8, 4], [-3, 4], [-3, -4]]);
const blue = contour('layer-0-light', 'LIGHT_BLUE', [[3, -4], [3, 4], [8, 4], [8, -4]]);

describe('depth feature cross-role validation', () => {
  it('accepts up to twelve ordered contours per engraving role and rejects a thirteenth', () => {
    const deep = Array.from({ length: 12 }, (_, index) => contour(`deep-${index}`, 'DEEP_RED', [
      [-9 + index * 1.4, -1], [-9 + index * 1.4, 1],
      [-8 + index * 1.4, 1], [-8 + index * 1.4, -1],
    ]));

    expect(validateDepthFeatureContours({ exterior, red: deep, clearanceMm: 0.5 }))
      .toEqual({ ok: true, reasons: [] });
    expect(validateDepthFeatureContours({ exterior, red: [...deep, deep[0]], clearanceMm: 0.5 }).reasons.join('\n'))
      .toMatch(/12.*DEEP_RED/i);
  });

  it('accepts one finite, simple and separated contour per engraving role', () => {
    expect(validateDepthFeatureContours({ exterior, centralHole: hole, red, blue, clearanceMm: 0.5 }))
      .toEqual({ ok: true, reasons: [] });
  });

  it('rejects role overlap, exterior escape, and central-hole touching including containment', () => {
    const overlappingBlue = contour('overlap', 'LIGHT_BLUE', [[-4, -2], [-4, 2], [4, 2], [4, -2]]);
    const outsideRed = contour('outside', 'DEEP_RED', [[-11, -1], [-11, 1], [-8, 1], [-8, -1]]);
    const enclosingHole = contour('around-hole', 'DEEP_RED', [[-3, -3], [-3, 3], [3, 3], [3, -3]]);
    const touchingClearance = contour('touch-clearance', 'DEEP_RED', [[1.5, -0.5], [1.5, 0.5], [3, 0.5], [3, -0.5]]);

    expect(validateDepthFeatureContours({ exterior, centralHole: hole, red, blue: overlappingBlue, clearanceMm: 0.5 }).reasons.join('\n'))
      .toMatch(/overlap/i);
    expect(validateDepthFeatureContours({ exterior, centralHole: hole, red: outsideRed, clearanceMm: 0.5 }).reasons.join('\n'))
      .toMatch(/exterior/i);
    expect(validateDepthFeatureContours({ exterior, centralHole: hole, red: enclosingHole, clearanceMm: 0.5 }).reasons.join('\n'))
      .toMatch(/central hole/i);
    expect(validateDepthFeatureContours({ exterior, centralHole: hole, red: touchingClearance, clearanceMm: 0.5 }).reasons.join('\n'))
      .toMatch(/central hole/i);
  });

  it('rejects positive-area role overlap whose only boundary intersections are collinear', () => {
    const collinearRed = contour('collinear-red', 'DEEP_RED', [
      [-8, -4], [-8, 4], [2, 4], [2, -4],
    ]);
    const collinearBlue = contour('collinear-blue', 'LIGHT_BLUE', [
      [-2, -4], [-2, 4], [8, 4], [8, -4],
    ]);

    expect(validateDepthFeatureContours({
      exterior,
      red: collinearRed,
      blue: collinearBlue,
      clearanceMm: 0.5,
    }).reasons.join('\n')).toMatch(/overlap/i);
  });

  it('rejects recolored, self-intersecting, non-finite, and over-budget role geometry', () => {
    const recolored = { ...red, role: 'LIGHT_BLUE' as const };
    const bowTie = contour('bow-tie', 'DEEP_RED', [[-8, -3], [-3, 3], [-8, 3], [-3, -3]]);
    const nonFinite = { ...red, outer: [[NaN, 0], [-8, 4], [-3, 4], [-3, -4]] } as FeatureContour;
    const overBudget = contour('many', 'DEEP_RED', Array.from({ length: 4097 }, (_, index) => {
      const angle = index / 4097 * Math.PI * 2;
      return [-5 + Math.cos(angle), Math.sin(angle)] as const;
    }));

    for (const forged of [recolored, bowTie, nonFinite, overBudget]) {
      expect(validateDepthFeatureContours({ exterior, red: forged, clearanceMm: 0.5 }).ok).toBe(false);
    }
  });

  it('honors hard cancellation before geometry traversal', () => {
    const checkpoint = (): void => { throw new Error('cancelled'); };

    expect(() => validateDepthFeatureContours({ exterior, red, clearanceMm: 0.5, checkpoint }))
      .toThrow('cancelled');
  });
});
