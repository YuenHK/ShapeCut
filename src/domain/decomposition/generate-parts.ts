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

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }

function validate(profileValue: unknown, materialValue: unknown, optionsValue: unknown): { profile: LathedProfile; material: MaterialInput; options: DecompositionOptions; hub: number; outer: number; height: number } {
  if (!record(profileValue) || !Array.isArray(profileValue.samples)) throw new DecompositionError('PROFILE', 'Profile must contain a samples array');
  const profile = profileValue as LathedProfile;
  if (profile.samples.length < 2 || profile.samples.some((sample, index) => !record(sample) || !Number.isFinite(sample.z) || !Number.isFinite(sample.radius) || sample.radius < 0 || (index > 0 && sample.z <= profile.samples[index - 1].z))) {
    throw new DecompositionError('PROFILE', 'Profile requires at least two finite, strictly increasing samples with non-negative radii');
  }
  if (!record(materialValue)) throw new DecompositionError('MATERIAL', 'Material input must be an object');
  const material = materialValue as MaterialInput;
  if (material.fitAllowanceMm === null || (typeof material.fitAllowanceMm !== 'number' && !record(material.fitAllowanceMm))) throw new DecompositionError('MATERIAL', 'Fit allowances must be a number or complete fit map');
  const allowanceValues = typeof material.fitAllowanceMm === 'number' ? [material.fitAllowanceMm] : Object.values(material.fitAllowanceMm);
  const fitMap = typeof material.fitAllowanceMm === 'number' ? undefined : material.fitAllowanceMm;
  const completeFitMap = fitMap === undefined || ['loose', 'slip', 'snug', 'press'].every((fit) => Object.hasOwn(fitMap, fit));
  if (!completeFitMap || !Number.isFinite(material.thicknessMm) || material.thicknessMm <= 0 || material.thicknessMm > 50 || allowanceValues.length !== (typeof material.fitAllowanceMm === 'number' ? 1 : 4) || allowanceValues.some((value) => !Number.isFinite(value) || value < 0 || value > 5)) {
    throw new DecompositionError('MATERIAL', 'Material dimensions and allowances must be finite and reasonable');
  }
  if (!record(optionsValue)) throw new DecompositionError('OPTIONS', 'Options must be an object');
  const options = optionsValue as DecompositionOptions;
  if (!RIB_COUNTS.has(options.ribCount) || !Number.isInteger(options.ringLayers) || options.ringLayers < 1 || options.ringLayers > 24 || !['loose', 'slip', 'snug', 'press'].includes(options.fit)) {
    throw new DecompositionError('OPTIONS', 'Unsupported decomposition options');
  }
  const outer = Math.max(...profile.samples.map(({ radius }) => radius));
  if (outer <= 0) throw new DecompositionError('PROFILE', 'Profile has no radial structure');
  // A bounded fraction of maximum radius remains valid for pointed profiles and
  // preserves enough radial structure for the ring connection.
  const hub = outer * 0.4;
  const height = profile.samples.at(-1)!.z - profile.samples[0].z;
  const baseClearance = typeof material.fitAllowanceMm === 'number' ? material.fitAllowanceMm : Math.min(...Object.values(material.fitAllowanceMm));
  if (!Number.isFinite(options.shaftMm) || options.shaftMm <= 0 || options.shaftMm / 2 + baseClearance / 2 >= hub * 0.8) throw new DecompositionError('SHAFT', 'Shaft must fit inside the hub with a radial safety margin');
  return { profile, material, options, hub, outer, height };
}

export function generateParts(profileValue: unknown, materialValue: unknown, optionsValue: unknown): SpinnerKit {
  const { material, options, hub, outer, height } = validate(profileValue, materialValue, optionsValue);
  const width = jointWidth(material, options.fit, Math.min(hub, outer - hub, height));
  const baseClearance = typeof material.fitAllowanceMm === 'number' ? material.fitAllowanceMm : Math.min(...Object.values(material.fitAllowanceMm));
  const shaftRadius = options.shaftMm / 2 + baseClearance / 2;
  const shaftHole = circle(shaftRadius, true);
  const partId = (kind: string, index: number, geometry: unknown, jointed: boolean) => `${kind}-${index}-${hash({ kind, index, geometry, jointWidthMm: jointed ? width : undefined })}`;
  const hubOutline = circle(hub);
  const hubId = partId('hub', 0, { outline: hubOutline, shaftHole }, true);
  const parts: Part2D[] = [{
    id: hubId, kind: 'hub-layer', outline: hubOutline, holes: [shaftHole], quantity: options.ringLayers,
    holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }],
  }];
  const ribIds: string[] = [];
  for (let index = 0; index < options.ribCount; index += 1) {
    const angle = index * Math.PI * 2 / options.ribCount;
    const ribOutline = rectangle(outer, Math.min(height, hub), angle);
    const ribId = partId('rib', index, { outline: ribOutline }, true);
    ribIds.push(ribId);
    parts.push({ id: ribId, kind: 'rib', outline: ribOutline, holes: [], quantity: 1, angleRad: angle });
  }
  const ringIds: string[] = [];
  for (let index = 0; index < options.ringLayers; index += 1) {
    const outline = ringOutline(outer);
    const hole = circle(Math.max(hub, outer - material.thicknessMm), true);
    const ringId = partId('ring', index, { outline, hole }, true);
    ringIds.push(ringId);
    parts.push({ id: ringId, kind: 'outer-ring', outline, holes: [hole], quantity: 1 });
  }
  if (options.ringLayers > 1) {
    const spacerOuter = Math.min(hub, shaftRadius + material.thicknessMm);
    const spacerOutline = circle(spacerOuter);
    const spacerId = partId('spacer', 0, { outline: spacerOutline, shaftHole }, false);
    parts.push({ id: spacerId, kind: 'spacer', outline: spacerOutline, holes: [shaftHole], quantity: 2, holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }] });
  }
  const joints = [];
  const assembly: AssemblyEdge[] = [];
  let order = 0;
  for (let rib = 0; rib < ribIds.length; rib += 1) {
    const hubJoint = `joint-${hash({ slot: hubId, tab: ribIds[rib], width })}`;
    joints.push(...jointPair(hubJoint, hubId, ribIds[rib], width));
    assembly.push({ fromPartId: hubId, toPartId: ribIds[rib], jointId: hubJoint, order: order++ });
    for (let ring = 0; ring < ringIds.length; ring += 1) {
      const ringJoint = `joint-${hash({ slot: ringIds[ring], tab: ribIds[rib], width })}`;
      joints.push(...jointPair(ringJoint, ringIds[ring], ribIds[rib], width));
      assembly.push({ fromPartId: ringIds[ring], toPartId: ribIds[rib], jointId: ringJoint, order: order++ });
    }
  }
  return {
    parts, joints, assembly,
    estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, assumptions: ['uniform material', 'ideal cuts', 'equal angular rib spacing', 'static estimate only'] },
  };
}
