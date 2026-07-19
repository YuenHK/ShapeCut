import { describe, expect, test } from 'vitest';
import { validateAssemblyCollisions } from './assembly-collisions';
import { generateParts } from './generate-parts';
import type { Part2D, PartInstance, Point2, Polygon2, SpinnerKit } from './types';

const profile = {
  samples: [
    { z: -12, radius: 9 }, { z: -6, radius: 18 }, { z: 0, radius: 24 },
    { z: 6, radius: 18 }, { z: 12, radius: 9 },
  ],
};
const material = { thicknessMm: 3, fitAllowanceMm: 0.1 };

function pointInPolygon(polygon: Polygon2, point: Point2): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.points.length - 1; index < polygon.points.length; previous = index++) {
    const a = polygon.points[index], b = polygon.points[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function partContains(part: Part2D, point: Point2): boolean {
  return pointInPolygon(part.outline, point) && part.holes.every((hole) => !pointInPolygon(hole, point));
}

function ribSolidContains(part: Part2D, instance: PartInstance, point: readonly [number, number, number], thickness: number): boolean {
  const angle = instance.angleRad ?? 0, cosine = Math.cos(angle), sine = Math.sin(angle);
  const radial = point[0] * cosine + point[1] * sine;
  const tangential = -point[0] * sine + point[1] * cosine;
  return Math.abs(tangential) < thickness / 2 && pointInPolygon(part.outline, [point[2], radial]);
}

function horizontalSolidContains(part: Part2D, instance: PartInstance, point: readonly [number, number, number], thickness: number): boolean {
  return Math.abs(point[2] - instance.axialZ) < thickness / 2 && partContains(part, [point[0], point[1]]);
}

function partAndInstance(kit: SpinnerKit, instance: PartInstance): Part2D {
  return kit.parts.find(({ id }) => id === instance.partId)!;
}

function circle(radius: number, clockwise = false, segments = 32, phase = 0): Polygon2 {
  return { points: Array.from({ length: segments }, (_, index) => {
    const angle = phase + (clockwise ? -1 : 1) * index * Math.PI * 2 / segments;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  }) };
}

function scanlineInterval(polygon: Polygon2, axialZ: number): readonly [number, number] | undefined {
  const crossings: number[] = [];
  for (let index = 0; index < polygon.points.length; index += 1) {
    const a = polygon.points[index], b = polygon.points[(index + 1) % polygon.points.length];
    if ((a[0] <= axialZ && axialZ < b[0]) || (b[0] <= axialZ && axialZ < a[0])) {
      crossings.push(a[1] + (b[1] - a[1]) * (axialZ - a[0]) / (b[0] - a[0]));
    }
  }
  crossings.sort((left, right) => left - right);
  return crossings.length >= 2 ? [crossings[0], crossings.at(-1)!] : undefined;
}

function adjacentRibWitness(kit: SpinnerKit, thickness: number): readonly [number, number, number] | undefined {
  const ribInstances = kit.instances.filter((instance) => partAndInstance(kit, instance).kind === 'rib').sort((left, right) => (left.angleRad ?? 0) - (right.angleRad ?? 0));
  const first = ribInstances[0], second = ribInstances[1];
  const firstPart = partAndInstance(kit, first), secondPart = partAndInstance(kit, second);
  const delta = (second.angleRad ?? 0) - (first.angleRad ?? 0), half = delta / 2;
  const interval = scanlineInterval(firstPart.outline, 0);
  if (!interval) return undefined;
  const radial = interval[0] + Math.max(1e-9, thickness * 1e-9);
  const distance = radial / Math.cos(half);
  if (distance * Math.sin(half) >= thickness / 2) return undefined;
  const angle = (first.angleRad ?? 0) + half;
  const witness = [distance * Math.cos(angle), distance * Math.sin(angle), 0] as const;
  return ribSolidContains(firstPart, first, witness, thickness) && ribSolidContains(secondPart, second, witness, thickness) ? witness : undefined;
}

describe('assembly collision review regressions', () => {
  test.each([4, 6, 8, 10, 12] as const)('has no positive-volume adjacent-rib slab witness for N=%i', (ribCount) => {
    const kit = generateParts(profile, material, { splitPositionPercent: 40, ribCount, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    expect(adjacentRibWitness(kit, material.thicknessMm)).toBeUndefined();
    const ribInner = Math.min(...kit.parts.find((part) => part.kind === 'rib')!.outline.points.map(([, radial]) => radial));
    const hub = kit.parts.find((part) => part.kind === 'hub-layer')!;
    const shaftCircumradius = Math.max(...hub.holes[hub.holeMetadata![0].polygonIndex].points.map(([x, y]) => Math.hypot(x, y)));
    const spacerOuter = Math.max(...kit.parts.find((part) => part.kind === 'spacer')!.outline.points.map(([x, y]) => Math.hypot(x, y)));
    const structuralMargin = 3 * 0.02;
    expect(ribInner).toBeGreaterThanOrEqual(Math.max(
      shaftCircumradius,
      spacerOuter,
      3 / 2 / Math.tan(Math.PI / ribCount),
    ) + structuralMargin - 1e-12);
  });

  test('removes the review N=8 adjacent-rib witness from both actual 3D solids', () => {
    const kit = generateParts(profile, material, { splitPositionPercent: 40, ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const ribs = kit.instances.filter((instance) => partAndInstance(kit, instance).kind === 'rib').sort((left, right) => (left.angleRad ?? 0) - (right.angleRad ?? 0));
    const witness = [1.847759, 0.765367, 0] as const;
    expect(ribSolidContains(partAndInstance(kit, ribs[0]), ribs[0], witness, 3)
      && ribSolidContains(partAndInstance(kit, ribs[1]), ribs[1], witness, 3)).toBe(false);
  });

  test('keeps both multilayer spacer solids radially clear of every rib', () => {
    const kit = generateParts(profile, material, { splitPositionPercent: 40, ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const rib = kit.instances.find((instance) => partAndInstance(kit, instance).kind === 'rib' && instance.angleRad === 0)!;
    const ribPart = partAndInstance(kit, rib);
    const spacers = kit.instances.filter((instance) => partAndInstance(kit, instance).kind === 'spacer');
    expect(spacers).toHaveLength(2);
    for (const spacer of spacers) {
      const spacerPart = partAndInstance(kit, spacer), witness = [2, 0, spacer.axialZ] as const;
      expect(ribSolidContains(ribPart, rib, witness, 3) && horizontalSolidContains(spacerPart, spacer, witness, 3)).toBe(false);
    }
    const stack = kit.instances.filter((instance) => {
      const kind = partAndInstance(kit, instance).kind;
      return kind === 'hub-layer' || kind === 'outer-ring';
    });
    for (const spacer of spacers) for (const plate of stack) {
      expect(Math.abs(spacer.axialZ - plate.axialZ)).toBeGreaterThanOrEqual(3 - 1e-12);
    }
  });

  test('rejects the exact necked spacer/ring witness when radial clearance leaves no ring tab', () => {
    const necked = { samples: [{ z: -12, radius: 10 }, { z: -8, radius: 24 }, { z: -3, radius: 5 }, { z: 12, radius: 5 }] };
    expect(() => generateParts(necked, material, { splitPositionPercent: 40, ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' }))
      .toThrowError(expect.objectContaining({ code: 'JOINT' }));
  });

  test('runs the production analytic collision audit and identifies both colliding instances', () => {
    const auditProfile = { samples: [{ z: -12, radius: 10 }, { z: -8, radius: 24 }, { z: -3, radius: 7 }, { z: 12, radius: 7 }] };
    const kit = generateParts(auditProfile, material, { splitPositionPercent: 40, ribCount: 4, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    expect(() => validateAssemblyCollisions(kit, material, auditProfile)).not.toThrow();

    const spacer = kit.instances.find((instance) => partAndInstance(kit, instance).kind === 'spacer')!;
    const ring = kit.instances.find((instance) => partAndInstance(kit, instance).kind === 'outer-ring')!;
    const colliding = {
      ...kit,
      instances: kit.instances.map((instance) => instance.id === spacer.id ? { ...instance, axialZ: ring.axialZ } : instance),
    };
    expect(() => validateAssemblyCollisions(colliding, material, auditProfile)).toThrowError(expect.objectContaining({
      code: 'JOINT',
      message: expect.stringContaining(spacer.id),
    }));
    try {
      validateAssemblyCollisions(colliding, material, auditProfile);
    } catch (error) {
      expect((error as Error).message).toContain(ring.id);
    }
  });

  test('audit catches injected adjacent-rib and joint-corridor review collisions with instance IDs', () => {
    const kit = generateParts(profile, material, { splitPositionPercent: 40, ribCount: 8, ringLayers: 2, shaftMm: 3, fit: 'snug' });
    const ribs = kit.instances.filter((instance) => partAndInstance(kit, instance).kind === 'rib');
    const oldReviewOutline: Polygon2 = { points: [[-1, 1.611869], [1, 1.611869], [1, 10], [-1, 10]] };
    const collidingRibs = { ...kit, parts: kit.parts.map((part) => part.kind === 'rib' ? { ...part, outline: oldReviewOutline } : part) };
    expect(() => validateAssemblyCollisions(collidingRibs, material, profile)).toThrowError(expect.objectContaining({
      code: 'JOINT', message: expect.stringContaining(ribs[0].id),
    }));
    try {
      validateAssemblyCollisions(collidingRibs, material, profile);
    } catch (error) {
      expect((error as Error).message).toContain(ribs[1].id);
    }

    const slot = kit.joints.find((joint) => joint.role === 'slot')!;
    const collapsedCut: Polygon2 = { points: slot.polygon.points.map(() => slot.polygon.points[0]) };
    const blockedJoint = { ...kit, joints: kit.joints.map((joint) => joint === slot ? { ...joint, polygon: collapsedCut } : joint) };
    expect(() => validateAssemblyCollisions(blockedJoint, material, profile)).toThrowError(expect.objectContaining({
      code: 'JOINT', message: expect.stringContaining(slot.partInstanceId),
    }));
    try {
      validateAssemblyCollisions(blockedJoint, material, profile);
    } catch (error) {
      expect((error as Error).message).toContain(slot.mateInstanceId);
    }
  });

  test('audit sweeps actual common-z rib intervals instead of combining disjoint radial envelopes', () => {
    const leftPart: Part2D = { id: 'left-part', kind: 'rib', holes: [], quantity: 1, outline: { points: [
      [-10, 1], [0, 1], [0, 10], [10, 10], [10, 20], [-10, 20],
    ] } };
    const rightPart: Part2D = { id: 'right-part', kind: 'rib', holes: [], quantity: 1, outline: { points: [
      [-10, 10], [0, 10], [0, 1], [10, 1], [10, 20], [-10, 20],
    ] } };
    const ribOnlyKit: SpinnerKit = {
      parts: [leftPart, rightPart],
      instances: [
        { id: 'left-instance', partId: leftPart.id, axialZ: 0, angleRad: 0 },
        { id: 'right-instance', partId: rightPart.id, axialZ: 0, angleRad: Math.PI / 4 },
      ],
      joints: [], assembly: [],
      estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, angularMassError: 0, assumptions: [] },
    };
    expect(() => validateAssemblyCollisions(ribOnlyKit, { thicknessMm: 3, fitAllowanceMm: 0 }, {
      samples: [{ z: -10, radius: 20 }, { z: 10, radius: 20 }],
    })).not.toThrow();
  });

  test('audit detects spacer/rib overlap confined to the end of one linear axial band', () => {
    const rib: Part2D = { id: 'sloped-rib-part', kind: 'rib', holes: [], quantity: 1, outline: { points: [
      [-1, 10], [1, 1], [1, 12], [-1, 12],
    ] } };
    const spacer: Part2D = { id: 'spacer-part', kind: 'spacer', holes: [circle(1, true)], quantity: 1, outline: circle(5) };
    const kit: SpinnerKit = {
      parts: [rib, spacer],
      instances: [
        { id: 'sloped-rib-instance', partId: rib.id, axialZ: 0, angleRad: 0 },
        { id: 'spacer-instance', partId: spacer.id, axialZ: 0 },
      ],
      joints: [], assembly: [],
      estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, angularMassError: 0, assumptions: [] },
    };
    expect(() => validateAssemblyCollisions(kit, { thicknessMm: 2, fitAllowanceMm: 0 }, {
      samples: [{ z: -1, radius: 12 }, { z: 1, radius: 12 }],
    })).toThrowError(expect.objectContaining({ code: 'JOINT', message: expect.stringContaining('sloped-rib-instance') }));
  });

  test('audit keeps endpoint witnesses closer than width times 1e-9', () => {
    const rib: Part2D = { id: 'narrow-rib-part', kind: 'rib', holes: [], quantity: 1, outline: { points: [
      [-1, 1 - 5e-11], [1, 2], [1, 3], [-1, 3],
    ] } };
    const spacer: Part2D = { id: 'diamond-spacer-part', kind: 'spacer', holes: [circle(0.1, true, 4)], quantity: 1, outline: circle(1, false, 4) };
    const kit: SpinnerKit = {
      parts: [rib, spacer],
      instances: [
        { id: 'narrow-rib-instance', partId: rib.id, axialZ: 0, angleRad: 0 },
        { id: 'diamond-spacer-instance', partId: spacer.id, axialZ: 0 },
      ],
      joints: [], assembly: [],
      estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, angularMassError: 0, assumptions: [] },
    };
    expect(() => validateAssemblyCollisions(kit, { thicknessMm: 2, fitAllowanceMm: 0 }, {
      samples: [{ z: -1, radius: 3 }, { z: 1, radius: 3 }],
    })).toThrowError(expect.objectContaining({ code: 'JOINT', message: expect.stringContaining('narrow-rib-instance') }));
  });

  test('audit detects horizontal annulus overlap confined near a shared vertex angle', () => {
    const square: Part2D = { id: 'square-part', kind: 'hub-layer', holes: [], quantity: 1, outline: {
      points: [[1, 1], [-1, 1], [-1, -1], [1, -1]],
    } };
    const annulus: Part2D = {
      id: 'annulus-part', kind: 'outer-ring', quantity: 1,
      outline: circle(2, false, 64), holes: [circle(1.4, true, 64, Math.PI / 4)],
    };
    const kit: SpinnerKit = {
      parts: [square, annulus],
      instances: [
        { id: 'square-instance', partId: square.id, axialZ: 0 },
        { id: 'annulus-instance', partId: annulus.id, axialZ: 0 },
      ],
      joints: [], assembly: [],
      estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, angularMassError: 0, assumptions: [] },
    };
    const witnessRadius = 1.407, witness: Point2 = [witnessRadius / Math.sqrt(2), witnessRadius / Math.sqrt(2)];
    expect(partContains(square, witness) && partContains(annulus, witness)).toBe(true);
    expect(() => validateAssemblyCollisions(kit, { thicknessMm: 2, fitAllowanceMm: 0 }, {
      samples: [{ z: -1, radius: 2 }, { z: 1, radius: 2 }],
    })).toThrowError(expect.objectContaining({ code: 'JOINT', message: expect.stringContaining('square-instance') }));
  });
});
