import { describe, expect, test } from 'vitest';
import { generateParts } from './generate-parts';
import { sampleLathedProfile } from './profile-sampler';
import type { LathedProfile, MaterialInput, Polygon2 } from './types';
import type { TriangleMesh } from '../mesh/types';
import type { Axis } from '../types';

const profile: LathedProfile = {
  samples: [
    { z: -12, radius: 9 },
    { z: -6, radius: 18 },
    { z: 0, radius: 24 },
    { z: 6, radius: 18 },
    { z: 12, radius: 9 },
  ],
};
const material: MaterialInput = { thicknessMm: 3, fitAllowanceMm: 0.1 };

function area(polygon: Polygon2): number {
  return polygon.points.reduce((sum, point, index) => {
    const next = polygon.points[(index + 1) % polygon.points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

describe('generateParts', () => {
  test('generates the requested hybrid kit with valid consistently wound polygons', () => {
    const kit = generateParts(profile, material, { ribCount: 8, ringLayers: 3, shaftMm: 3, fit: 'snug' });
    expect(kit.parts.filter((part) => part.kind === 'rib')).toHaveLength(8);
    expect(kit.parts.filter((part) => part.kind === 'outer-ring')).toHaveLength(3);
    expect(kit.parts.some((part) => part.kind === 'hub-layer')).toBe(true);
    for (const part of kit.parts) {
      expect(part.quantity).toBeGreaterThan(0);
      for (const polygon of [part.outline, ...part.holes]) {
        expect(polygon.points.length).toBeGreaterThanOrEqual(3);
        expect(polygon.points.flat().every(Number.isFinite)).toBe(true);
        expect(Math.abs(area(polygon))).toBeGreaterThan(0);
        expect(polygon.points.every((point, index) => {
          const next = polygon.points[(index + 1) % polygon.points.length];
          return point[0] !== next[0] || point[1] !== next[1];
        })).toBe(true);
      }
      expect(area(part.outline)).toBeGreaterThan(0);
      expect(part.holes.every((hole) => area(hole) < 0)).toBe(true);
    }
    const shaftHoles = kit.parts.flatMap((part) => part.holeMetadata ?? []).filter((hole) => hole.purpose === 'shaft');
    expect(shaftHoles.length).toBeGreaterThan(0);
    expect(shaftHoles.every((hole) => hole.center[0] === 0 && hole.center[1] === 0)).toBe(true);
    expect(kit.estimatedBalance).toMatchObject({ kind: 'ideal-static-estimate', status: 'pass' });
    expect(kit.estimatedBalance.centroidOffsetMm).toBeCloseTo(0, 12);
  });

  test.each([4, 6, 8, 10, 12] as const)('places %i deterministic ribs in opposite angular pairs', (ribCount) => {
    const kit = generateParts(profile, material, { ribCount, ringLayers: 2, shaftMm: 3, fit: 'slip' });
    const ribs = kit.parts.filter((part) => part.kind === 'rib');
    expect(ribs).toHaveLength(ribCount);
    for (let index = 0; index < ribCount / 2; index += 1) {
      expect(ribs[index].angleRad! + Math.PI).toBeCloseTo(ribs[index + ribCount / 2].angleRad!, 12);
    }
  });

  test('pairs every joint without orphans at the allowance-adjusted width', () => {
    const kit = generateParts(profile, material, { ribCount: 6, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const grouped = new Map<string, typeof kit.joints>();
    for (const joint of kit.joints) grouped.set(joint.id, [...(grouped.get(joint.id) ?? []), joint]);
    expect([...grouped.values()].every((pair) => pair.length === 2 && pair[0].role !== pair[1].role)).toBe(true);
    expect(kit.joints.every((joint) => joint.widthMm === 3.1)).toBe(true);
    expect(kit.assembly.every((edge) => grouped.has(edge.jointId))).toBe(true);
  });

  test('is deterministic, input-immutable, scale-aware, and changes IDs with options', () => {
    const snapshot = JSON.stringify({ profile, material });
    const options = { ribCount: 8 as const, ringLayers: 3, shaftMm: 3, fit: 'snug' as const };
    const first = generateParts(profile, material, options);
    const second = generateParts(profile, material, options);
    expect(second).toEqual(first);
    expect(JSON.stringify({ profile, material })).toBe(snapshot);
    const changed = generateParts(profile, material, { ...options, fit: 'press' });
    expect(changed.parts.map((part) => part.id)).not.toEqual(first.parts.map((part) => part.id));
    const scaled = generateParts({ samples: profile.samples.map(({ z, radius }) => ({ z: z * 2, radius: radius * 2 })) }, material, { ...options, shaftMm: 6 });
    expect(Math.abs(area(scaled.parts[0].outline)) / Math.abs(area(first.parts[0].outline))).toBeCloseTo(4, 6);
  });

  test.each([
    [{ samples: [] }, material, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'PROFILE'],
    [{ samples: [{ z: 0, radius: 2 }, { z: -1, radius: 3 }] }, material, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'PROFILE'],
    [profile, { thicknessMm: 0, fitAllowanceMm: 0 }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'MATERIAL'],
    [profile, { thicknessMm: 3, fitAllowanceMm: -0.1 }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'MATERIAL'],
    [profile, material, { ribCount: 5, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'OPTIONS'],
    [profile, material, { ribCount: 8, ringLayers: 0, shaftMm: 3, fit: 'snug' }, 'OPTIONS'],
    [profile, material, { ribCount: 8, ringLayers: 2, shaftMm: 30, fit: 'snug' }, 'SHAFT'],
    [profile, { thicknessMm: 30, fitAllowanceMm: 1 }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'JOINT'],
  ] as const)('rejects invalid decomposition input with typed code %#', (badProfile, badMaterial, badOptions, code) => {
    expect(() => generateParts(badProfile as LathedProfile, badMaterial as MaterialInput, badOptions as never)).toThrowError(expect.objectContaining({ name: 'DecompositionError', code }));
  });
});

describe('sampleLathedProfile', () => {
  test('samples deterministic maximum radii in axial bins for a simple lathed mesh', () => {
    const positions: number[] = [];
    for (const z of [-2, 0, 2]) for (let segment = 0; segment < 8; segment += 1) {
      const angle = segment * Math.PI / 4;
      const radius = z === 0 ? 4 : 2;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
    const indices: number[] = [];
    for (let ring = 0; ring < 2; ring += 1) for (let segment = 0; segment < 8; segment += 1) {
      const next = (segment + 1) % 8;
      const a = ring * 8 + segment, b = ring * 8 + next, c = (ring + 1) * 8 + segment, d = (ring + 1) * 8 + next;
      indices.push(a, b, c, b, d, c);
    }
    const mesh: TriangleMesh = { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
    const axis: Axis = { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true };
    const sampled = sampleLathedProfile(mesh, axis, 3);
    expect(sampled.samples.map(({ z }) => z)).toEqual([-2, 0, 2]);
    sampled.samples.forEach(({ radius }, index) => expect(radius).toBeCloseTo([2, 4, 2][index], 12));
    expect(sampled).toEqual(sampleLathedProfile(mesh, axis, 3));
  });
});
