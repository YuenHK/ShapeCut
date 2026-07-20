import { describe, expect, test } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { OutlineLayer } from './extract';
import { validateOutlineLayer } from './validate';

function layer(outer: readonly Point2[], overrides: Partial<OutlineLayer> = {}): OutlineLayer {
  return {
    id: 'layer-0',
    index: 0,
    zStart: 0,
    zEnd: 1,
    contour: { outer, holes: [] },
    sourceAreaMm2: 1,
    simplifiedAreaMm2: 1,
    sourceBoundsMm: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    removedComponentCount: 0,
    ...overrides,
  };
}

const square = [[0, 0], [0, 1], [1, 1], [1, 0]] as const;

describe('validateOutlineLayer', () => {
  test('rejects forged removed-component evidence', () => {
    expect(validateOutlineLayer(layer(square, { removedComponentCount: -1 })).ok).toBe(false);
    expect(validateOutlineLayer(layer(square, { removedComponentCount: 1.5 })).ok).toBe(false);
  });
  test('accepts a finite clockwise simple contour', () => {
    expect(validateOutlineLayer(layer(square))).toEqual({ ok: true, reasons: [] });
  });

  test.each([
    ['non-finite coordinates', layer([[0, 0], [0, 1], [Number.NaN, 0]])],
    ['empty contours', layer([])],
    ['adjacent duplicate points', layer([[0, 0], [0, 1], [0, 1], [1, 0]])],
    ['bow-tie contours', layer([[0, 0], [1, 1], [0, 1], [1, 0]])],
    ['invalid layer intervals', layer(square, { zStart: 2, zEnd: 1 })],
    ['non-positive source area', layer(square, { sourceAreaMm2: 0 })],
    ['area drift over three percent', layer(square, { sourceAreaMm2: 1, simplifiedAreaMm2: 0.96 })],
    ['simplified-area metadata inconsistent with geometry', layer(square, { simplifiedAreaMm2: 0.99 })],
    ['source bounds drift over three percent', layer(square, {
      sourceBoundsMm: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
    })],
    ['invalid source bounds', layer(square, {
      sourceBoundsMm: { minX: 1, minY: 0, maxX: 0, maxY: 1 },
    })],
    ['more than 4096 points', layer(Array.from({ length: 4097 }, (_, index) => {
      const angle = -index * Math.PI * 2 / 4097;
      return [Math.cos(angle), Math.sin(angle)] as const;
    }))],
  ])('rejects %s', (_name, candidate) => {
    const result = validateOutlineLayer(candidate);
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test('fails closed when the validation deadline is exhausted', () => {
    const result = validateOutlineLayer(layer(square), 0);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('Contour validation exceeded the runtime budget');
  });
});
