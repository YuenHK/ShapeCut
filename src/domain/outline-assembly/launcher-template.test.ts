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
  return { loops, provenanceHash: '0123456789abcdef' };
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
    expect(launcherReferencesAreCompatible(reference(), reference({ shear: 0.501 }))).toBe(false);
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
    expect(result.provenanceHashes).toEqual(['0123456789abcdef', '0123456789abcdef']);
    expect(result.loops[0]).toEqual(normalizeLauncherLoops(first.loops)[0]);
  });

  it('removes a rigid common rotation from loop centers and geometry', () => {
    const source = reference();
    expect(normalizeLauncherLoops(rotateReference(source, 47).loops)).toEqual(normalizeLauncherLoops(source.loops));
  });

  it('fails instead of averaging any incompatible reference', () => {
    expect(() => averageCompatibleLauncherReferences([reference(), reference({ radiusOffset: 0.6 })], 1))
      .toThrow(/incompatible/i);
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

  it('renders deterministic numeric-only TypeScript without source paths', () => {
    const template = averageCompatibleLauncherReferences([reference(), reference()], 1);
    const first = renderLauncherTemplateInitializer(template);
    const second = renderLauncherTemplateInitializer(template);
    expect(first).toBe(second);
    expect(first).toContain('KNIGHT_FORTRESS_LAUNCHER_TEMPLATE');
    expect(first).toContain('0123456789abcdef');
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

});
