import { fitAllowance, jointPair, jointWidth } from './joints';
import { DecompositionError, type AssemblyEdge, type DecompositionOptions, type LathedProfile, type MaterialInput, type Part2D, type Point2, type Polygon2, type SpinnerKit } from './types';

const RIB_COUNTS = new Set([4, 6, 8, 10, 12]);
type Internals = { readonly hasher?: (canonicalPayload: string) => string };

function circle(radius: number, clockwise = false, segments = 32): Polygon2 {
  const points: Point2[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (clockwise ? -1 : 1) * index * Math.PI * 2 / segments;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return { points };
}

function radialRectangle(centerRadius: number, width: number, depth: number, angle: number, clockwise = true): Polygon2 {
  const c = Math.cos(angle), s = Math.sin(angle), halfW = width / 2, halfD = depth / 2;
  const local: Point2[] = [[centerRadius - halfD, -halfW], [centerRadius + halfD, -halfW], [centerRadius + halfD, halfW], [centerRadius - halfD, halfW]];
  const points = local.map(([x, y]) => [x * c - y * s, x * s + y * c] as Point2);
  return { points: clockwise ? points.reverse() : points };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash128(text: string): string {
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let value = lanes[lane];
    for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ (text.charCodeAt(index) + lane * 131), 16777619 + lane * 2) >>> 0;
    lanes[lane] = value;
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }

function validate(profileValue: unknown, materialValue: unknown, optionsValue: unknown): { profile: LathedProfile; material: MaterialInput; options: DecompositionOptions; hub: number; outer: number; height: number } {
  if (!record(profileValue) || !Array.isArray(profileValue.samples)) throw new DecompositionError('PROFILE', 'Profile must contain a samples array');
  const profile = profileValue as LathedProfile;
  if (profile.samples.length < 2 || profile.samples.some((sample, index) => !record(sample) || !Number.isFinite(sample.z) || !Number.isFinite(sample.radius) || sample.radius < 0 || (index > 0 && sample.z <= profile.samples[index - 1].z))) throw new DecompositionError('PROFILE', 'Profile samples must be finite and strictly increasing');
  if (!record(materialValue)) throw new DecompositionError('MATERIAL', 'Material input must be an object');
  const material = materialValue as MaterialInput;
  if (material.fitAllowanceMm === null || (typeof material.fitAllowanceMm !== 'number' && !record(material.fitAllowanceMm))) throw new DecompositionError('MATERIAL', 'Invalid fit allowance');
  const values = typeof material.fitAllowanceMm === 'number' ? [material.fitAllowanceMm] : Object.values(material.fitAllowanceMm);
  const map = typeof material.fitAllowanceMm === 'number' ? undefined : material.fitAllowanceMm;
  if ((map && !['loose', 'slip', 'snug', 'press'].every((fit) => Object.hasOwn(map, fit))) || values.length !== (map ? 4 : 1) || !Number.isFinite(material.thicknessMm) || material.thicknessMm <= 0 || material.thicknessMm > 50 || values.some((value) => !Number.isFinite(value) || value < 0 || value > 5)) throw new DecompositionError('MATERIAL', 'Invalid material dimensions');
  if (!record(optionsValue)) throw new DecompositionError('OPTIONS', 'Options must be an object');
  const options = optionsValue as DecompositionOptions;
  if (!RIB_COUNTS.has(options.ribCount) || !Number.isInteger(options.ringLayers) || options.ringLayers < 1 || options.ringLayers > 24 || !['loose', 'slip', 'snug', 'press'].includes(options.fit)) throw new DecompositionError('OPTIONS', 'Unsupported options');
  let outer = 0;
  for (const sample of profile.samples) outer = Math.max(outer, sample.radius);
  if (outer <= 0) throw new DecompositionError('PROFILE', 'Profile has no radial structure');
  const hub = outer * 0.4, height = profile.samples.at(-1)!.z - profile.samples[0].z;
  const clearance = fitAllowance(material, options.fit);
  if (!Number.isFinite(options.shaftMm) || options.shaftMm <= 0 || options.shaftMm / 2 + clearance / 2 >= hub * 0.8) throw new DecompositionError('SHAFT', 'Shaft does not fit hub safety margin');
  return { profile, material, options, hub, outer, height };
}

function interpolate(profile: LathedProfile, z: number): number {
  if (z <= profile.samples[0].z) return profile.samples[0].radius;
  for (let index = 1; index < profile.samples.length; index += 1) {
    const a = profile.samples[index - 1], b = profile.samples[index];
    if (z <= b.z) return a.radius + (b.radius - a.radius) * (z - a.z) / (b.z - a.z);
  }
  return profile.samples.at(-1)!.radius;
}

function ribSilhouette(profile: LathedProfile, centers: readonly number[], width: number, depth: number): { outline: Polygon2; tabs: Polygon2[] } {
  const upper: { point: Point2; order: number }[] = profile.samples.map(({ z, radius }) => ({ point: [z, radius], order: 0 }));
  const tabs: Polygon2[] = [];
  for (const center of centers) {
    const z0 = center - width / 2, z1 = center + width / 2;
    const r0 = interpolate(profile, z0), r1 = interpolate(profile, z1), top = Math.max(r0, r1) + depth;
    const polygon: Polygon2 = { points: [[z0, r0], [z0, top], [z1, top], [z1, r1]] };
    tabs.push(polygon);
    upper.push(
      { point: polygon.points[0], order: 0 }, { point: polygon.points[1], order: 1 },
      { point: polygon.points[2], order: 0 }, { point: polygon.points[3], order: 1 },
    );
  }
  upper.sort((a, b) => a.point[0] - b.point[0] || a.order - b.order);
  const unique = upper.map(({ point }) => point).filter((point, index, points) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
  const lower: Point2[] = profile.samples.map(({ z, radius }) => [z, -radius]);
  const boundary = [...lower, ...unique.reverse()].filter((point, index, points) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
  if (boundary.length > 1 && boundary[0][0] === boundary.at(-1)![0] && boundary[0][1] === boundary.at(-1)![1]) boundary.pop();
  return { outline: { points: boundary }, tabs };
}

export function generateParts(profileValue: unknown, materialValue: unknown, optionsValue: unknown, internals: Internals = {}): SpinnerKit {
  const { profile, material, options, hub, outer, height } = validate(profileValue, materialValue, optionsValue);
  const width = jointWidth(material, options.fit, Math.min(hub, outer - hub, height));
  const depth = Math.min(material.thicknessMm * 0.8, (hub - (options.shaftMm / 2 + fitAllowance(material, options.fit) / 2)) / 3, (outer - hub) / 3);
  const jointCount = options.ringLayers + 1;
  if (width * jointCount >= height * 0.9 || depth <= 0) throw new DecompositionError('JOINT', 'Tab intervals overlap or have no structural depth');
  const zMin = profile.samples[0].z, zMax = profile.samples.at(-1)!.z;
  const tabCenters = Array.from({ length: jointCount }, (_, index) => zMin + (index + 1) * (zMax - zMin) / (jointCount + 1));
  const { outline: ribOutline, tabs } = ribSilhouette(profile, tabCenters, width, depth);
  const used = new Map<string, string>();
  const digest = (payload: unknown): string => {
    const text = canonical(payload), result = (internals.hasher ?? hash128)(text);
    if (!/^[0-9a-f]{32}$/i.test(result)) throw new DecompositionError('HASH_COLLISION', 'Hasher must return 128-bit hex');
    const prior = used.get(result);
    if (prior !== undefined && prior !== text) throw new DecompositionError('HASH_COLLISION', 'Distinct geometry produced the same content hash');
    used.set(result, text);
    return result;
  };
  const id = (kind: string, index: number, geometry: unknown, jointed: boolean) => `${kind}-${index}-${digest({ kind, index, geometry, jointWidthMm: jointed ? width : undefined })}`;
  const shaftRadius = options.shaftMm / 2 + fitAllowance(material, options.fit) / 2;
  const shaftHole = circle(shaftRadius, true), hubOutline = circle(hub);
  const hubSlots = Array.from({ length: options.ribCount }, (_, rib) => radialRectangle((shaftRadius + hub) / 2, width, depth, rib * Math.PI * 2 / options.ribCount));
  const hubId = id('hub', 0, { hubOutline, shaftHole, hubSlots }, true);
  const parts: Part2D[] = [{ id: hubId, kind: 'hub-layer', outline: hubOutline, holes: [shaftHole, ...hubSlots], quantity: options.ringLayers, holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }] }];
  const ribIds: string[] = [];
  for (let index = 0; index < options.ribCount; index += 1) {
    const ribId = id('rib', index, { ribOutline, tabs }, true); ribIds.push(ribId);
    parts.push({ id: ribId, kind: 'rib', outline: ribOutline, holes: [], quantity: 1, angleRad: index * Math.PI * 2 / options.ribCount });
  }
  const ringIds: string[] = [], ringSlots: Polygon2[][] = [];
  for (let layer = 0; layer < options.ringLayers; layer += 1) {
    const slots = Array.from({ length: options.ribCount }, (_, rib) => radialRectangle(outer - material.thicknessMm / 2, width, Math.min(depth, material.thicknessMm * 0.8), rib * Math.PI * 2 / options.ribCount));
    const ringOutline = circle(outer), ringHole = circle(outer - material.thicknessMm, true);
    const ringId = id('ring', layer, { ringOutline, ringHole, slots }, true); ringIds.push(ringId); ringSlots.push(slots);
    parts.push({ id: ringId, kind: 'outer-ring', outline: ringOutline, holes: [ringHole, ...slots], quantity: 1 });
  }
  let spacerId: string | undefined;
  if (options.ringLayers > 1) {
    const spacerOutline = circle(Math.min(hub, shaftRadius + material.thicknessMm));
    spacerId = id('spacer', 0, { spacerOutline, shaftHole }, false);
    parts.push({ id: spacerId, kind: 'spacer', outline: spacerOutline, holes: [shaftHole], quantity: 2, holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }] });
  }
  const joints = [], assembly: AssemblyEdge[] = []; let order = 0;
  for (let rib = 0; rib < ribIds.length; rib += 1) {
    const direction: Point2 = [Math.cos(rib * Math.PI * 2 / options.ribCount), Math.sin(rib * Math.PI * 2 / options.ribCount)];
    const hubJoint = `joint-${digest({ slot: hubId, tab: ribIds[rib], feature: 0 })}`;
    joints.push(...jointPair(hubJoint, hubId, ribIds[rib], width, depth, [(shaftRadius + hub) / 2 * direction[0], (shaftRadius + hub) / 2 * direction[1]], direction, [tabCenters[0], interpolate(profile, tabCenters[0]) + depth / 2], [0, 1], hubSlots[rib], tabs[0]));
    assembly.push({ fromPartId: hubId, toPartId: ribIds[rib], jointId: hubJoint, order: order++ });
    for (let layer = 0; layer < ringIds.length; layer += 1) {
      const joint = `joint-${digest({ slot: ringIds[layer], tab: ribIds[rib], feature: layer + 1 })}`;
      joints.push(...jointPair(joint, ringIds[layer], ribIds[rib], width, depth, [(outer - material.thicknessMm / 2) * direction[0], (outer - material.thicknessMm / 2) * direction[1]], direction, [tabCenters[layer + 1], interpolate(profile, tabCenters[layer + 1]) + depth / 2], [0, 1], ringSlots[layer][rib], tabs[layer + 1]));
      assembly.push({ fromPartId: ringIds[layer], toPartId: ribIds[rib], jointId: joint, order: order++ });
    }
  }
  if (spacerId) {
    assembly.push({ fromPartId: hubId, toPartId: spacerId, jointId: `placement-${digest({ hubId, spacerId, side: -1 })}`, order: order++, instanceId: 'negative-z' });
    assembly.push({ fromPartId: hubId, toPartId: spacerId, jointId: `placement-${digest({ hubId, spacerId, side: 1 })}`, order: order++, instanceId: 'positive-z' });
  }
  return { parts, joints, assembly, estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, assumptions: ['uniform material', 'ideal cuts', 'equal angular rib spacing', 'static estimate only'] } };
}
