import { describe, expect, test } from 'vitest';
import { markLineSupercover } from './raster';

function occupied(mask: Uint8Array, width: number): string[] {
  return Array.from(mask.entries())
    .filter(([, value]) => value !== 0)
    .map(([index]) => `${index % width},${Math.floor(index / width)}`);
}

function componentCount(mask: Uint8Array, width: number, height: number): number {
  const visited = new Uint8Array(mask.length);
  let count = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    count += 1;
    const queue = [start];
    visited[start] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head], x = current % width, y = Math.floor(current / width);
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) if (next >= 0 && mask[next] && !visited[next]) {
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  return count;
}

describe('markLineSupercover', () => {
  test('marks exactly the cells intersected by an edge away from grid boundaries', () => {
    const mask = new Uint8Array(5 * 4);
    markLineSupercover(mask, 5, 4, 0.25, 1.25, 2.75, 1.25, Infinity);
    expect(occupied(mask, 5)).toEqual(['0,1', '1,1', '2,1']);
  });

  test('conservatively marks both sides of an edge on a cell boundary without bounds expansion', () => {
    const mask = new Uint8Array(5 * 4);
    markLineSupercover(mask, 5, 4, 0.25, 1, 2.75, 1, Infinity);
    expect(occupied(mask, 5)).toEqual(['0,0', '1,0', '2,0', '0,1', '1,1', '2,1']);
  });

  test('does not bridge geometrically separated edge components', () => {
    const width = 5, height = 5, mask = new Uint8Array(width * height);
    markLineSupercover(mask, width, height, 0.25, 1.25, 2.75, 1.25, Infinity);
    markLineSupercover(mask, width, height, 0.25, 3.25, 2.75, 3.25, Infinity);
    expect(componentCount(mask, width, height)).toBe(2);
    expect(occupied(mask, width).some((cell) => cell.endsWith(',2'))).toBe(false);
  });
});
