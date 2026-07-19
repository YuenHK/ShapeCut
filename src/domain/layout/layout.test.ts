import { describe, expect, it } from 'vitest';
import type { Part2D, Polygon2 } from '../decomposition/types';
import { applyKerf } from './kerf';
import { nestParts } from './nest';
import { simpleMiterPolygonKernel, type PolygonKernel } from './polygon-kernel';

function area(polygon: Polygon2): number {
  return Math.abs(polygon.points.reduce((sum, point, index) => {
    const next = polygon.points[(index + 1) % polygon.points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
}

const square = (size: number): Polygon2 => ({ points: [[0, 0], [size, 0], [size, size], [0, size]] });
const part: Part2D = { id: 'plate', kind: 'hub-layer', outline: square(20), holes: [{ points: [...square(6).points].reverse() }], quantity: 1 };

describe('kerf compensation', () => {
  it('offsets outlines and holes in opposite directions', () => {
    const kernel: PolygonKernel = {
      offset: (polygon, mm) => {
        const center = polygon.points.reduce(([x, y], [px, py]) => [x + px / polygon.points.length, y + py / polygon.points.length], [0, 0]);
        return [{ points: polygon.points.map(([x, y]) => [x + Math.sign(x - center[0]) * mm, y + Math.sign(y - center[1]) * mm]) }];
      },
      intersects: () => false,
    };
    const result = applyKerf(part, 0.2, kernel);
    expect(area(result.outline)).toBeGreaterThan(area(part.outline));
    expect(area(result.holes[0])).toBeLessThan(area(part.holes[0]));
  });

  it('rejects invalid kerf and split offset results', () => {
    expect(() => applyKerf(part, -0.1)).toThrow(/kerf/i);
    const split: PolygonKernel = { offset: () => [square(2), square(3)], intersects: () => false };
    expect(() => applyKerf(part, 0.2, split)).toThrow(/single/i);
  });

  it('fails closed on concave geometry until a vetted polygon kernel is supplied', () => {
    const concave: Part2D = { ...part, outline: { points: [[0, 0], [10, 0], [5, 4], [10, 10], [0, 10]] }, holes: [] };
    expect(() => applyKerf(concave, 0.2)).toThrow(/convex/i);
  });

  it('offsets validated simple concave manufacturing outlines with the explicit miter kernel', () => {
    const concave: Part2D = { ...part, outline: { points: [[0, 0], [10, 0], [10, 3], [6, 3], [6, 7], [10, 7], [10, 10], [0, 10]] }, holes: [] };

    const result = applyKerf(concave, 0.2, simpleMiterPolygonKernel);

    expect(area(result.outline)).toBeGreaterThan(area(concave.outline));
  });
});

describe('deterministic nesting', () => {
  it('places larger parts first without overlap and repeats deterministically', () => {
    const parts: Part2D[] = [
      { ...part, id: 'small', outline: square(10), holes: [] },
      { ...part, id: 'large', outline: square(20), holes: [] },
    ];
    const first = nestParts(parts, { widthMm: 50, heightMm: 30, spacingMm: 2 });
    expect(first).toEqual(nestParts(parts, { widthMm: 50, heightMm: 30, spacingMm: 2 }));
    expect(first.sheets[0].placements.map(({ partId }) => partId)).toEqual(['large', 'small']);
  });

  it('rejects non-finite geometry and unreasonable quantities before layout', () => {
    expect(() => nestParts([{ ...part, outline: { points: [[0, 0], [Number.NaN, 0], [0, 1]] } }], { widthMm: 50, heightMm: 30, spacingMm: 2 })).toThrow(/geometry/i);
    expect(() => nestParts([{ ...part, quantity: 100_001 }], { widthMm: 50, heightMm: 30, spacingMm: 2 })).toThrow(/quantity/i);
  });
});
