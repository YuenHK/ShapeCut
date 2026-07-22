import { describe, expect, it, vi } from 'vitest';
import type { Point2 } from '../decomposition/types';
import type { FeatureContour } from '../outline-features/types';
import {
  detectLauncherTemplate,
  LAUNCHER_OMISSION_WARNING,
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
  options: {
    readonly rotationDeg?: number;
    readonly offset?: Point2;
    readonly support?: number;
    readonly radius?: number;
    readonly width?: number;
    readonly height?: number;
  } = {},
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
          offset[0] + Math.cos(radians) * (options.radius ?? 10),
          offset[1] + Math.sin(radians) * (options.radius ?? 10),
        ], options.width, options.height),
      };
    }) as unknown as LauncherCandidateGroup['loops'],
  };
}

function compressOnlyDuringPolygonValidation(points: readonly Point2[]): readonly Point2[] {
  return new Proxy(points, {
    get: (target, property, receiver) => {
      const validating = new Error().stack?.includes('/engraving/geometry.ts') ?? false;
      if (validating && property === 'length') return 4;
      if (validating && typeof property === 'string' && /^[0-3]$/.test(property)) {
        return target[Math.floor(Number(property) * target.length / 4)];
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function denseGroup(pointCount = 4_096, denseEveryLoop = false): LauncherCandidateGroup {
  return {
    evidenceStrength: 0.8,
    loops: [0, 120, 240].map((degrees, loopIndex) => {
      const angle = degrees * Math.PI / 180;
      const center: Point2 = [Math.cos(angle) * 10, Math.sin(angle) * 10];
      const loopPointCount = denseEveryLoop || loopIndex === 2 ? pointCount : 4;
      const outer = Array.from({ length: loopPointCount }, (_, index): Point2 => {
        const pointAngle = index * Math.PI * 2 / loopPointCount;
        return [center[0] + Math.cos(pointAngle), center[1] + Math.sin(pointAngle) * 0.5];
      });
      return {
        closed: true,
        support: 0.8,
        outer: loopPointCount === pointCount ? compressOnlyDuringPolygonValidation(outer) : outer,
      };
    }) as unknown as LauncherCandidateGroup['loops'],
  };
}

function captureThrown(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
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

function contour(id: string, outer: readonly Point2[]): FeatureContour {
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  return {
    id,
    role: 'CUT_BLACK',
    outer,
    boundsMm: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    areaMm2: Math.abs(outer.reduce((sum, point, index) => {
      const next = outer[(index + 1) % outer.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2),
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

  it('rejects zero and tiny source support below the documented reliability floor', () => {
    expect(detectLauncherTemplate({ candidates: [group([120, 120, 120], { support: 0 })], axisPoint: [0, 0] }).status)
      .toBe('omitted');
    expect(detectLauncherTemplate({ candidates: [group([120, 120, 120], { support: 0.01 })], axisPoint: [0, 0] }).status)
      .toBe('omitted');
  });

  it('uses bounded size evidence to prefer the larger of otherwise equal candidates', () => {
    const result = detectLauncherTemplate({
      candidates: [group([120, 120, 120], { width: 1 }), group([120, 120, 120], { width: 2 })],
      axisPoint: [0, 0],
    });
    expect(result.status).toBe('detected');
    if (result.status === 'detected') expect(result.sourceCandidateIndex).toBe(1);
  });

  it('propagates the exact caller cancellation late inside the third dense-loop centroid', () => {
    const cancellation = new RangeError('cancelled inside dense centroid');
    let centroidPolls = 0;
    const thrown = captureThrown(() => detectLauncherTemplate({
      candidates: [denseGroup()],
      axisPoint: [0, 0],
      checkpoint: () => {
        const stack = new Error().stack;
        if (stack?.includes('normalizeLauncherLoops')) throw new RangeError('centroid pass was not checkpointed');
        if (!stack?.includes('polygonCentroid')) return;
        centroidPolls += 1;
        if (centroidPolls === 82) throw cancellation;
      },
    }));
    expect(centroidPolls).toBe(82);
    expect(thrown).toBe(cancellation);
  }, 30_000);

  it('propagates the exact caller cancellation late inside the third dense-loop scoring area scan', () => {
    const cancellation = new RangeError('cancelled inside dense area scan');
    let scoringAreaPolls = 0;
    const thrown = captureThrown(() => detectLauncherTemplate({
      candidates: [denseGroup()],
      axisPoint: [0, 0],
      checkpoint: () => {
        const stack = new Error().stack;
        if (stack?.includes('normalizeLauncherLoops')) throw new RangeError('scoring area pass was not checkpointed');
        if (!stack?.includes('outline-2.5d/simplify.ts') || !stack.includes('signedArea')
          || !stack.includes('evaluateCandidate') || stack.includes('polygonCentroid')) return;
        scoringAreaPolls += 1;
        if (scoringAreaPolls === 60) throw cancellation;
      },
    }));
    expect(scoringAreaPolls).toBe(60);
    expect(thrown).toBe(cancellation);
  }, 30_000);

  it('propagates the exact caller cancellation late inside the selected dense-loop copy', () => {
    const cancellation = new RangeError('cancelled inside selected-loop copy');
    let copyPolls = 0;
    const thrown = captureThrown(() => detectLauncherTemplate({
      candidates: [denseGroup()],
      axisPoint: [0, 0],
      checkpoint: () => {
        const stack = new Error().stack;
        if (stack?.includes('normalizeLauncherLoops')) throw new RangeError('selected-loop copy was not checkpointed');
        if (!stack?.includes('copySelectedLauncherLoops')) return;
        copyPolls += 1;
        if (copyPolls === 16) throw cancellation;
      },
    }));
    expect(copyPolls).toBe(16);
    expect(thrown).toBe(cancellation);
  }, 30_000);
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
    expect(result.cuts[0].boundsMm.minX).toBeCloseTo(8.9, 12);
    expect(result.cuts[0].boundsMm.maxX).toBeCloseTo(11.1, 12);
    expect(result.cuts[0].boundsMm.minY).toBeCloseTo(-0.6, 12);
    expect(result.cuts[0].boundsMm.maxY).toBeCloseTo(0.6, 12);
    expect(result.cuts.every(({ role }) => role === 'CUT_BLACK')).toBe(true);
  });

  it('uses the fallback without scaling when detection is unavailable', () => {
    const fallback = {
      version: 7,
      loops: group().loops.map(({ outer }) => outer) as [readonly Point2[], readonly Point2[], readonly Point2[]],
      provenanceHashes: ['a'.repeat(64), 'b'.repeat(64)] as const,
    };
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

  it('falls back when model-derived evidence is below the reliability floor', () => {
    const fallbackGroup = group();
    const result = planLauncherClearance({
      detection: detectLauncherTemplate({ candidates: [group([120, 120, 120], { support: 0.01 })], axisPoint: [0, 0] }),
      fallback: {
        version: 1,
        loops: fallbackGroup.loops.map(({ outer }) => outer) as [readonly Point2[], readonly Point2[], readonly Point2[]],
        provenanceHashes: ['a'.repeat(64), 'b'.repeat(64)],
      },
      axisPoint: [0, 0],
      topExterior: exterior('top', 20),
      secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(result.status).toBe('fallback');
  });

  it('checks the finished +0.20 mm opening envelope at a nonzero-kerf exterior boundary', () => {
    const unsafe = planLauncherClearance({
      detection: detection(), fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 11.95), secondExterior: exterior('second', 11.95),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(unsafe.status).toBe('omitted');
    const safe = planLauncherClearance({
      detection: detection(), fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 12.01), secondExterior: exterior('second', 12.01),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(safe.status).toBe('detected');
  });

  it('checks the finished opening envelope against a central hole at nonzero kerf', () => {
    const centralHole = contour('central', rectangle([7.55, 0], 1, 1));
    const result = planLauncherClearance({
      detection: detection(), fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 20), secondExterior: exterior('second', 20),
      topCentralHole: centralHole, secondCentralHole: centralHole,
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(result.status).toBe('omitted');
  });

  it('checks inter-hook minimum web against finished envelopes at nonzero kerf', () => {
    const compact = detectLauncherTemplate({
      candidates: [group([120, 120, 120], { radius: 3, width: 2, height: 1 })], axisPoint: [0, 0],
    });
    const result = planLauncherClearance({
      detection: compact, fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 20), secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 2.55 },
    });
    expect(result.status).toBe('omitted');
  });

  it('fails immediately on an expired planner deadline and propagates cancellation', () => {
    const checkpoint = vi.fn();
    expect(() => planLauncherClearance({
      detection: detection(), fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 20), secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 0.8 }, deadline: Date.now() - 1, checkpoint,
    })).toThrow(/runtime budget/i);
    expect(checkpoint).toHaveBeenCalled();

    let calls = 0;
    expect(() => planLauncherClearance({
      detection: detection(), fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 20), secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
      checkpoint: () => {
        calls += 1;
        if (calls === 4) throw new Error('planner cancelled');
      },
    })).toThrow(/planner cancelled/);
  });

  it('rethrows the exact caller RangeError when its message resembles offset geometry recovery', () => {
    const cancellation = new RangeError('Offset caller cancellation');
    let calls = 0;
    const thrown = captureThrown(() => planLauncherClearance({
      detection: detection(), fallback: undefined, axisPoint: [0, 0],
      topExterior: exterior('top', 20), secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
      checkpoint: () => {
        calls += 1;
        if (calls === 4) throw cancellation;
      },
    }));
    expect(calls).toBe(4);
    expect(thrown).toBe(cancellation);
  });

  it('still omits safely when the offset kernel reports genuine invalid geometry', () => {
    const source = group();
    const invalidLoop: readonly Point2[] = [[8, -1], [12, 1], [8, 1], [12, -1]];
    const result = planLauncherClearance({
      detection: { status: 'omitted', reason: 'no reliable candidates' },
      fallback: {
        version: 1,
        loops: [invalidLoop, source.loops[1].outer, source.loops[2].outer],
        provenanceHashes: ['a'.repeat(64), 'b'.repeat(64)],
      },
      axisPoint: [0, 0],
      topExterior: exterior('top', 20),
      secondExterior: exterior('second', 20),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
    });
    expect(result).toEqual({ status: 'omitted', cuts: [], warning: LAUNCHER_OMISSION_WARNING });
  });

  it('propagates the exact caller cancellation late inside dense-loop translation', () => {
    const cancellation = new RangeError('cancelled inside planner translation');
    let translationPolls = 0;
    const loops = denseGroup(4_096, true).loops.map(({ outer }) => outer) as unknown as Extract<
      LauncherDetection,
      { readonly status: 'detected' }
    >['loops'];
    const thrown = captureThrown(() => planLauncherClearance({
      detection: { status: 'detected', loops, score: 1, sourceCandidateIndex: 0 },
      axisPoint: [0, 0],
      topExterior: exterior('top', 30),
      secondExterior: exterior('second', 30),
      material: { kerfMm: 0.2, minWebMm: 0.8 },
      checkpoint: () => {
        const stack = new Error().stack;
        if (stack?.includes('offsetMitered')) throw new RangeError('planner translation was not checkpointed');
        if (!stack?.includes('translateLauncherLoop')) return;
        translationPolls += 1;
        if (translationPolls === 10) throw cancellation;
      },
    }));
    expect(translationPolls).toBe(10);
    expect(thrown).toBe(cancellation);
  });
});
