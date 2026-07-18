import { describe, expect, test } from 'vitest';
import { generateParts } from './generate-parts';
import { sampleLathedProfile } from './profile-sampler';
import type { LathedProfile, MaterialInput, Polygon2 } from './types';
import type { TriangleMesh } from '../mesh/types';
import type { Axis } from '../types';
import { isSimplePolygon } from './polygon-validation';

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
  test('rejects radial slots whose corners breach hub/ring margins or overlap neighbours', () => {
    const large: LathedProfile = { samples: [{ z: -50, radius: 80 }, { z: 0, radius: 100 }, { z: 50, radius: 80 }] };
    expect(() => generateParts(large, { thicknessMm: 38.9, fitAllowanceMm: 0.1 }, { ribCount: 12, ringLayers: 1, shaftMm: 62, fit: 'snug' })).toThrowError(expect.objectContaining({ code: 'JOINT' }));
  });

  test('rejects tabs wider than center spacing and emits simple legal rib outlines', () => {
    const tall: LathedProfile = { samples: [{ z: -50, radius: 20 }, { z: 0, radius: 100 }, { z: 50, radius: 20 }] };
    expect(() => generateParts(tall, { thicknessMm: 38.9, fitAllowanceMm: 0.1 }, { ribCount: 4, ringLayers: 1, shaftMm: 2, fit: 'snug' })).toThrowError(expect.objectContaining({ code: 'JOINT' }));
    const legal = generateParts(profile, material, { ribCount: 8, ringLayers: 3, shaftMm: 3, fit: 'snug' });
    expect(legal.parts.filter((part) => part.kind === 'rib').every((part) => isSimplePolygon(part.outline))).toBe(true);
  });

  test('builds ribs from every meridional profile sample rather than a bounding rectangle', () => {
    const left: LathedProfile = { samples: [{ z: -10, radius: 4 }, { z: 0, radius: 18 }, { z: 10, radius: 4 }] };
    const right: LathedProfile = { samples: [{ z: -10, radius: 4 }, { z: 0, radius: 10 }, { z: 10, radius: 4 }] };
    const options = { ribCount: 4 as const, ringLayers: 1, shaftMm: 2, fit: 'snug' as const };
    const leftRib = generateParts(left, material, options).parts.find((part) => part.kind === 'rib')!;
    const rightRib = generateParts(right, material, options).parts.find((part) => part.kind === 'rib')!;
    expect(leftRib.outline.points).not.toEqual(rightRib.outline.points);
    for (const sample of left.samples) {
      expect(leftRib.outline.points).toContainEqual([sample.z, sample.radius]);
      expect(leftRib.outline.points).toContainEqual([sample.z, -sample.radius]);
    }
  });

  test('maps cut slots and in-material rib contacts to one shared mating frame', () => {
    const kit = generateParts(profile, material, { ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const pairs = new Map<string, typeof kit.joints[number][]>();
    for (const joint of kit.joints) pairs.set(joint.id, [...(pairs.get(joint.id) ?? []), joint]);
    for (const pair of pairs.values()) {
      expect(pair).toHaveLength(2);
      const slot = pair.find((feature) => feature.role === 'slot')!;
      const contact = pair.find((feature) => feature.role === 'tab')!;
      expect(slot.featureType).toBe('cut-slot');
      expect(contact.featureType).toBe('material-contact');
      expect(slot.frame).toEqual(contact.frame);
      const radial = slot.polygon.points.map(([x, y]) => x * Math.cos(slot.frame.angleRad) + y * Math.sin(slot.frame.angleRad));
      const tangential = slot.polygon.points.map(([x, y]) => -x * Math.sin(slot.frame.angleRad) + y * Math.cos(slot.frame.angleRad));
      expect(Math.min(...radial)).toBeCloseTo(slot.frame.radialMin, 10);
      expect(Math.max(...radial)).toBeCloseTo(slot.frame.radialMax, 10);
      expect(Math.max(...tangential) - Math.min(...tangential)).toBeCloseTo(slot.frame.tangentialWidth, 10);
      const zs = contact.polygon.points.map(([z]) => z), radii = contact.polygon.points.map(([, radius]) => radius);
      expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo(slot.frame.axialZ, 10);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(slot.frame.tangentialWidth, 10);
      expect(Math.min(...radii)).toBeCloseTo(slot.frame.radialMin, 10);
      expect(Math.max(...radii)).toBeCloseTo(slot.frame.radialMax, 10);
      expect(contact.polygon.points.every(([z, radius]) => radius <= radiusAt(profile, z) + 1e-10)).toBe(true);
      expect(kit.parts.find(({ id }) => id === slot.partId)!.holes).toContainEqual(slot.polygon);
    }
    const rib = kit.parts.find((part) => part.kind === 'rib')!;
    expect(rib.outline.points).toEqual(profile.samples.map(({ z, radius }) => [z, -radius]).concat([...profile.samples].reverse().map(({ z, radius }) => [z, radius])));
  });

  test('uses selected fit allowance exactly for concentric shaft clearance', () => {
    const allowances = { loose: 0.4, slip: 0.25, snug: 0.1, press: 0 } as const;
    const radii = (['press', 'snug', 'slip', 'loose'] as const).map((fit) => generateParts(profile, { thicknessMm: 3, fitAllowanceMm: allowances }, { ribCount: 4, ringLayers: 2, shaftMm: 3, fit }).parts.find((part) => part.kind === 'hub-layer')!.holeMetadata![0].radiusMm);
    expect(radii).toEqual([1.5, 1.55, 1.625, 1.7]);
  });

  test('connects both spacer instances on opposite hub sides in the assembly graph', () => {
    const kit = generateParts(profile, material, { ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const spacer = kit.parts.find((part) => part.kind === 'spacer')!;
    const edges = kit.assembly.filter((edge): edge is Extract<typeof edge, { kind: 'placement' }> => edge.kind === 'placement' && edge.partId === spacer.id);
    expect(edges.map((edge) => edge.instance).sort()).toEqual(['negative-z', 'positive-z']);
    expect(new Set(edges.map((edge) => edge.order)).size).toBe(2);
    for (const part of kit.parts.filter((part) => part.id !== kit.parts[0].id)) {
      expect(kit.assembly.some((edge) => edge.kind === 'joint' ? edge.fromPartId === part.id || edge.toPartId === part.id : edge.partId === part.id)).toBe(true);
    }
  });

  test('uses discriminated assembly edges with complete referential integrity', () => {
    const kit = generateParts(profile, material, { ribCount: 6, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const jointIds = new Set(kit.joints.map((joint) => joint.id));
    const placementIds = new Set<string>();
    for (const edge of kit.assembly) {
      if (edge.kind === 'joint') expect(jointIds.has(edge.jointId)).toBe(true);
      else {
        expect(edge).not.toHaveProperty('jointId');
        expect(placementIds.has(edge.placementId)).toBe(false);
        placementIds.add(edge.placementId);
      }
    }
  });

  test('detects deterministic content hash collisions instead of sharing IDs', () => {
    expect(() => generateParts(profile, material, { ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' }, { hasher: () => '0'.repeat(32) })).toThrowError(expect.objectContaining({ code: 'HASH_COLLISION' }));
  });
  test('adds two symmetric washer spacers only for multilayer rings without changing ideal balance', () => {
    const multi = generateParts(profile, material, { ribCount: 8, ringLayers: 3, shaftMm: 3, fit: 'snug' });
    const single = generateParts(profile, material, { ribCount: 8, ringLayers: 1, shaftMm: 3, fit: 'snug' });
    const spacers = multi.parts.filter((part) => part.kind === 'spacer');
    expect(spacers).toHaveLength(1);
    expect(spacers[0].quantity).toBe(2);
    expect(spacers[0].holes).toHaveLength(1);
    expect(spacers[0].holeMetadata?.[0]).toMatchObject({ purpose: 'shaft', center: [0, 0] });
    expect(single.parts.filter((part) => part.kind === 'spacer')).toHaveLength(0);
    expect(multi.estimatedBalance).toEqual(single.estimatedBalance);
  });

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
    expect(kit.assembly.filter((edge) => edge.kind === 'joint').every((edge) => grouped.has(edge.jointId))).toBe(true);
  });

  test('is deterministic, input-immutable, scale-aware, and changes IDs with options', () => {
    const deterministicMaterial: MaterialInput = { thicknessMm: 3, fitAllowanceMm: { loose: 0.3, slip: 0.2, snug: 0.1, press: 0 } };
    const snapshot = JSON.stringify({ profile, material: deterministicMaterial });
    const options = { ribCount: 8 as const, ringLayers: 3, shaftMm: 3, fit: 'snug' as const };
    const first = generateParts(profile, deterministicMaterial, options);
    const second = generateParts(profile, deterministicMaterial, options);
    expect(second).toEqual(first);
    expect(JSON.stringify({ profile, material: deterministicMaterial })).toBe(snapshot);
    const changed = generateParts(profile, deterministicMaterial, { ...options, fit: 'press' });
    expect(changed.parts.map((part) => part.id)).not.toEqual(first.parts.map((part) => part.id));
    const scaled = generateParts({ samples: profile.samples.map(({ z, radius }) => ({ z: z * 2, radius: radius * 2 })) }, { thicknessMm: 6, fitAllowanceMm: { loose: 0.6, slip: 0.4, snug: 0.2, press: 0 } }, { ...options, shaftMm: 6 });
    expect(Math.abs(area(scaled.parts[0].outline)) / Math.abs(area(first.parts[0].outline))).toBeCloseTo(4, 6);
  });

  test('scales every geometry dimension while preserving dimensionless balance state', () => {
    const options = { ribCount: 8 as const, ringLayers: 3, shaftMm: 3, fit: 'snug' as const };
    const base = generateParts(profile, material, options);
    const factor = 2.5;
    const scaled = generateParts(
      { samples: profile.samples.map(({ z, radius }) => ({ z: z * factor, radius: radius * factor })) },
      { thicknessMm: material.thicknessMm * factor, fitAllowanceMm: 0.1 * factor },
      { ...options, shaftMm: options.shaftMm * factor },
    );
    expect(scaled.parts.map((part) => part.kind)).toEqual(base.parts.map((part) => part.kind));
    base.parts.forEach((part, partIndex) => {
      const other = scaled.parts[partIndex];
      [part.outline, ...part.holes].forEach((polygon, polygonIndex) => {
        const otherPolygon = [other.outline, ...other.holes][polygonIndex];
        polygon.points.forEach((point, pointIndex) => {
          expect(otherPolygon.points[pointIndex][0]).toBeCloseTo(point[0] * factor, 10);
          expect(otherPolygon.points[pointIndex][1]).toBeCloseTo(point[1] * factor, 10);
        });
      });
      part.holeMetadata?.forEach((hole, index) => expect(other.holeMetadata?.[index].radiusMm).toBeCloseTo(hole.radiusMm * factor, 10));
    });
    base.joints.forEach((joint, index) => expect(scaled.joints[index].widthMm).toBeCloseTo(joint.widthMm * factor, 10));
    expect(scaled.estimatedBalance.status).toBe(base.estimatedBalance.status);
    expect(scaled.estimatedBalance.centroidOffsetMm).toBe(base.estimatedBalance.centroidOffsetMm * factor);
  });

  test('uses stable IDs derived only from each part relevant geometry and role', () => {
    const fitMap = { loose: 0.3, slip: 0.2, snug: 0.1, press: 0 } as const;
    const snug = generateParts(profile, { thicknessMm: 3, fitAllowanceMm: fitMap }, { ribCount: 8, ringLayers: 3, shaftMm: 3, fit: 'snug' });
    const press = generateParts(profile, { thicknessMm: 3, fitAllowanceMm: fitMap }, { ribCount: 8, ringLayers: 3, shaftMm: 3, fit: 'press' });
    for (const kind of ['hub-layer', 'rib', 'outer-ring'] as const) {
      expect(press.parts.filter((part) => part.kind === kind).map((part) => part.id)).not.toEqual(snug.parts.filter((part) => part.kind === kind).map((part) => part.id));
    }
    expect(press.parts.find((part) => part.kind === 'spacer')?.id).not.toBe(snug.parts.find((part) => part.kind === 'spacer')?.id);
    const fewer = generateParts(profile, { thicknessMm: 3, fitAllowanceMm: fitMap }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    expect(fewer.parts.filter((part) => part.kind === 'spacer').map((part) => part.id)).toEqual(snug.parts.filter((part) => part.kind === 'spacer').map((part) => part.id));
    expect(fewer.parts.filter((part) => part.kind === 'hub-layer').map((part) => part.id)).not.toEqual(snug.parts.filter((part) => part.kind === 'hub-layer').map((part) => part.id));
    expect(fewer.parts.filter((part) => part.kind === 'rib').map((part) => part.id)).not.toEqual(snug.parts.filter((part) => part.kind === 'rib').map((part) => part.id));
    expect(fewer.parts.filter((part) => part.kind === 'outer-ring').map((part) => part.id)).not.toEqual(snug.parts.filter((part) => part.kind === 'outer-ring').slice(0, 2).map((part) => part.id));
  });

  test('accepts zero-radius tips by deriving the hub from the central profile structure', () => {
    const pointed: LathedProfile = { samples: [{ z: -10, radius: 0 }, { z: 0, radius: 20 }, { z: 10, radius: 0 }] };
    expect(() => generateParts(pointed, material, { ribCount: 6, ringLayers: 2, shaftMm: 3, fit: 'snug' })).not.toThrow();
    expect(() => generateParts({ samples: [{ z: -1, radius: 0 }, { z: 1, radius: 0 }] }, material, { ribCount: 6, ringLayers: 2, shaftMm: 1, fit: 'snug' })).toThrowError(expect.objectContaining({ code: 'PROFILE' }));
  });

  test.each([
    [null, material, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'PROFILE'],
    [{ samples: null }, material, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'PROFILE'],
    [profile, null, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'MATERIAL'],
    [profile, { thicknessMm: 3, fitAllowanceMm: null }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'MATERIAL'],
    [profile, material, null, 'OPTIONS'],
    [profile, material, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'invalid' }, 'OPTIONS'],
    [profile, { thicknessMm: 3, fitAllowanceMm: { loose: 0, slip: 0, snug: 0 } }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'MATERIAL'],
    [profile, { thicknessMm: 3, fitAllowanceMm: { loose: 0, slip: 0, snug: 0, press: Infinity } }, { ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' }, 'MATERIAL'],
  ] as const)('never leaks TypeError for malformed unknown input %#', (badProfile, badMaterial, badOptions, code) => {
    expect(() => generateParts(badProfile as never, badMaterial as never, badOptions as never)).toThrowError(expect.objectContaining({ name: 'DecompositionError', code }));
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
  test('intersects triangle surfaces at every axial plane for a coarse frustum', () => {
    const positions: number[] = [];
    for (const [z, radius] of [[-10, 2], [10, 12]] as const) for (let segment = 0; segment < 16; segment += 1) {
      const angle = segment * Math.PI * 2 / 16;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
    const indices: number[] = [];
    for (let segment = 0; segment < 16; segment += 1) {
      const next = (segment + 1) % 16;
      indices.push(segment, next, 16 + segment, next, 16 + next, 16 + segment);
    }
    const sampled = sampleLathedProfile({ positions: new Float64Array(positions), indices: new Uint32Array(indices) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 64);
    expect(sampled.samples).toHaveLength(64);
    expect(sampled.samples[0].radius).toBeCloseTo(2, 6);
    expect(sampled.samples[32].radius).toBeCloseTo(2 + 10 * 32 / 63, 1);
    expect(sampled.samples[63].radius).toBeCloseTo(12, 6);
  });
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

  test.each([
    [null, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0, 1, 2]) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([0, 0, 0, 1, 0, 1]), indices: new Uint32Array([0, 1]) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([0, 0, 0, 1, 0, 1, NaN, 0, 2]), indices: new Uint32Array([0, 1, 2]) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([1, 0, 0, 2, 0, 0, 3, 0, 0]), indices: new Uint32Array([0, 1, 2]) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]), indices: new Uint32Array([0, 1, 2]) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: false }, 3],
    [{ positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]), indices: new Uint32Array([0, 1, 2]) }, { origin: [NaN, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]), indices: new Uint32Array([0, 1, 2]) }, { origin: [0, 0, 0], direction: [0, 0, 0], confidence: 1, confirmed: true }, 3],
    [{ positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]), indices: new Uint32Array([0, 1, 2]) }, { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true }, 1],
  ] as const)('returns typed PROFILE errors for malformed sampler input %#', (mesh, axis, bins) => {
    expect(() => sampleLathedProfile(mesh as never, axis as never, bins)).toThrowError(expect.objectContaining({ name: 'DecompositionError', code: 'PROFILE' }));
  });
});

function radiusAt(input: LathedProfile, z: number): number {
  if (z <= input.samples[0].z) return input.samples[0].radius;
  for (let index = 1; index < input.samples.length; index += 1) {
    const right = input.samples[index], left = input.samples[index - 1];
    if (z <= right.z) return left.radius + (right.radius - left.radius) * (z - left.z) / (right.z - left.z);
  }
  return input.samples.at(-1)!.radius;
}
