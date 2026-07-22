import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import { simplifyClosedLoop } from './simplify';

describe('simplifyClosedLoop cancellation', () => {
  it('propagates the original caller error from an inner simplification loop', () => {
    const points = Array.from({ length: 1_024 }, (_, index): Point2 => {
      const angle = index * Math.PI * 2 / 1_024;
      return [Math.cos(angle) * (10 + index % 2 * 0.01), Math.sin(angle) * (10 + index % 2 * 0.01)];
    });
    const cancellation = new Error('simplification cancelled');
    let calls = 0;
    let caught: unknown;
    try {
      simplifyClosedLoop(points, 0.001, 96, Infinity, () => {
        calls += 1;
        if (calls === 5) throw cancellation;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancellation);
    expect(calls).toBe(5);
  });
});
