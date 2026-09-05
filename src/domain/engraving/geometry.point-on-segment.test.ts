import { expect, test, vi } from 'vitest';
import type { Point2, Polygon2 } from '../decomposition/types';
import { pointLocation } from './geometry';

function baselineLengthTolerance(polygon: Polygon2): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, coordinate = 1;
  for (const [x, y] of polygon.points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    coordinate = Math.max(coordinate, Math.abs(x), Math.abs(y));
  }
  const scale = Math.max(Number.MIN_VALUE, maxX - minX, maxY - minY);
  return Math.max(Number.MIN_VALUE, scale * 128 * Number.EPSILON, coordinate * 32 * Number.EPSILON);
}

/** Independent copy of the pre-optimization public predicate, kept as the numerical oracle. */
function baselinePointLocation(polygon: Polygon2, point: Point2): -1 | 0 | 1 {
  const tolerance = baselineLengthTolerance(polygon);
  let inside = false;
  for (let index = 0, previous = polygon.points.length - 1; index < polygon.points.length; previous = index++) {
    const start = polygon.points[previous], end = polygon.points[index];
    const cross = (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
    const scale = Math.max(1, Math.hypot(end[0] - start[0], end[1] - start[1]));
    const onSegment = !(Math.abs(cross) > tolerance * scale)
      && point[0] >= Math.min(start[0], end[0]) - tolerance
      && point[0] <= Math.max(start[0], end[0]) + tolerance
      && point[1] >= Math.min(start[1], end[1]) - tolerance
      && point[1] <= Math.max(start[1], end[1]) + tolerance;
    if (onSegment) return 0;
    if ((start[1] > point[1]) !== (end[1] > point[1])) {
      const x = start[0] + (point[1] - start[1]) * (end[0] - start[0]) / (end[1] - start[1]);
      if (x > point[0]) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

test('point location matches the pre-optimization oracle at tolerance, overflow, and non-finite edges', () => {
  const cases: readonly [Polygon2, Point2][] = [
    [{ points: [[0, 0], [4, 0], [4, 4], [0, 4]] }, [2, 2]],
    [{ points: [[0, 0], [4, 0], [4, 4], [0, 4]] }, [4 + 128 * Number.EPSILON, 2]],
    [{ points: [[Number.MAX_VALUE, 0], [-Number.MAX_VALUE, 1], [0, 2]] }, [0, 1]],
    [{ points: [[0, 0], [Infinity, 0], [0, 1]] }, [2, 0]],
    [{ points: [[0, 0], [Number.NaN, 0], [0, 1]] }, [2, 0]],
    [{ points: [[0, 0], [1, 0], [0, 1]] }, [Infinity, 0]],
    [{ points: [[0, 0], [1, 0], [0, 1]] }, [Number.NaN, 0]],
  ];
  for (const [polygon, point] of cases) expect(pointLocation(polygon, point)).toBe(baselinePointLocation(polygon, point));
});

test('point location remains cancellable at the same edge checkpoint', () => {
  const polygon: Polygon2 = { points: Array.from({ length: 130 }, (_, index) => {
    const angle = index * Math.PI * 2 / 130;
    return [Math.cos(angle), Math.sin(angle)] as const;
  }) };
  const cancellation = new Error('cancel point scan');
  expect(() => pointLocation(polygon, [100, 100], (label) => {
    if (label === 'point-location:edge-scan') throw cancellation;
  })).toThrow(cancellation);
});

test('rejects points outside an edge AABB without computing its length', () => {
  const hypot = vi.spyOn(Math, 'hypot');
  try {
    expect(pointLocation({ points: [[0, 0], [2, 0], [0, 2]] }, [100, 100])).toBe(-1);
    expect(hypot).not.toHaveBeenCalled();
  } finally {
    hypot.mockRestore();
  }
});
