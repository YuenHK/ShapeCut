import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import {
  averageCompatibleLauncherReferences,
  KNIGHT_FORTRESS_LAUNCHER_TEMPLATE,
  launcherReferencesAreCompatible,
  normalizeLauncherLoops,
  renderLauncherTemplateInitializer,
  type LauncherReference,
} from './launcher-template';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function rectangle(center: Point2, width = 2, height = 1): readonly Point2[] {
  const [x, y] = center;
  return [[x - width / 2, y - height / 2], [x + width / 2, y - height / 2], [x + width / 2, y + height / 2], [x - width / 2, y + height / 2]];
}

function reference(options: {
  readonly radiusOffset?: number;
  readonly width?: number;
  readonly shear?: number;
  readonly loopCount?: number;
  readonly rotationDeg?: number;
} = {}): LauncherReference {
  const loops = Array.from({ length: options.loopCount ?? 3 }, (_, index) => {
    const angle = (index * 120 + (options.rotationDeg ?? 0)) * Math.PI / 180;
    const radius = 10 + (options.radiusOffset ?? 0);
    const center: Point2 = [Math.cos(angle) * radius, Math.sin(angle) * radius];
    const points = rectangle(center, options.width ?? 2, 1);
    return options.shear === undefined
      ? points
      : points.map(([x, y], pointIndex): Point2 => [x + (pointIndex < 2 ? -options.shear! : options.shear!), y]);
  });
  return { loops, provenanceHash: HASH_A };
}

function asymmetricReference(): LauncherReference {
  const widths = [1, 1.5, 2.25];
  return {
    provenanceHash: HASH_A,
    loops: widths.map((width, index) => {
      const angle = (10 + index * 120) * Math.PI / 180;
      return rectangle([Math.cos(angle) * 10, Math.sin(angle) * 10], width, 0.8 + index * 0.2);
    }),
  };
}

function subdivide(loop: readonly Point2[], segments: number): readonly Point2[] {
  return loop.flatMap((point, index) => {
    const next = loop[(index + 1) % loop.length];
    return Array.from({ length: segments }, (_, segment): Point2 => [
      point[0] + (next[0] - point[0]) * segment / segments,
      point[1] + (next[1] - point[1]) * segment / segments,
    ]);
  });
}

function rotateReference(source: LauncherReference, degrees: number): LauncherReference {
  const angle = degrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  return {
    ...source,
    loops: source.loops.map((loop) => loop.map(([x, y]): Point2 => [
      x * cosine - y * sine,
      x * sine + y * cosine,
    ])),
  };
}

describe('Knight Fortress launcher template compatibility', () => {
  it('requires exactly three corresponding loops', () => {
    expect(launcherReferencesAreCompatible(reference(), reference({ loopCount: 2 }))).toBe(false);
    expect(() => averageCompatibleLauncherReferences([reference(), reference({ loopCount: 2 })], 1))
      .toThrow(/three-loop topology/i);
  });

  it('accepts the inclusive radius, area, and symmetric-distance limits', () => {
    expect(launcherReferencesAreCompatible(reference(), reference({ radiusOffset: 0.5 }))).toBe(true);
    expect(launcherReferencesAreCompatible(reference(), reference({ width: 2.2 }))).toBe(true);
    expect(launcherReferencesAreCompatible(reference(), reference({ shear: 0.5 }))).toBe(true);
  });

  it('rejects references beyond 5% radius, 10% area, or 0.50 mm symmetric mean point distance', () => {
    expect(launcherReferencesAreCompatible(reference(), reference({ radiusOffset: 0.501 }))).toBe(false);
    expect(launcherReferencesAreCompatible(reference(), reference({ width: 2.201 }))).toBe(false);
    // The shear fixture moves boundary samples by a range of distances; this
    // value puts its measured symmetric mean beyond the 0.50 mm limit.
    expect(launcherReferencesAreCompatible(reference(), reference({ shear: 1.1 }))).toBe(false);
  });

  it('normalizes a common rotation deterministically and averages compatible points without scaling', () => {
    const first = reference({ rotationDeg: 47 });
    const reordered: LauncherReference = {
      ...first,
      loops: [first.loops[2], first.loops[0], first.loops[1]].map((loop) => [...loop].reverse()),
    };
    expect(normalizeLauncherLoops(first.loops)).toEqual(normalizeLauncherLoops(reordered.loops));
    const result = averageCompatibleLauncherReferences([first, reordered], 3);
    expect(result.version).toBe(3);
    expect(result.loops).toHaveLength(3);
    expect(result.provenanceHashes).toEqual([HASH_A, HASH_A]);
    const reverse = averageCompatibleLauncherReferences([reordered, first], 3);
    expect(result.loops).toEqual(reverse.loops);
    expect(new Set(result.loops.map((loop) => loop.length))).toEqual(new Set([4]));
  });

  it('removes a rigid common rotation from loop centers and geometry', () => {
    const source = reference();
    expect(normalizeLauncherLoops(rotateReference(source, 47).loops)).toEqual(normalizeLauncherLoops(source.loops));
  });

  it('chooses one canonical cyclic start across rotations beyond 120 degrees and the atan branch', () => {
    const source = asymmetricReference();
    const rotated = rotateReference(source, 137);
    const reordered: LauncherReference = {
      ...rotated,
      loops: [rotated.loops[1], rotated.loops[2], rotated.loops[0]],
    };
    expect(normalizeLauncherLoops(reordered.loops)).toEqual(normalizeLauncherLoops(source.loops));
  });

  it('uniformly resamples and phase-aligns the same geometry with different tessellation', () => {
    const coarse = reference({ width: 4 });
    const dense: LauncherReference = {
      provenanceHash: HASH_B,
      loops: coarse.loops.map((loop, index) => {
        const values = subdivide(loop, 8);
        const phase = (index * 7 + 5) % values.length;
        return [...values.slice(phase), ...values.slice(0, phase)];
      }),
    };
    expect(launcherReferencesAreCompatible(coarse, dense)).toBe(true);
    const forward = averageCompatibleLauncherReferences([coarse, dense], 1);
    const reverse = averageCompatibleLauncherReferences([dense, coarse], 1);
    expect(forward.loops).toEqual(reverse.loops);
  });

  it('fails instead of averaging any incompatible reference', () => {
    expect(() => averageCompatibleLauncherReferences([reference(), reference({ radiusOffset: 0.6 })], 1))
      .toThrow(/incompatible/i);
  });

  it('fails closed when averaging or numeric canonicalization produces an invalid loop', () => {
    const thin = reference({ width: 4e-10 });
    expect(() => averageCompatibleLauncherReferences([
      thin, { ...thin, provenanceHash: HASH_B },
    ], 1)).toThrow(/averaged.*invalid/i);
  });

  it('propagates the checkpoint through template polygon validation', () => {
    const source = reference();
    const invalid: LauncherReference = {
      ...source,
      loops: [[[8, -1], [12, 1], [8, 1], [12, -1]], source.loops[1], source.loops[2]],
    };
    let calls = 0;
    expect(() => normalizeLauncherLoops(invalid.loops, Infinity, () => {
      calls += 1;
      if (calls === 3) throw new RangeError('template inner-loop checkpoint');
    })).toThrow(/template inner-loop checkpoint/);
  });

  it('preserves a caller RangeError cancellation from inside compatibility work', () => {
    const cancellation = new RangeError('compatibility cancelled');
    let calls = 0;
    let caught: unknown;
    try {
      launcherReferencesAreCompatible(reference(), reference(), Infinity, () => {
        calls += 1;
        if (calls === 5) throw cancellation;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancellation);
    expect(calls).toBe(5);
  });

  it('renders deterministic numeric-only TypeScript without source paths', () => {
    const template = averageCompatibleLauncherReferences([reference(), reference()], 1);
    const first = renderLauncherTemplateInitializer(template);
    const second = renderLauncherTemplateInitializer(template);
    expect(first).toBe(second);
    expect(first).toContain('KNIGHT_FORTRESS_LAUNCHER_TEMPLATE');
    expect(first).toContain(HASH_A);
    expect(first).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\.stl)/i);
  });

  it('publishes a versioned bounded three-loop numeric fallback with non-private provenance hashes', () => {
    expect(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.version).toBe(1);
    expect(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.loops).toHaveLength(3);
    expect(new Set(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.loops.map((loop) => loop.length))).toEqual(new Set([96]));
    expect(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.provenanceHashes).toHaveLength(2);
    for (const hash of KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.provenanceHashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\.stl|@)/i);
  });

  it('requires exactly two lowercase 64-hex hashes at averaging and render boundaries', () => {
    expect(() => averageCompatibleLauncherReferences([
      { ...reference(), provenanceHash: 'A'.repeat(64) }, reference(),
    ], 1)).toThrow(/provenance/i);
    expect(() => averageCompatibleLauncherReferences([
      { ...reference(), provenanceHash: 'abc' }, reference(),
    ], 1)).toThrow(/provenance/i);
    expect(() => renderLauncherTemplateInitializer({
      version: 1,
      loops: normalizeLauncherLoops(reference().loops),
      provenanceHashes: ['A'.repeat(64), HASH_B],
    })).toThrow(/provenance/i);
    const extra = {
      version: 1,
      loops: normalizeLauncherLoops(reference().loops),
      provenanceHashes: [HASH_A, HASH_B, 'c'.repeat(64)],
    } as unknown as Parameters<typeof renderLauncherTemplateInitializer>[0];
    expect(() => renderLauncherTemplateInitializer(extra)).toThrow(/provenance/i);
  });

});
