import { describe, expect, test } from 'vitest';
import type { Point2, Polygon2 } from '../decomposition/types';
import { estimateBalance } from '../decomposition/balance';
import { cloneEngravingMap, levelAt, type EngravingMap, type HeightField } from './height-field';
import { quantizeHeightField } from './quantize';
import { applyProtectedZones } from './protected-zones';
import { symmetrizeEngraving } from './symmetrize';
import { canonicalPolygonKey, polygonIntersectionArea, polygonsOverlapArea } from './geometry';

function rectangle(minX: number, minY: number, maxX: number, maxY: number): Polygon2 {
  return { points: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] };
}

function regularPolygon(centerX: number, centerY: number, radius: number, vertices: number): Polygon2 {
  return { points: Array.from({ length: vertices }, (_, index) => {
    const angle = index * Math.PI * 2 / vertices;
    return [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)] as const;
  }) };
}

function field(heights: readonly number[]): HeightField {
  return {
    cells: heights.map((heightMm, index) => ({
      heightMm,
      polygon: rectangle(index * 3, 0, index * 3 + 2, 2),
    })),
  };
}

function plainMap(regions: EngravingMap['regions'], center: readonly [number, number] = [0, 0]): EngravingMap {
  return {
    levels: 4,
    regions,
    baseFootprint: regions.map(({ polygon }) => polygon),
    center,
    depthMode: 'relative',
    levelDepths: [0, 0.25, 0.5, 0.75, 1],
    assumptions: ['relative engraving depth only'],
  };
}

describe('quantizeHeightField', () => {
  test.each([3, 4, 5] as const)('supports exactly %i engraving levels with level zero reserved', (levels) => {
    const map = quantizeHeightField(field([0, 0.5, 1]), levels);
    expect(map.levels).toBe(levels);
    expect(map.regions.map(({ level }) => level)).toEqual([levels, Math.ceil(levels / 2), 0]);
    expect(map.levelDepths).toHaveLength(levels + 1);
    expect(map.levelDepths[0]).toBe(0);
  });

  test.each([0, 1, 2, 6, 3.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsupported level count %s', (levels) => {
    expect(() => quantizeHeightField(field([0, 1]), levels as 3)).toThrowError(expect.objectContaining({ code: 'LEVELS' }));
  });

  test('uses explicit millimetre depths and enforces safe remaining thickness at the boundary', () => {
    const safe = quantizeHeightField(field([0, 1]), 4, {
      levelDepthsMm: [0, 0.1, 0.2, 0.3, 0.4],
      sheetThicknessMm: 1,
      safeRemainingThicknessMm: 0.6,
    });
    expect(safe.depthMode).toBe('millimetres');
    expect(safe.levelDepths).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(() => quantizeHeightField(field([0, 1]), 4, {
      levelDepthsMm: [0, 0.1, 0.2, 0.3, 0.400_000_001],
      sheetThicknessMm: 1,
      safeRemainingThicknessMm: 0.6,
    })).toThrowError(expect.objectContaining({ code: 'SAFETY' }));
  });

  test('rejects partial material data, non-finite heights, degenerate polygons, and overlapping cells', () => {
    expect(() => quantizeHeightField(field([0, 1]), 4, { sheetThicknessMm: 3 })).toThrowError(expect.objectContaining({ code: 'SAFETY' }));
    expect(() => quantizeHeightField(field([0, Number.NaN]), 4)).toThrowError(expect.objectContaining({ code: 'HEIGHT_FIELD' }));
    expect(() => quantizeHeightField({ cells: [{ heightMm: 1, polygon: { points: [[0, 0], [1, 0], [2, 0]] } }] }, 4)).toThrowError(expect.objectContaining({ code: 'GEOMETRY' }));
    expect(() => quantizeHeightField({ cells: [
      { heightMm: 0, polygon: rectangle(0, 0, 2, 2) },
      { heightMm: 1, polygon: rectangle(1, 1, 3, 3) },
    ] }, 4)).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
  });

  test('returns serializable data and keeps point lookup as a helper', () => {
    const map = quantizeHeightField(field([0, 1]), 4);
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
    expect('levelAt' in map).toBe(false);
    expect(levelAt(map, [1, 1])).toBe(4);
    expect(levelAt(map, [100, 100])).toBe(0);
  });

  test('normalizes extreme finite heights without producing NaN levels', () => {
    const map = quantizeHeightField(field([-Number.MAX_VALUE, Number.MAX_VALUE]), 4);
    expect(map.regions.map(({ level }) => level)).toEqual([4, 0]);
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });

  test('detects containment overlap across extreme polygon scale differences', () => {
    expect(() => quantizeHeightField({ cells: [
      { heightMm: 0, polygon: rectangle(-50_000_000, -50_000_000, 50_000_000, 50_000_000) },
      { heightMm: 1, polygon: rectangle(0, 0, 1, 1) },
    ] }, 4)).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
  });

  test('never treats an accepted ultra-thin duplicate polygon as overlap noise', () => {
    const thin: Polygon2 = { points: [[0, 0], [1, 0], [0, 8e-14]] };
    expect(() => quantizeHeightField({ cells: [
      { heightMm: 0, polygon: thin },
      { heightMm: 1, polygon: { points: thin.points.map(([x, y]) => [x, y] as const) } },
    ] }, 4)).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
  });

  test('returns typed errors for null options and sparse runtime arrays', () => {
    expect(() => quantizeHeightField(field([0, 1]), 4, null as never)).toThrowError(expect.objectContaining({ code: 'SAFETY' }));
    const sparseDepths = Array<number>(5);
    sparseDepths[0] = 0; sparseDepths[1] = 0.1; sparseDepths[2] = 0.2; sparseDepths[3] = 0.3;
    expect(() => quantizeHeightField(field([0, 1]), 4, {
      levelDepthsMm: sparseDepths, sheetThicknessMm: 1, safeRemainingThicknessMm: 0.5,
    })).toThrowError(expect.objectContaining({ code: 'SAFETY' }));
    const sparseCenter = Array<number>(2) as unknown as readonly [number, number];
    expect(() => quantizeHeightField(field([0, 1]), 4, { center: sparseCenter })).toThrowError(expect.objectContaining({ code: 'GEOMETRY' }));
    const sparsePoints = Array<readonly [number, number]>(3);
    sparsePoints[0] = [0, 0]; sparsePoints[2] = [1, 1];
    expect(() => quantizeHeightField({ cells: [{ heightMm: 0, polygon: { points: sparsePoints } }] }, 4)).toThrowError(expect.objectContaining({ code: 'GEOMETRY' }));
  });

  test('does not mistake a concave polygon centroid in its notch for material overlap', () => {
    const uShape: Polygon2 = { points: [[-3, -3], [3, -3], [3, 3], [1, 3], [1, -1], [-1, -1], [-1, 3], [-3, 3]] };
    const gap = rectangle(-0.2, -0.5, 0.2, -0.1);
    const map = quantizeHeightField({ cells: [
      { heightMm: 0, polygon: uShape },
      { heightMm: 1, polygon: gap },
    ] }, 4);
    expect(map.regions).toHaveLength(2);
    const protectedMap = applyProtectedZones(plainMap([{ level: 4, polygon: uShape }]), [{ kind: 'joint', polygon: gap, maxLevel: 0 }]);
    expect(levelAt(protectedMap, [2, 0])).toBe(4);
  });
});

describe('protected engraving zones', () => {
  test('conservatively lowers an intersecting cell without mutating the source map', () => {
    const source = plainMap([{ level: 4, polygon: rectangle(-2, -2, 2, 2) }]);
    const safe = applyProtectedZones(source, [{ kind: 'joint', polygon: rectangle(-0.2, -0.2, 0.2, 0.2), maxLevel: 0 }]);
    expect(levelAt(safe, [0, 0])).toBe(0);
    expect(levelAt(safe, [1, 1])).toBe(0);
    expect(levelAt(source, [1, 1])).toBe(4);
    expect(safe.regions[0]).not.toBe(source.regions[0]);
  });

  test('supports a material-approved shallow level and validates protected geometry', () => {
    const source = plainMap([{ level: 4, polygon: rectangle(-2, -2, 2, 2) }]);
    const safe = applyProtectedZones(source, [{ kind: 'load-bearing', polygon: rectangle(-1, -1, 1, 1), maxLevel: 1 }]);
    expect(levelAt(safe, [0, 0])).toBe(1);
    expect(() => applyProtectedZones(source, [{ kind: 'shaft', polygon: { points: [[0, 0], [1, 0], [2, 0]] }, maxLevel: 0 }])).toThrowError(expect.objectContaining({ code: 'GEOMETRY' }));
    expect(() => applyProtectedZones(source, [{ kind: 'joint', polygon: rectangle(0, 0, 1, 1), maxLevel: 2 } as never])).toThrowError(expect.objectContaining({ code: 'PROTECTED_LEVEL' }));
  });

  test('keeps a joint unengraved through eight-sector symmetry and preserves ideal balance', () => {
    const joint = rectangle(11, -0.1, 12, 0.1);
    const quantized = quantizeHeightField({ cells: [
      { heightMm: 0.5, polygon: rectangle(8, -0.1, 10, 0.1) },
      { heightMm: 0, polygon: joint },
      { heightMm: 1, polygon: rectangle(6, -0.1, 7, 0.1) },
    ] }, 4);
    expect(levelAt(quantized, [11.5, 0])).toBe(4);
    const safe = applyProtectedZones(quantized, [{ kind: 'joint', polygon: joint, maxLevel: 0 }]);
    const symmetric = symmetrizeEngraving(safe, { sectors: 8 });
    expect(levelAt(symmetric, [11.5, 0])).toBe(0);
    expect(estimateBalance(symmetric).centroidOffsetMm).toBeLessThan(0.05);
  });

  test('rejects duplicate and partial-overlap runtime maps at every public transform boundary', () => {
    const duplicatePolygon = rectangle(-1, -1, 1, 1);
    const duplicate: EngravingMap = {
      ...plainMap([
        { level: 2, polygon: duplicatePolygon },
        { level: 2, polygon: { points: duplicatePolygon.points.map(([x, y]) => [x, y] as const) } },
      ]),
      baseFootprint: [rectangle(-2, -2, 2, 2)],
    };
    const partial: EngravingMap = {
      ...plainMap([
        { level: 2, polygon: rectangle(-2, -1, 0.5, 1) },
        { level: 3, polygon: rectangle(-0.5, -1, 2, 1) },
      ]),
      baseFootprint: [rectangle(-3, -2, 3, 2)],
    };
    for (const invalid of [duplicate, partial]) {
      expect(() => applyProtectedZones(invalid, [])).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
      expect(() => symmetrizeEngraving(invalid, { sectors: 2 })).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
      expect(() => cloneEngravingMap(invalid)).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
      expect(() => levelAt(invalid, [0, 0])).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
    }
  });

  test('rejects an excessive region-by-zone intersection product before applying protection', () => {
    const regions = Array.from({ length: 256 }, (_, index) => ({
      level: 2,
      polygon: regularPolygon(index * 3, 0, 0.5, 16),
    }));
    const zones = Array.from({ length: 764 }, () => ({
      kind: 'load-bearing' as const,
      maxLevel: 0 as const,
      polygon: regularPolygon(0, 0, 0.25, 16),
    }));
    expect(() => applyProtectedZones(plainMap(regions), zones)).toThrowError(expect.objectContaining({ code: 'COMPLEXITY' }));
  });
});

describe('symmetrizeEngraving', () => {
  test('rotates engraving and protected cells around an explicit centre without mutation', () => {
    const source = plainMap([
      { level: 4, polygon: rectangle(10.8, -0.1, 11.2, 0.1) },
      { level: 0, polygon: rectangle(11.8, -0.1, 12.2, 0.1) },
    ], [10, 0]);
    const symmetric = symmetrizeEngraving(source, { sectors: 4, center: [10, 0] });
    for (const point of [[11, 0], [10, 1], [9, 0], [10, -1]] as const) expect(levelAt(symmetric, point)).toBe(4);
    for (const point of [[12, 0], [10, 2], [8, 0], [10, -2]] as const) expect(levelAt(symmetric, point)).toBe(0);
    expect(source.regions).toHaveLength(2);
    expect(symmetric.regions).toHaveLength(8);
  });

  test('deduplicates exact symmetric copies and rejects ambiguous positive-area overlaps', () => {
    const centered = plainMap([{ level: 2, polygon: rectangle(-1, -1, 1, 1) }]);
    expect(symmetrizeEngraving(centered, { sectors: 4 }).regions).toHaveLength(1);
    const crossing = plainMap([{ level: 3, polygon: rectangle(0.2, -2, 2, 2) }]);
    expect(() => symmetrizeEngraving(crossing, { sectors: 4 })).toThrowError(expect.objectContaining({ code: 'OVERLAP' }));
  });

  test.each([0, 1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid sector count %s', (sectors) => {
    expect(() => symmetrizeEngraving(plainMap([]), { sectors })).toThrowError(expect.objectContaining({ code: 'SECTORS' }));
  });

  test('returns a typed error for null symmetry options', () => {
    expect(() => symmetrizeEngraving(plainMap([]), null as never)).toThrowError(expect.objectContaining({ code: 'SECTORS' }));
  });

  test('rejects excessive base-footprint expansion before rotating polygons', () => {
    const source: EngravingMap = {
      ...plainMap([]),
      baseFootprint: Array.from({ length: 65 }, (_, index) => rectangle(index * 2, 0, index * 2 + 1, 1)),
    };
    expect(() => symmetrizeEngraving(source, { sectors: 64 })).toThrowError(expect.objectContaining({ code: 'COMPLEXITY' }));
  });
});

test('height cells may share an edge without positive-area overlap', () => {
  expect(quantizeHeightField({ cells: [
    { heightMm: 0, polygon: rectangle(0, 0, 1, 1) },
    { heightMm: 1, polygon: rectangle(1, 0, 2, 1) },
  ] }, 4).regions).toHaveLength(2);
});

test('polygon overlap exposes the exact triangulation checkpoint', () => {
  const labels: string[] = [];
  expect(() => polygonIntersectionArea(
    regularPolygon(0, 0, 10, 12), regularPolygon(1, 0, 10, 12),
    (label) => { labels.push(label); if (label === 'triangulate:inner-loop') throw new RangeError('deadline'); },
  )).toThrow('deadline');
  expect(labels.at(-1)).toBe('triangulate:inner-loop');
  expect(labels).not.toContain('intersection:triangle-pair-loop');
});

test.each([
  ['overlap:length-tolerance:coordinate-scan', 'overlap', 'triangulate:outer-loop'],
  ['overlap:canonical-equivalence:left:canonical-sequence:encoding-scan', 'canonical-overlap', 'overlap:intersection:triangle-pair-loop'],
  ['triangulate:signature:scan', 'intersection', 'triangulate:inner-loop'],
  ['triangulate:signed-area:scan', 'intersection', 'triangulate:inner-loop'],
  ['triangulate:geometry-scale:bounds:scan', 'intersection', 'triangulate:inner-loop'],
] as const)('expires exactly in polygon preparation phase %s', (expiryLabel, operation, forbiddenLabel) => {
  const labels: string[] = [];
  const left = regularPolygon(0, 0, 10, 130), right = operation === 'canonical-overlap'
    ? { points: [...left.points.slice(1), left.points[0]] }
    : regularPolygon(1, 0, 10, 131);
  const checkpoint = (label: string) => { labels.push(label); if (label === expiryLabel) throw new RangeError('deadline'); };
  const invoke = () => operation !== 'intersection'
    ? polygonsOverlapArea(left, right, checkpoint)
    : polygonIntersectionArea(left, right, checkpoint);
  expect(invoke).toThrow('deadline');
  expect(labels.at(-1)).toBe(expiryLabel);
  expect(labels).not.toContain(forbiddenLabel);
});

test('canonical overlap equivalence compares tokens incrementally before triangulation', () => {
  const base = regularPolygon(0, 0, 10, 130);
  const rotated: Polygon2 = { points: [...base.points.slice(37), ...base.points.slice(0, 37)] };
  const reversed: Polygon2 = { points: [...base.points].reverse() };
  expect(polygonsOverlapArea(base, rotated)).toBe(true);
  expect(polygonsOverlapArea(base, reversed)).toBe(true);

  const labels: string[] = [];
  expect(() => polygonsOverlapArea(base, rotated, (label) => {
    labels.push(label);
    if (label === 'overlap:canonical-equivalence:token-compare') throw new RangeError('deadline');
  })).toThrow('deadline');
  expect(labels.at(-1)).toBe('overlap:canonical-equivalence:token-compare');
  expect(labels).not.toContain('overlap:intersection:triangle-pair-loop');

  const near: Polygon2 = { points: base.points.map(([x, y], index) => index === 0 ? [x + 0.01, y] as const : [x, y] as const) };
  const differentLabels: string[] = [];
  polygonsOverlapArea(base, near, (label) => differentLabels.push(label));
  expect(differentLabels).toContain('overlap:triangulate:outer-loop');
});

test.each(['canonical:forward-backward-compare', 'canonical:key-assembly'])(
  'canonical key expires exactly at %s', (expiryLabel) => {
    const labels: string[] = [];
    const polygon = regularPolygon(0, 0, 10, 130);
    expect(() => canonicalPolygonKey(polygon, (label) => {
      labels.push(label); if (label === expiryLabel) throw new RangeError('deadline');
    })).toThrow('deadline');
    expect(labels.at(-1)).toBe(expiryLabel);
  },
);

test('canonical cache verifies exact coordinates even under a forced hash collision', () => {
  const polygon = regularPolygon(0, 0, 10, 8);
  const first = canonicalPolygonKey(polygon, () => undefined, 7);
  (polygon.points as Point2[])[0] = [11, 0];
  const labels: string[] = [];
  const second = canonicalPolygonKey(polygon, (label) => labels.push(label), 7);
  expect(labels).toContain('canonical:cache-exact-compare');
  expect(second).not.toBe(first);
});

test('triangulation index removal is interruptible during its manual shift', () => {
  const labels: string[] = [];
  const left = regularPolygon(0, 0, 10, 130), right = regularPolygon(1, 0, 10, 131);
  expect(() => polygonIntersectionArea(left, right, (label) => {
    labels.push(label); if (label === 'triangulate:index-shift') throw new RangeError('deadline');
  })).toThrow('deadline');
  expect(labels.at(-1)).toBe('triangulate:index-shift');
  expect(labels).not.toContain('intersection:triangle-pair-loop');
});
