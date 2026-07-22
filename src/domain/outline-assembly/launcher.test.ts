import { describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { FeatureContour } from '../outline-features/types';
import {
  detectLauncherTemplate,
  planLauncherClearance,
  type LauncherCandidateGroup,
  type LauncherDetection,
} from './launcher';

function rectangle(center: Point2, width = 2, height = 1): readonly Point2[] {
  const [x, y] = center;
  return [
    [x - width / 2, y - height / 2],
    [x + width / 2, y - height / 2],
    [x + width / 2, y + height / 2],
    [x - width / 2, y + height / 2],
  ];
}

function group(
  gaps: readonly [number, number, number] = [120, 120, 120],
  options: { readonly rotationDeg?: number; readonly offset?: Point2; readonly support?: number } = {},
): LauncherCandidateGroup {
  const rotation = options.rotationDeg ?? 0;
  const offset = options.offset ?? [0, 0];
  const angles = [rotation, rotation + gaps[0], rotation + gaps[0] + gaps[1]];
  return {
    evidenceStrength: options.support ?? 0.8,
    loops: angles.map((degrees) => {
      const radians = degrees * Math.PI / 180;
      return {
        closed: true,
        support: options.support ?? 0.8,
        outer: rectangle([
          offset[0] + Math.cos(radians) * 10,
          offset[1] + Math.sin(radians) * 10,
        ]),
      };
    }) as unknown as LauncherCandidateGroup['loops'],
  };
}

function exterior(id: string, halfSize: number): FeatureContour {
  const outer = rectangle([0, 0], halfSize * 2, halfSize * 2);
  return {
    id,
    role: 'CUT_BLACK',
    outer,
    boundsMm: { minX: -halfSize, minY: -halfSize, maxX: halfSize, maxY: halfSize },
    areaMm2: halfSize * halfSize * 4,
  };
}

describe('three-hook launcher detection', () => {
  it.each([
    [[112, 120, 128] as const],
    [[128, 112, 120] as const],
    [[120, 128, 112] as const],
  ])('accepts three successive gaps inside the inclusive 120 +/- 8 degree rule', (gaps) => {
    expect(detectLauncherTemplate({ candidates: [group(gaps)], axisPoint: [0, 0] }).status)
      .toBe('detected');
  });

  it.each([
    [[111.99, 120, 128.01] as const],
    [[129, 112, 119] as const],
  ])('rejects a group when any successive gap is outside the angular rule', (gaps) => {
    expect(detectLauncherTemplate({ candidates: [group(gaps)], axisPoint: [0, 0] }).status)
      .toBe('omitted');
  });

  it('rejects open, non-simple, non-finite, and over-budget loops', () => {
    const altered = (replacement: LauncherCandidateGroup['loops'][number]): LauncherCandidateGroup => {
      const source = group();
      return { ...source, loops: [replacement, source.loops[1], source.loops[2]] };
    };
    const source = group();
    const open = altered({ ...source.loops[0], closed: false });
    const bowTie = altered({ ...source.loops[0], outer: [[8, -1], [12, 1], [8, 1], [12, -1]] });
    const nonFinite = altered({ ...source.loops[0], outer: [[NaN, 0], [1, 0], [0, 1]] });
    const tooMany = altered({
      ...source.loops[0],
      outer: Array.from({ length: 4_097 }, (_, index): Point2 => {
        const angle = index * Math.PI * 2 / 4_097;
        return [10 + Math.cos(angle), Math.sin(angle)];
      }),
    });
    for (const candidate of [open, bowTie, nonFinite, tooMany]) {
      expect(detectLauncherTemplate({ candidates: [candidate], axisPoint: [0, 0] }).status)
        .toBe('omitted');
    }
  });

  it('prefers stronger centered evidence and normalizes translation, rotation, order, and winding deterministically', () => {
    const centered = group([120, 120, 120], { rotationDeg: 47, support: 0.85 });
    const reversed = {
      ...centered,
      loops: [centered.loops[2], centered.loops[0], centered.loops[1]].map((loop) => ({
        ...loop,
        outer: [...loop.outer].reverse(),
      })) as unknown as LauncherCandidateGroup['loops'],
    };
    const weakerOffAxis = group([120, 120, 120], { offset: [1.5, -0.5], support: 0.95 });
    const first = detectLauncherTemplate({ candidates: [weakerOffAxis, centered], axisPoint: [0, 0] });
    const second = detectLauncherTemplate({ candidates: [reversed], axisPoint: [0, 0] });
    expect(first.status).toBe('detected');
    expect(second.status).toBe('detected');
    if (first.status !== 'detected' || second.status !== 'detected') return;
    expect(first.sourceCandidateIndex).toBe(1);
    expect(first.loops).toEqual(second.loops);
    const firstCenter = first.loops[0].reduce(
      ([x, y], point) => [x + point[0] / first.loops[0].length, y + point[1] / first.loops[0].length] as Point2,
      [0, 0] as Point2,
    );
    expect(firstCenter[1]).toBeCloseTo(0, 10);
    expect(firstCenter[0]).toBeGreaterThan(0);
  });

  it('fails closed when the runtime deadline is exhausted and calls the checkpoint', () => {
    const checkpoint = vi.fn();
    expect(() => detectLauncherTemplate({
      candidates: [group()], axisPoint: [0, 0], deadline: Date.now() - 1, checkpoint,
    })).toThrow(/runtime budget/i);
    expect(checkpoint).toHaveBeenCalled();
  });

  it('propagates the checkpoint through in-loop simple-polygon validation', () => {
    const candidate = group();
    const invalid: LauncherCandidateGroup = {
      ...candidate,
      loops: [{ ...candidate.loops[0], outer: [[8, -1], [12, 1], [8, 1], [12, -1]] }, candidate.loops[1], candidate.loops[2]],
    };
    let calls = 0;
    expect(() => detectLauncherTemplate({
      candidates: [invalid],
      axisPoint: [0, 0],
      checkpoint: () => {
        calls += 1;
        if (calls === 3) throw new RangeError('mid-loop checkpoint');
      },
    })).toThrow(/mid-loop checkpoint/);
  });
});

describe('safe two-layer launcher planning', () => {
  function detection(): LauncherDetection {
    return detectLauncherTemplate({ candidates: [group()], axisPoint: [0, 0] });
  }

  it('uses a detected template, applies inside-cut kerf plus 0.20 mm radial allowance, and keeps one geometry', () => {
    const result = planLauncherClearance({
      detection: detection(),
      fallback: undefined,
      axisPoint: [0, 0],
      topExterior: exterior('top', 20),
      secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(result.status).toBe('detected');
    if (result.status === 'omitted') return;
    expect(result.assemblyAllowanceMm).toBe(0.2);
    expect(result.cuts).toHaveLength(3);
    expect(result.cuts[0].areaMm2).toBeCloseTo(2.64, 8);
    expect(result.cuts.every(({ role }) => role === 'CUT_BLACK')).toBe(true);
  });

  it('uses the fallback without scaling when detection is unavailable', () => {
    const fallback = { version: 7, loops: group().loops.map(({ outer }) => outer) as [readonly Point2[], readonly Point2[], readonly Point2[]], provenanceHashes: ['1', '2'] as const };
    const result = planLauncherClearance({
      detection: { status: 'omitted', reason: 'no reliable candidates' },
      fallback,
      axisPoint: [2, -3],
      topExterior: exterior('top', 30),
      secondExterior: exterior('second', 30),
      material: { kerfMm: 0, minWebMm: 0 },
    });
    expect(result.status).toBe('fallback');
    if (result.status === 'omitted') return;
    expect(result.cuts[0].boundsMm.maxX).toBeCloseTo(13.2, 10);
    expect(result.cuts[0].boundsMm.minY).toBeCloseTo(-3.7, 10);
  });

  it('omits all three cuts with a sanitized warning if either layer rejects one cut', () => {
    const result = planLauncherClearance({
      detection: detection(),
      fallback: undefined,
      axisPoint: [0, 0],
      topExterior: exterior('top', 20),
      secondExterior: exterior('second', 10.5),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(result).toEqual({
      status: 'omitted',
      cuts: [],
      warning: '無法安全保留原裝發射器相容性，已省略三個發射器開孔',
    });
  });
});
