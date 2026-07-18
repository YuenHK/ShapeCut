import { describe, expect, test } from 'vitest';
import type { EngravingMap } from '../engraving/height-field';
import { symmetrizeEngraving } from '../engraving/symmetrize';
import { estimateBalance } from './balance';
import type { Polygon2 } from './types';

function rectangle(minX: number, minY: number, maxX: number, maxY: number): Polygon2 {
  return { points: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] };
}

function map(regions: EngravingMap['regions'], center: readonly [number, number] = [0, 0]): EngravingMap {
  return {
    levels: 4,
    regions,
    baseFootprint: regions.map(({ polygon }) => polygon),
    center,
    depthMode: 'relative',
    levelDepths: [0, 0.025, 0.05, 0.075, 0.1],
    assumptions: ['relative engraving depth only'],
  };
}

describe('estimateBalance', () => {
  test('computes area-and-depth-weighted centroid and blocks a one-sided removal', () => {
    const result = estimateBalance(map([{ level: 4, polygon: rectangle(9, -1, 11, 1) }]));
    expect(result).toMatchObject({
      kind: 'ideal-static-estimate',
      status: 'block',
      centroidOffsetMm: 10,
    });
    expect(result.angularMassError).toBeGreaterThan(0.9);
    expect(result.assumptions.join(' ')).toMatch(/static|ideal/i);
  });

  test('passes an eight-sector engraving with negligible ideal centroid offset', () => {
    const source = map([{ level: 4, polygon: rectangle(8, -0.2, 10, 0.2) }]);
    const symmetric = symmetrizeEngraving(source, { sectors: 8 });
    const result = estimateBalance(symmetric);
    expect(result.centroidOffsetMm).toBeLessThan(0.05);
    expect(result.angularMassError).toBeLessThan(0.01);
    expect(result.status).toBe('pass');
  });

  test('uses configured thresholds for confirm and reports relative-depth assumptions', () => {
    const asymmetric = map([
      { level: 4, polygon: rectangle(9, -1, 11, 1) },
      { level: 3, polygon: rectangle(-11, -1, -9, 1) },
    ]);
    const result = estimateBalance(asymmetric, {
      passCentroidOffsetMm: 0.05,
      blockCentroidOffsetMm: 2,
      passAngularMassError: 0.01,
      blockAngularMassError: 0.2,
    });
    expect(result.status).toBe('confirm');
    expect(result.centroidOffsetMm).toBeGreaterThan(0.1);
    expect(result.assumptions.join(' ')).toMatch(/relative/i);
  });

  test('uses the declared centre and handles zero removal deterministically', () => {
    const translated = map([
      { level: 4, polygon: rectangle(109, 99, 111, 101) },
      { level: 4, polygon: rectangle(89, 99, 91, 101) },
    ], [100, 100]);
    expect(estimateBalance(translated).centroidOffsetMm).toBeLessThan(1e-10);
    expect(estimateBalance(map([{ level: 0, polygon: rectangle(-1, -1, 1, 1) }]))).toMatchObject({
      status: 'pass', centroidOffsetMm: 0, angularMassError: 0,
    });
  });

  test('rejects duplicate/overlapping regions instead of silently double-counting mass', () => {
    const polygon = rectangle(-1, -1, 1, 1);
    expect(() => estimateBalance(map([
      { level: 4, polygon },
      { level: 4, polygon: { points: polygon.points.map(([x, y]) => [x, y] as const) } },
    ]))).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
    expect(() => estimateBalance(map([
      { level: 4, polygon: rectangle(0, 0, 2, 2) },
      { level: 2, polygon: rectangle(1, 1, 3, 3) },
    ]))).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
  });

  test('rejects invalid levels, non-finite coordinates, degenerate geometry, and thresholds', () => {
    expect(() => estimateBalance(map([{ level: 5, polygon: rectangle(0, 0, 1, 1) }]))).toThrowError(expect.objectContaining({ code: 'LEVELS' }));
    expect(() => estimateBalance(map([{ level: 1, polygon: { points: [[0, 0], [Number.NaN, 0], [0, 1]] } }]))).toThrowError(expect.objectContaining({ code: 'GEOMETRY' }));
    expect(() => estimateBalance(map([{ level: 1, polygon: { points: [[0, 0], [1, 0], [2, 0]] } }]))).toThrowError(expect.objectContaining({ code: 'GEOMETRY' }));
    expect(() => estimateBalance(map([]), { passCentroidOffsetMm: 2, blockCentroidOffsetMm: 1 })).toThrowError(expect.objectContaining({ code: 'THRESHOLDS' }));
  });

  test.each([1e-6, 1e6])('preserves balance classification across geometry scale %g with scaled thresholds', (scale) => {
    const scaled = map([
      { level: 4, polygon: rectangle(9 * scale, -scale, 11 * scale, scale) },
      { level: 4, polygon: rectangle(-11 * scale, -scale, -9 * scale, scale) },
    ]);
    const result = estimateBalance(scaled, {
      passCentroidOffsetMm: 0.05 * scale,
      blockCentroidOffsetMm: 0.25 * scale,
    });
    expect(result.status).toBe('pass');
    expect(result.centroidOffsetMm).toBeLessThan(1e-9 * Math.max(1, scale));
  });

  test('uses explicit base material to make finished COM shift scale with removed depth', () => {
    const physical = (depth: number): EngravingMap => ({
      levels: 4,
      regions: [{ level: 4, polygon: rectangle(9, -1, 11, 1) }],
      baseFootprint: [rectangle(9, -1, 11, 1)],
      center: [0, 0],
      depthMode: 'millimetres',
      levelDepths: [0, depth / 4, depth / 2, depth * 3 / 4, depth],
      sheetThicknessMm: 1,
      assumptions: ['calibrated physical depths'],
    });
    const base = { footprint: [rectangle(-50, -50, 50, 50)], thicknessMm: 1 };
    const shallow = estimateBalance(physical(1e-9), { base });
    const deep = estimateBalance(physical(0.4), { base });
    expect(shallow.centroidOffsetMm).toBeLessThan(1e-8);
    expect(deep.centroidOffsetMm).toBeGreaterThan(shallow.centroidOffsetMm * 1e6);
    expect(deep.centroidOffsetMm).toBeCloseTo(16 / 9_998.4, 10);
  });

  test('rejects numeric overflow instead of returning NaN or a false status', () => {
    const huge: EngravingMap = {
      levels: 4,
      regions: [{ level: 4, polygon: rectangle(0, 0, 1e150, 1e150) }],
      baseFootprint: [rectangle(0, 0, 1e150, 1e150)],
      center: [0, 0],
      depthMode: 'millimetres',
      levelDepths: [0, 1e99, 2e99, 5e99, 1e100],
      sheetThicknessMm: 1e101,
      assumptions: [],
    };
    expect(() => estimateBalance(huge, {
      base: { footprint: [rectangle(0, 0, 1e150, 1e150)], thicknessMm: 1e101 },
    })).toThrowError(expect.objectContaining({ code: 'NUMERIC' }));
  });

  test('rejects coordinates whose ULP is too coarse for the requested balance threshold', () => {
    const center = [805_349_204_987_020.9, -302_628_492_321_360.4] as const;
    const source = map([{ level: 4, polygon: rectangle(center[0] + 80, center[1] - 5, center[0] + 120, center[1] + 5) }], center);
    expect(() => estimateBalance(symmetrizeEngraving(source, { sectors: 8, center }))).toThrowError(expect.objectContaining({ code: 'NUMERIC' }));
  });

  test('returns a typed error for null options', () => {
    expect(() => estimateBalance(map([{ level: 0, polygon: rectangle(-1, -1, 1, 1) }]), null as never)).toThrowError(expect.objectContaining({ code: 'THRESHOLDS' }));
  });

  test('rejects engraving outside the supplied base footprint instead of cancelling real imbalance', () => {
    const outside = map([{ level: 4, polygon: rectangle(99.5, -0.5, 100.5, 0.5) }]);
    const base = { footprint: [rectangle(-4, -5, 6, 5)], thicknessMm: 1 };
    expect(() => estimateBalance(outside, { base })).toThrowError(expect.objectContaining({ code: 'FOOTPRINT' }));
    const noRemoval = map([]);
    expect(estimateBalance(noRemoval, { base }).centroidOffsetMm).toBeCloseTo(1, 12);
    expect(estimateBalance(noRemoval, { base }).status).toBe('block');
  });

  test('normalizes angular error with the exact remaining polar second moment', () => {
    const removal = rectangle(3.5, -0.5, 4.5, 0.5);
    const physical: EngravingMap = {
      levels: 4,
      regions: [{ level: 4, polygon: removal }],
      baseFootprint: [removal],
      center: [0, 0],
      depthMode: 'millimetres',
      levelDepths: [0, 0.25, 0.5, 0.75, 1],
      sheetThicknessMm: 2,
      assumptions: [],
    };
    const result = estimateBalance(physical, {
      base: { footprint: [rectangle(-5, -5, 5, 5)], thicknessMm: 2 },
      passAngularMassError: 0.004,
      blockAngularMassError: 0.01,
    });
    const expectedOffset = 4 / 199;
    const expectedRmsRadius = Math.sqrt((10_000 / 3 - (16 + 1 / 6)) / 199);
    expect(result.centroidOffsetMm).toBeCloseTo(expectedOffset, 12);
    expect(result.angularMassError).toBeCloseTo(expectedOffset / expectedRmsRadius, 12);
    expect(result.status).toBe('confirm');
  });
});
