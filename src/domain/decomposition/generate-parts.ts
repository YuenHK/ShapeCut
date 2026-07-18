import { fitAllowance, jointPair, jointWidth } from './joints';
import {
  DecompositionError, type AssemblyEdge, type DecompositionOptions, type LathedProfile,
  type MaterialInput, type Part2D, type Point2, type Polygon2, type SpinnerKit,
} from './types';

const RIB_COUNTS = new Set([4, 6, 8, 10, 12]);

function circle(radius: number, clockwise = false, segments = 32): Polygon2 {
  const points: Point2[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (clockwise ? -1 : 1) * index * Math.PI * 2 / segments;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return { points };
}

function rectangle(length: number, width: number, angle: number): Polygon2 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const local: Point2[] = [[0, -width / 2], [length, -width / 2], [length, width / 2], [0, width / 2]];
  return { points: local.map(([x, y]) => [x * c - y * s, x * s + y * c]) };
}

function ringOutline(outer: number): Polygon2 { return circle(outer); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  const text = canonical(value);
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) result = Math.imul(result ^ text.charCodeAt(index), 16777619) >>> 0;
  return result.toString(16).padStart(8, '0');
}

function validate(profile: LathedProfile, material: MaterialInput, options: DecompositionOptions): { inner: number; outer: number; height: number } {
  if (profile.samples.length < 2 || profile.samples.some(({ z, radius }, index) => !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0 || (index > 0 && z <= profile.samples[index - 1].z))) {
    throw new DecompositionError('PROFILE', 'Profile requires at least two finite, strictly increasing samples with non-negative radii');
  }
  const allowanceValues = typeof material.fitAllowanceMm === 'number' ? [material.fitAllowanceMm] : Object.values(material.fitAllowanceMm);
  if (!Number.isFinite(material.thicknessMm) || material.thicknessMm <= 0 || material.thicknessMm > 50 || allowanceValues.some((value) => !Number.isFinite(value) || value < 0 || value > 5)) {
    throw new DecompositionError('MATERIAL', 'Material dimensions and allowances must be finite and reasonable');
  }
  if (!RIB_COUNTS.has(options.ribCount) || !Number.isInteger(options.ringLayers) || options.ringLayers < 1 || options.ringLayers > 24 || !['loose', 'slip', 'snug', 'press'].includes(options.fit)) {
    throw new DecompositionError('OPTIONS', 'Unsupported decomposition options');
  }
  const inner = Math.min(...profile.samples.map(({ radius }) => radius));
  const outer = Math.max(...profile.samples.map(({ radius }) => radius));
  const height = profile.samples.at(-1)!.z - profile.samples[0].z;
  if (!Number.isFinite(options.shaftMm) || options.shaftMm <= 0 || options.shaftMm >= inner * 2) throw new DecompositionError('SHAFT', 'Shaft must fit inside the hub structure');
  return { inner, outer, height };
}

export function generateParts(profile: LathedProfile, material: MaterialInput, options: DecompositionOptions): SpinnerKit {
  const { inner, outer, height } = validate(profile, material, options);
  const width = jointWidth(material, options.fit, Math.min(inner, outer - inner, height));
  const kitKey = hash({ profile, material, options });
  const id = (kind: string, index: number) => `${kind}-${index}-${kitKey}`;
  const shaftRadius = options.shaftMm / 2 + Math.max(0, fitAllowance(material, options.fit)) / 2;
  const shaftHole = circle(shaftRadius, true);
  const hubId = id('hub', 0);
  const parts: Part2D[] = [{
    id: hubId, kind: 'hub-layer', outline: circle(inner), holes: [shaftHole], quantity: options.ringLayers,
    holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }],
  }];
  const ribIds: string[] = [];
  for (let index = 0; index < options.ribCount; index += 1) {
    const angle = index * Math.PI * 2 / options.ribCount;
    const ribId = id('rib', index);
    ribIds.push(ribId);
    parts.push({ id: ribId, kind: 'rib', outline: rectangle(outer, Math.min(height, inner), angle), holes: [], quantity: 1, angleRad: angle });
  }
  const ringIds: string[] = [];
  for (let index = 0; index < options.ringLayers; index += 1) {
    const ringId = id('ring', index);
    ringIds.push(ringId);
    parts.push({ id: ringId, kind: 'outer-ring', outline: ringOutline(outer), holes: [circle(Math.max(inner, outer - material.thicknessMm), true)], quantity: 1 });
  }
  const joints = [];
  const assembly: AssemblyEdge[] = [];
  let order = 0;
  for (let rib = 0; rib < ribIds.length; rib += 1) {
    const hubJoint = `joint-hub-${rib}-${kitKey}`;
    joints.push(...jointPair(hubJoint, hubId, ribIds[rib], width));
    assembly.push({ fromPartId: hubId, toPartId: ribIds[rib], jointId: hubJoint, order: order++ });
    for (let ring = 0; ring < ringIds.length; ring += 1) {
      const ringJoint = `joint-ring-${ring}-rib-${rib}-${kitKey}`;
      joints.push(...jointPair(ringJoint, ringIds[ring], ribIds[rib], width));
      assembly.push({ fromPartId: ringIds[ring], toPartId: ribIds[rib], jointId: ringJoint, order: order++ });
    }
  }
  return {
    parts, joints, assembly,
    estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, assumptions: ['uniform material', 'ideal cuts', 'equal angular rib spacing', 'static estimate only'] },
  };
}
