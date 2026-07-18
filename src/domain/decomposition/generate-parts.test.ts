import { describe, expect, test } from 'vitest';
import { generateParts } from './generate-parts';
import { sampleLathedProfile } from './profile-sampler';
import type { LathedProfile, MaterialInput, Polygon2 } from './types';
import type { TriangleMesh } from '../mesh/types';
import type { Axis } from '../types';
import { isSimplePolygon } from './polygon-validation';
import * as polygonValidation from './polygon-validation';
import { minimumRadiusOverInterval } from './profile-geometry';

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

function pointInPolygon(polygon: Polygon2, point: readonly [number, number]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.points.length - 1; index < polygon.points.length; previous = index++) {
    const a = polygon.points[index], b = polygon.points[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function partContains(part: { readonly outline: Polygon2; readonly holes: readonly Polygon2[] }, point: readonly [number, number]): boolean {
  return pointInPolygon(part.outline, point) && part.holes.every((hole) => !pointInPolygon(hole, point));
}

function hasConcaveVertex(polygon: Polygon2): boolean {
  const sign = Math.sign(area(polygon));
  return polygon.points.some((point, index, points) => {
    const before = points[(index + points.length - 1) % points.length], after = points[(index + 1) % points.length];
    return sign * ((point[0] - before[0]) * (after[1] - point[1]) - (point[1] - before[1]) * (after[0] - point[0])) < -1e-10;
  });
}

const confirmedAxis: Axis = { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true };

function lathedSurface(samples: LathedProfile['samples'], segments = 32): TriangleMesh {
  const positions: number[] = [];
  for (const { z, radius } of samples) for (let segment = 0; segment < segments; segment += 1) {
    const angle = segment * Math.PI * 2 / segments;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
  }
  const indices: number[] = [];
  for (let ring = 0; ring + 1 < samples.length; ring += 1) for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    const a = ring * segments + segment, b = ring * segments + next, c = (ring + 1) * segments + segment, d = (ring + 1) * segments + next;
    indices.push(a, b, c, b, d, c);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function regularPolygon(radius: number, segments = 32, clockwise = false): Polygon2 {
  return { points: Array.from({ length: segments }, (_, index) => {
    const angle = (clockwise ? -1 : 1) * index * Math.PI * 2 / segments;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  }) };
}

function radialFeature(center: number, width: number, depth: number, angle: number): Polygon2 {
  const local = [[center - depth / 2, -width / 2], [center + depth / 2, -width / 2], [center + depth / 2, width / 2], [center - depth / 2, width / 2]] as const;
  return { points: local.map(([radial, tangential]) => [radial * Math.cos(angle) - tangential * Math.sin(angle), radial * Math.sin(angle) + tangential * Math.cos(angle)] as const) };
}

describe('generateParts', () => {
  test('hashes actual geometry, instance placement, and complete joint frames with collision guards', () => {
    const options = { ribCount: 4 as const, ringLayers: 3, shaftMm: 3, fit: 'snug' as const };
    const kit = generateParts(profile, material, options);
    for (const joint of kit.joints) expect(joint.frame).toMatchObject({ materialThicknessMm: 3, fitAllowanceMm: 0.1 });
    const ids = [
      ...kit.parts.map(({ id }) => id),
      ...kit.instances.map(({ id }) => id),
      ...new Set(kit.joints.map(({ id }) => id)),
      ...kit.assembly.filter((edge) => edge.kind === 'placement').map(({ placementId }) => placementId),
    ];
    expect(ids.every((id) => /[0-9a-f]{32}$/i.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const selectiveHasher = (token: string) => {
      const values = new Map<string, string>(); let counter = 1;
      return (payload: string): string => {
        if (payload.includes(token)) return '0'.repeat(32);
        let value = values.get(payload);
        if (!value) { value = (counter++).toString(16).padStart(32, '0'); values.set(payload, value); }
        return value;
      };
    };
    expect(() => generateParts(profile, material, options, { hasher: selectiveHasher('"placement":') })).toThrowError(expect.objectContaining({ code: 'HASH_COLLISION' }));
    expect(() => generateParts(profile, material, options, { hasher: selectiveHasher('"frame":') })).toThrowError(expect.objectContaining({ code: 'HASH_COLLISION' }));
  });

  test.each([1e-6, 1e6])('preserves complete notch, joint, and instance similarity at scale %g', (factor) => {
    const options = { ribCount: 6 as const, ringLayers: 3, shaftMm: 3, fit: 'snug' as const };
    const base = generateParts(profile, material, options);
    const scaled = generateParts(
      { samples: profile.samples.map(({ z, radius }) => ({ z: z * factor, radius: radius * factor })) },
      { thicknessMm: material.thicknessMm * factor, fitAllowanceMm: 0.1 * factor },
      { ...options, shaftMm: options.shaftMm * factor },
    );
    const expectScaled = (actual: number, expected: number): void => expect(Math.abs(actual / factor - expected)).toBeLessThanOrEqual(Math.max(1e-10, Math.abs(expected) * 1e-10));
    expect(scaled.parts.map(({ kind, quantity }) => ({ kind, quantity }))).toEqual(base.parts.map(({ kind, quantity }) => ({ kind, quantity })));
    base.parts.forEach((part, partIndex) => {
      const other = scaled.parts[partIndex];
      [part.outline, ...part.holes].forEach((polygon, polygonIndex) => polygon.points.forEach((point, pointIndex) => {
        const actual = [other.outline, ...other.holes][polygonIndex].points[pointIndex];
        expectScaled(actual[0], point[0]); expectScaled(actual[1], point[1]);
      }));
    });
    expect(scaled.instances).toHaveLength(base.instances.length);
    base.instances.forEach((instance, index) => {
      expectScaled(scaled.instances[index].axialZ, instance.axialZ);
      expect(scaled.instances[index].angleRad).toBe(instance.angleRad);
    });
    base.joints.forEach((joint, index) => {
      const other = scaled.joints[index];
      expect(other.role).toBe(joint.role); expect(other.featureType).toBe(joint.featureType);
      expectScaled(other.widthMm, joint.widthMm); expectScaled(other.depthMm, joint.depthMm);
      expectScaled(other.frame.axialZ, joint.frame.axialZ); expectScaled(other.frame.radialMin, joint.frame.radialMin); expectScaled(other.frame.radialMax, joint.frame.radialMax); expectScaled(other.frame.tangentialWidth, joint.frame.tangentialWidth);
      expect(other.frame.angleRad).toBeCloseTo(joint.frame.angleRad, 12);
    });
    expect(scaled.assembly.map(({ kind, order }) => ({ kind, order }))).toEqual(base.assembly.map(({ kind, order }) => ({ kind, order })));
  });

  test('resolves every physical hub layer and spacer through stable assembly instances', () => {
    const options = { ribCount: 4 as const, ringLayers: 3, shaftMm: 3, fit: 'snug' as const };
    const kit = generateParts(profile, material, options);
    expect(kit).toHaveProperty('instances');
    const instances = (kit as typeof kit & { instances: readonly { id: string; partId: string; axialZ: number; angleRad?: number }[] }).instances;
    const partIds = new Set(kit.parts.map(({ id }) => id));
    const instanceIds = new Set(instances.map(({ id }) => id));
    expect(instanceIds.size).toBe(instances.length);
    expect(instances.every(({ partId }) => partIds.has(partId))).toBe(true);
    const hub = kit.parts.find((part) => part.kind === 'hub-layer')!;
    const hubInstances = instances.filter(({ partId }) => partId === hub.id);
    expect(hub.quantity).toBe(3);
    expect(hubInstances).toHaveLength(3);
    expect(new Set(hubInstances.map(({ axialZ }) => axialZ)).size).toBe(3);
    for (const hubInstance of hubInstances) {
      expect(kit.joints.filter((joint) => (joint as typeof joint & { partInstanceId?: string }).partInstanceId === hubInstance.id)).toHaveLength(options.ribCount);
      expect(kit.assembly.some((edge) => edge.kind === 'joint' && (edge as typeof edge & { fromInstanceId?: string }).fromInstanceId === hubInstance.id)).toBe(true);
    }
    for (const joint of kit.joints as readonly (typeof kit.joints[number] & { partInstanceId: string; mateInstanceId: string })[]) {
      expect(instanceIds.has(joint.partInstanceId)).toBe(true);
      expect(instanceIds.has(joint.mateInstanceId)).toBe(true);
    }
    const spacer = kit.parts.find((part) => part.kind === 'spacer')!;
    const spacerInstances = instances.filter(({ partId }) => partId === spacer.id).sort((left, right) => left.axialZ - right.axialZ);
    expect(spacerInstances).toHaveLength(2);
    expect(spacerInstances[0].axialZ).toBeLessThan(Math.min(...hubInstances.map(({ axialZ }) => axialZ)));
    expect(spacerInstances[1].axialZ).toBeGreaterThan(Math.max(...hubInstances.map(({ axialZ }) => axialZ)));
    const placements = kit.assembly.filter((edge) => edge.kind === 'placement') as readonly (Extract<typeof kit.assembly[number], { kind: 'placement' }> & { partInstanceId: string; relativeToInstanceId: string })[];
    expect(new Set(placements.map(({ partInstanceId }) => partInstanceId))).toEqual(new Set(spacerInstances.map(({ id }) => id)));
    expect(placements.every(({ relativeToInstanceId }) => hubInstances.some(({ id }) => id === relativeToInstanceId))).toBe(true);
    expect(generateParts(profile, material, options)).toEqual(kit);
  });

  test.each([
    [3, 'press', 1.5],
    [3, 'snug', 1.55],
    [20, 'press', 10],
  ] as const)('cuts a %s mm %s shaft polygon whose inradius is the physical target', (shaftMm, fit, target) => {
    const allowances = { loose: 0.4, slip: 0.25, snug: 0.1, press: 0 } as const;
    const largeProfile: LathedProfile = { samples: [{ z: -100, radius: 80 }, { z: 0, radius: 100 }, { z: 100, radius: 80 }] };
    const kit = generateParts(largeProfile, { thicknessMm: 3, fitAllowanceMm: allowances }, { ribCount: 4, ringLayers: 1, shaftMm, fit });
    const hub = kit.parts.find((part) => part.kind === 'hub-layer')!;
    const hole = hub.holes[hub.holeMetadata![0].polygonIndex];
    const edgeDistance = (a: readonly [number, number], b: readonly [number, number]): number => Math.abs(a[0] * b[1] - a[1] * b[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    const inradius = Math.min(...hole.points.map((point, index) => edgeDistance(point, hole.points[(index + 1) % hole.points.length])));
    const circumradius = Math.max(...hole.points.map(([x, y]) => Math.hypot(x, y)));
    expect(hub.holeMetadata![0].radiusMm).toBe(target);
    expect(inradius).toBeCloseTo(target, 12);
    expect(circumradius).toBeCloseTo(target / Math.cos(Math.PI / hole.points.length), 12);
  });

  test('validates notch edges against actual polygon support and complete inner-hole segments', () => {
    expect('validateOpenRadialNotches' in polygonValidation).toBe(true);
    if (!('validateOpenRadialNotches' in polygonValidation)) return;
    const validateNotches = polygonValidation.validateOpenRadialNotches as (cuts: readonly Polygon2[], support: Polygon2, holes: readonly Polygon2[], margin: number) => boolean;
    const midpointHoleBreach = radialFeature(2.169319, 0.6, 0.16, 0);
    expect(validateNotches([midpointHoleBreach], regularPolygon(2.29, 32), [regularPolygon(2.09, 32, true)], 0.001)).toBe(false);
    const oldHubCut = radialFeature(34.6466, 3.1, 2.4, Math.PI / 3);
    expect(validateNotches([oldHubCut], regularPolygon(36, 32), [regularPolygon(1.55, 32, true)], 0.06)).toBe(false);
    expect(() => generateParts({ samples: [{ z: -20, radius: 2.3 }, { z: 20, radius: 2.3 }] }, { thicknessMm: 0.2, fitAllowanceMm: 0.4 }, { ribCount: 4, ringLayers: 1, shaftMm: 0.02, fit: 'snug' })).not.toThrow();
    expect(() => generateParts({ samples: [{ z: -135, radius: 90 }, { z: 135, radius: 90 }] }, material, { ribCount: 6, ringLayers: 1, shaftMm: 3, fit: 'snug' })).not.toThrow();
  });

  test.each([4, 6, 8, 10, 12] as const)('builds %i unique positive-radius spokes clear of the shaft', (ribCount) => {
    const kit = generateParts(profile, material, { ribCount, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const ribs = kit.parts.filter((part) => part.kind === 'rib');
    const shaftRadius = kit.parts.find((part) => part.kind === 'hub-layer')!.holeMetadata![0].radiusMm;
    expect(ribs).toHaveLength(ribCount);
    const representative = ribs.map((rib) => {
      const minimumRadius = Math.min(...rib.outline.points.map(([, radius]) => radius));
      expect(minimumRadius).toBeGreaterThan(shaftRadius);
      expect(rib.outline.points.every(([, radius]) => radius >= minimumRadius)).toBe(true);
      const radius = Math.max(...rib.outline.points.map(([, value]) => value));
      return [radius * Math.cos(rib.angleRad!), radius * Math.sin(rib.angleRad!)] as const;
    });
    expect(new Set(ribs.map((rib) => rib.angleRad)).size).toBe(ribCount);
    expect(new Set(representative.map(([x, y]) => `${Math.round(x * 1e9)},${Math.round(y * 1e9)}`)).size).toBe(ribCount);
    for (let index = 0; index < ribCount / 2; index += 1) {
      const opposite = index + ribCount / 2;
      expect(representative[index][0]).toBeCloseTo(-representative[opposite][0], 10);
      expect(representative[index][1]).toBeCloseTo(-representative[opposite][1], 10);
      expect(representative[index]).not.toEqual(representative[opposite]);
    }
  });

  test('cuts real complementary open notches with no positive-area plate/rib collision', () => {
    const thickness = 3;
    const kit = generateParts(profile, { thicknessMm: thickness, fitAllowanceMm: 0.1 }, { ribCount: 4, ringLayers: 1, shaftMm: 3, fit: 'snug' });
    const plates = kit.parts.filter((part) => part.kind === 'hub-layer' || part.kind === 'outer-ring');
    expect(plates).toHaveLength(2);
    for (const plate of plates) {
      expect(plate.holes).toHaveLength(1);
      expect(isSimplePolygon(plate.outline)).toBe(true);
      expect(area(plate.outline)).toBeGreaterThan(0);
      expect(hasConcaveVertex(plate.outline)).toBe(true);
    }
    const grouped = new Map<string, typeof kit.joints>();
    for (const feature of kit.joints) grouped.set(feature.id, [...(grouped.get(feature.id) ?? []), feature]);
    for (const pair of grouped.values()) {
      const plateFeature = pair.find(({ role }) => role === 'slot')!;
      const ribFeature = pair.find(({ role }) => role === 'tab')!;
      const plate = kit.parts.find(({ id }) => id === plateFeature.partId)!;
      const rib = kit.parts.find(({ id }) => id === ribFeature.partId)!;
      expect(plate.holes).not.toContainEqual(plateFeature.polygon);
      expect(plateFeature.featureType).toBe('open-notch');
      expect(ribFeature.featureType).toBe('material-contact');
      expect(isSimplePolygon(rib.outline)).toBe(true);
      const frame = plateFeature.frame;
      const radialLimit = Math.max(...plate.outline.points.map(([x, y]) => Math.hypot(x, y)));
      for (let axialStep = 1; axialStep < 8; axialStep += 1) {
        const z = frame.axialZ - thickness / 2 + thickness * axialStep / 8;
        for (let radialStep = 1; radialStep < 96; radialStep += 1) {
          const radius = radialLimit * radialStep / 96;
          const platePoint = [radius * Math.cos(frame.angleRad), radius * Math.sin(frame.angleRad)] as const;
          expect(partContains(plate, platePoint) && pointInPolygon(rib.outline, [z, radius])).toBe(false);
        }
      }
    }
    for (const [z, radius] of [[-4, 4.25162], [4, 15.50410]] as const) {
      const pair = [...grouped.values()].find((features) => Math.abs(features[0].frame.axialZ - z) < 1e-9)!;
      const plateFeature = pair.find(({ role }) => role === 'slot')!;
      const ribFeature = pair.find(({ role }) => role === 'tab')!;
      const plate = kit.parts.find(({ id }) => id === plateFeature.partId)!;
      const rib = kit.parts.find(({ id }) => id === ribFeature.partId)!;
      const point = [radius * Math.cos(plateFeature.frame.angleRad), radius * Math.sin(plateFeature.frame.angleRad)] as const;
      expect(partContains(plate, point) && pointInPolygon(rib.outline, [z, radius])).toBe(false);
    }
  });

  test('honours a narrow inward notch anywhere inside a contact interval', () => {
    const notched: LathedProfile = { samples: [
      { z: -12, radius: 9 }, { z: 0, radius: 24 }, { z: 4.6, radius: 20 },
      { z: 4.7, radius: 4 }, { z: 4.8, radius: 20 }, { z: 12, radius: 9 },
    ] };
    const kit = generateParts(notched, material, { ribCount: 4, ringLayers: 1, shaftMm: 3, fit: 'snug' });
    const ring = kit.parts.find((part) => part.kind === 'outer-ring')!;
    expect(Math.max(...ring.outline.points.map(([x, y]) => Math.hypot(x, y)))).toBeLessThan(4);
  });
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
    }
    expect(leftRib.outline.points.every(([, radius]) => radius > 0)).toBe(true);
  });

  test('maps cut slots and in-material rib contacts to one shared mating frame', () => {
    const kit = generateParts(profile, material, { ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const pairs = new Map<string, typeof kit.joints[number][]>();
    for (const joint of kit.joints) pairs.set(joint.id, [...(pairs.get(joint.id) ?? []), joint]);
    for (const pair of pairs.values()) {
      expect(pair).toHaveLength(2);
      const slot = pair.find((feature) => feature.role === 'slot')!;
      const contact = pair.find((feature) => feature.role === 'tab')!;
      const ribPart = kit.parts.find(({ id }) => id === contact.partId)!;
      expect(slot.featureType).toBe('open-notch');
      expect(contact.featureType).toBe('material-contact');
      expect(slot.frame).toEqual(contact.frame);
      const radial = slot.polygon.points.map(([x, y]) => x * Math.cos(slot.frame.angleRad) + y * Math.sin(slot.frame.angleRad));
      const tangential = slot.polygon.points.map(([x, y]) => -x * Math.sin(slot.frame.angleRad) + y * Math.cos(slot.frame.angleRad));
      expect(Math.min(...radial)).toBeCloseTo(slot.frame.radialMin, 10);
      expect(Math.max(...radial)).toBeGreaterThan(slot.frame.radialMax);
      expect(Math.max(...tangential) - Math.min(...tangential)).toBeCloseTo(slot.frame.tangentialWidth, 10);
      const zs = contact.polygon.points.map(([z]) => z), radii = contact.polygon.points.map(([, radius]) => radius);
      expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo(slot.frame.axialZ, 10);
      expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(slot.frame.tangentialWidth, 10);
      expect(Math.min(...radii)).toBeCloseTo(slot.frame.radialMin, 10);
      expect(Math.max(...radii)).toBeCloseTo(slot.frame.radialMax, 10);
      expect(contact.polygon.points.every(([z, radius]) => radius <= radiusAt(profile, z) + 1e-10)).toBe(true);
      expect(kit.parts.find(({ id }) => id === slot.partId)!.holes).not.toContainEqual(slot.polygon);
      expect(contact.polygon.points.every((point) => ribPart.outline.points.some((candidate) => candidate[0] === point[0] && candidate[1] === point[1]))).toBe(true);
    }
    const rib = kit.parts.find((part) => part.kind === 'rib')!;
    expect(polygonValidation.isSimpleXMonotonePolygon(rib.outline)).toBe(true);
    expect(Math.min(...rib.outline.points.map(([, radius]) => radius))).toBeGreaterThan(1.55);
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
    expect(fewer.parts.filter((part) => part.kind === 'hub-layer').map((part) => part.id)).toEqual(snug.parts.filter((part) => part.kind === 'hub-layer').map((part) => part.id));
    expect(fewer.instances.filter((instance) => fewer.parts.find(({ id }) => id === instance.partId)?.kind === 'hub-layer').map(({ id }) => id)).not.toEqual(snug.instances.filter((instance) => snug.parts.find(({ id }) => id === instance.partId)?.kind === 'hub-layer').map(({ id }) => id));
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

describe('minimumRadiusOverInterval', () => {
  test('includes interpolated endpoints and every interior profile sample without mutation', () => {
    const input: LathedProfile = { samples: [{ z: 0, radius: 10 }, { z: 2, radius: 3 }, { z: 4, radius: 8 }, { z: 6, radius: 6 }] };
    const snapshot = JSON.stringify(input);
    expect(minimumRadiusOverInterval(input, 1, 5)).toBe(3);
    expect(minimumRadiusOverInterval(input, 3, 5)).toBe(5.5);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test.each([[3, 2], [-13, 2], [2, 13]] as const)('rejects invalid interval [%s,%s]', (z0, z1) => {
    expect(() => minimumRadiusOverInterval(profile, z0, z1)).toThrowError(expect.objectContaining({ code: 'PROFILE' }));
  });
});

describe('sampleLathedProfile', () => {
  test('derives its domain only from finite nondegenerate referenced triangles', () => {
    const base = lathedSurface([{ z: -1, radius: 2 }, { z: 1, radius: 3 }], 8);
    const positions = new Float64Array(base.positions.length + 6);
    positions.set(base.positions);
    positions.set([0, 0, 1e9, NaN, NaN, NaN], base.positions.length);
    expect(sampleLathedProfile({ positions, indices: base.indices }, confirmedAxis, 5)).toEqual(sampleLathedProfile(base, confirmedAxis, 5));
    const collinear: TriangleMesh = { positions: new Float64Array([1, 0, -1, 2, 0, 0, 3, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
    expect(() => sampleLathedProfile(collinear, confirmedAxis, 5)).toThrowError(expect.objectContaining({ code: 'PROFILE' }));
    const repeated: TriangleMesh = { positions: new Float64Array([1, 0, -1, 2, 0, 1]), indices: new Uint32Array([0, 0, 1]) };
    expect(() => sampleLathedProfile(repeated, confirmedAxis, 5)).toThrowError(expect.objectContaining({ code: 'PROFILE' }));
  });

  test('includes valid vertex planes so a narrow inward surface notch cannot be skipped', () => {
    const narrow: LathedProfile = { samples: [
      { z: -12, radius: 20 }, { z: 4.6, radius: 20 }, { z: 4.7, radius: 1 }, { z: 4.8, radius: 20 }, { z: 12, radius: 20 },
    ] };
    const sampled = sampleLathedProfile(lathedSurface(narrow.samples), confirmedAxis, 64);
    expect(sampled.samples.length).toBeLessThanOrEqual(4096);
    expect(sampled.samples.some(({ z, radius }) => Math.abs(z - 4.7) < 1e-12 && radius < 1.01)).toBe(true);
    expect(() => generateParts(sampled, material, { ribCount: 4, ringLayers: 1, shaftMm: 3, fit: 'snug' })).toThrowError(expect.objectContaining({ code: 'JOINT' }));
  });

  test('is invariant when the axis origin is translated by 1e16 along its direction', () => {
    const mesh = lathedSurface([{ z: -2, radius: 3 }, { z: 0, radius: 4 }, { z: 2, radius: 3 }], 16);
    const base = sampleLathedProfile(mesh, confirmedAxis, 9);
    const shifted = sampleLathedProfile(mesh, { ...confirmedAxis, origin: [0, 0, 1e16] }, 9);
    expect(shifted.samples).toEqual(base.samples);
  });

  test('reports bounded triangle-plane intersection work and rejects over-budget workloads', () => {
    const spanningTriangles = (count: number): TriangleMesh => {
      const positions = new Float64Array(count * 9), indices = new Uint32Array(count * 3);
      for (let triangle = 0; triangle < count; triangle += 1) {
        const offset = triangle * 9, vertex = triangle * 3, angle = triangle * Math.PI * 2 / count;
        positions.set([2 * Math.cos(angle), 2 * Math.sin(angle), -1, 3 * Math.cos(angle), 3 * Math.sin(angle), 1, 2.5 * Math.cos(angle + 0.01), 2.5 * Math.sin(angle + 0.01), 0], offset);
        indices.set([vertex, vertex + 1, vertex + 2], triangle * 3);
      }
      return { positions, indices };
    };
    let work = -1;
    sampleLathedProfile(spanningTriangles(10_000), confirmedAxis, 64, { onStats: (stats: { intersectionWork: number }) => { work = stats.intersectionWork; } } as never);
    expect(work).toBeGreaterThan(0);
    expect(work).toBeLessThanOrEqual(2_000_000);
    expect(() => sampleLathedProfile(spanningTriangles(50_000), confirmedAxis, 64)).toThrowError(expect.objectContaining({ code: 'PROFILE' }));
  });

  test('provides a linear x-monotone validator for large rib silhouettes', () => {
    expect('isSimpleXMonotonePolygon' in polygonValidation).toBe(true);
    const points: [number, number][] = [];
    for (let index = 0; index < 10_000; index += 1) points.push([index, 1]);
    for (let index = 9_999; index >= 0; index -= 1) points.push([index, 2]);
    const validator = (polygonValidation as unknown as { isSimpleXMonotonePolygon(value: Polygon2): boolean }).isSimpleXMonotonePolygon;
    expect(validator({ points })).toBe(true);
    expect(validator({ points: [[0, 0], [1, 2], [2, 0], [2, 3], [1, 1], [0, 3]] })).toBe(false);
    const simpleNotch: Polygon2 = { points: [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]] };
    for (const factor of [1e-6, 1, 1e6]) expect(isSimplePolygon({ points: simpleNotch.points.map(([x, y]) => [x * factor, y * factor]) })).toBe(true);
  });

  test('keeps a 10k-sample full kit on the linear rib-validation path', () => {
    const samples = Array.from({ length: 10_000 }, (_, index) => {
      const z = -100 + 200 * index / 9_999;
      return { z, radius: 80 + 20 * (1 - (z / 100) ** 2) };
    });
    const started = performance.now();
    const kit = generateParts({ samples }, material, { ribCount: 12, ringLayers: 3, shaftMm: 3, fit: 'snug' });
    const elapsed = performance.now() - started;
    const rib = kit.parts.find((part) => part.kind === 'rib')!;
    expect(polygonValidation.isSimpleXMonotonePolygon(rib.outline)).toBe(true);
    expect(rib.outline.points.length).toBeLessThan(samples.length + 100);
    expect(elapsed).toBeLessThan(1500);
  });

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
