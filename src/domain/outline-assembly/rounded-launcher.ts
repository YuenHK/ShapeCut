import type { Point2 } from '../decomposition/types';

/** Fitted to the retained Knight Fortress v1 contours, NOT manufacturer CAD.
 * Source notches are intentionally removed. Physical coupon calibration is required.
 */
export const ROUNDED_LAUNCHER_PROFILE = Object.freeze({
  centerRadiusMm: 21.5,
  halfWidthMm: 1.41,
  halfSpanDegrees: 54.6,
  phaseDegrees: 0.2,
  arcSegments: 36,
  capSegments: 12,
});

export function roundedLauncherLoops(): readonly [readonly Point2[], readonly Point2[], readonly Point2[]] {
  const { centerRadiusMm: radius, halfWidthMm: halfWidth, arcSegments, capSegments } = ROUNDED_LAUNCHER_PROFILE;
  const halfSpan = ROUNDED_LAUNCHER_PROFILE.halfSpanDegrees * Math.PI / 180;
  const base: Point2[] = [];
  const arc = (r: number, start: number, end: number): void => {
    for (let index = 0; index < arcSegments; index += 1) {
      const angle = start + (end - start) * index / arcSegments;
      base.push([r * Math.cos(angle), r * Math.sin(angle)]);
    }
  };
  const cap = (centerAngle: number, startAngle: number): void => {
    for (let index = 0; index < capSegments; index += 1) {
      const angle = startAngle + Math.PI * index / capSegments;
      base.push([
        radius * Math.cos(centerAngle) + halfWidth * Math.cos(angle),
        radius * Math.sin(centerAngle) + halfWidth * Math.sin(angle),
      ]);
    }
  };
  arc(radius + halfWidth, -halfSpan, halfSpan);
  cap(halfSpan, halfSpan);
  arc(radius - halfWidth, halfSpan, -halfSpan);
  cap(-halfSpan, Math.PI - halfSpan);
  base.reverse(); // Internal cut winding matches the original clockwise template.
  const loop = (index: number): readonly Point2[] => {
    const angle = (ROUNDED_LAUNCHER_PROFILE.phaseDegrees + index * 120) * Math.PI / 180;
    return Object.freeze(base.map(([x, y]): Point2 => Object.freeze([
      Math.round((x * Math.cos(angle) - y * Math.sin(angle)) * 1e9) / 1e9,
      Math.round((x * Math.sin(angle) + y * Math.cos(angle)) * 1e9) / 1e9,
    ])));
  };
  return Object.freeze([loop(0), loop(1), loop(2)]);
}
