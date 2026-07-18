import { fitAllowance, jointPair, jointWidth } from './joints';
import { validateAssemblyCollisions } from './assembly-collisions';
import { DecompositionError, type AssemblyEdge, type DecompositionOptions, type LathedProfile, type MaterialInput, type MatingFrame, type Part2D, type PartInstance, type Point2, type Polygon2, type SpinnerKit } from './types';
import { isSimpleXMonotonePolygon, validateOpenRadialNotches } from './polygon-validation';
import { minimumRadiusOverInterval } from './profile-geometry';

const RIB_COUNTS = new Set([4, 6, 8, 10, 12]);
const CIRCLE_SEGMENTS = 64;
type Internals = { readonly hasher?: (canonicalPayload: string) => string };

function circle(radius: number, clockwise = false, segments = 32): Polygon2 {
  const points: Point2[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (clockwise ? -1 : 1) * index * Math.PI * 2 / segments;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return { points };
}

type RadialNotch = { readonly angleRad: number; readonly width: number; readonly innerRadius: number };

function appendPoint(points: Point2[], point: Point2): void {
  const previous = points.at(-1);
  if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
}

function rotatePoint([radial, tangential]: Point2, angle: number): Point2 {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return [radial * cosine - tangential * sine, radial * sine + tangential * cosine];
}

function notchedCircle(radius: number, notches: readonly RadialNotch[], segments = 64): { readonly outline: Polygon2; readonly support: Polygon2; readonly cuts: readonly Polygon2[] } {
  if (notches.length === 0) { const support = circle(radius, false, segments); return { outline: support, support, cuts: [] }; }
  const startAngle = Math.PI / notches.length;
  const events = notches.map((notch, sourceIndex) => {
    const halfWidth = notch.width / 2;
    if (!(halfWidth > 0 && halfWidth < radius && notch.innerRadius > 0)) throw new DecompositionError('JOINT', 'Open notch dimensions must fit the plate outline');
    const delta = Math.asin(halfWidth / radius);
    const outerRadial = Math.sqrt(radius * radius - halfWidth * halfWidth);
    if (!(notch.innerRadius < outerRadial)) throw new DecompositionError('JOINT', 'Open notch has no radial depth');
    let center = notch.angleRad;
    while (center < startAngle) center += Math.PI * 2;
    while (center >= startAngle + Math.PI * 2) center -= Math.PI * 2;
    return { ...notch, sourceIndex, center, halfWidth, delta, outerRadial, start: center - delta, end: center + delta };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].start <= events[index - 1].end) throw new DecompositionError('JOINT', 'Open notches overlap around the plate outline');
  }
  const points: Point2[] = [];
  const appendArc = (from: number, to: number): void => {
    if (points.length === 0) appendPoint(points, [radius * Math.cos(from), radius * Math.sin(from)]);
    const maxStep = Math.PI * 2 / segments;
    for (let angle = from + maxStep; angle < to; angle += maxStep) appendPoint(points, [radius * Math.cos(angle), radius * Math.sin(angle)]);
    appendPoint(points, [radius * Math.cos(to), radius * Math.sin(to)]);
  };
  let cursor = startAngle;
  const cuts: Polygon2[] = new Array(notches.length);
  for (const event of events) {
    appendArc(cursor, event.start);
    const innerLow = rotatePoint([event.innerRadius, -event.halfWidth], event.center);
    const innerHigh = rotatePoint([event.innerRadius, event.halfWidth], event.center);
    appendPoint(points, innerLow);
    appendPoint(points, innerHigh);
    appendPoint(points, rotatePoint([event.outerRadial, event.halfWidth], event.center));
    cuts[event.sourceIndex] = { points: [innerLow, rotatePoint([event.outerRadial, -event.halfWidth], event.center), rotatePoint([event.outerRadial, event.halfWidth], event.center), innerHigh] };
    cursor = event.end;
  }
  appendArc(cursor, startAngle + Math.PI * 2);
  if (points.length > 1 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) <= radius * Number.EPSILON * 16) points.pop();
  const supportAngles = [
    ...Array.from({ length: segments }, (_, index) => startAngle + index * Math.PI * 2 / segments),
    ...events.flatMap((event) => [event.start, event.end]),
  ].sort((left, right) => left - right).filter((angle, index, values) => index === 0 || angle !== values[index - 1]);
  const support: Polygon2 = { points: supportAngles.map((angle) => [radius * Math.cos(angle), radius * Math.sin(angle)]) };
  return { outline: { points }, support, cuts };
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
  if ((map && !['loose', 'slip', 'snug', 'press'].every((fit) => Object.hasOwn(map, fit))) || values.length !== (map ? 4 : 1) || !Number.isFinite(material.thicknessMm) || material.thicknessMm <= 0 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new DecompositionError('MATERIAL', 'Invalid material dimensions');
  if (!record(optionsValue)) throw new DecompositionError('OPTIONS', 'Options must be an object');
  const options = optionsValue as DecompositionOptions;
  if (!RIB_COUNTS.has(options.ribCount) || !Number.isInteger(options.ringLayers) || options.ringLayers < 1 || options.ringLayers > 24 || !['loose', 'slip', 'snug', 'press'].includes(options.fit)) throw new DecompositionError('OPTIONS', 'Unsupported options');
  let outer = 0;
  for (const sample of profile.samples) outer = Math.max(outer, sample.radius);
  if (outer <= 0) throw new DecompositionError('PROFILE', 'Profile has no radial structure');
  const hub = outer * 0.4, height = profile.samples.at(-1)!.z - profile.samples[0].z;
  const clearance = fitAllowance(material, options.fit);
  const shaftTargetRadius = options.shaftMm / 2 + clearance / 2;
  const shaftPolygonRadius = shaftTargetRadius / Math.cos(Math.PI / CIRCLE_SEGMENTS);
  if (!Number.isFinite(options.shaftMm) || options.shaftMm <= 0 || shaftPolygonRadius >= hub * 0.8) throw new DecompositionError('SHAFT', 'Shaft does not fit hub safety margin');
  return { profile, material, options, hub, outer, height };
}

type RibNotch = { readonly axialZ: number; readonly width: number; readonly radialMin: number; readonly radialMax: number };

function profileRadiusAt(profile: LathedProfile, z: number): number {
  let rightIndex = 1;
  while (rightIndex < profile.samples.length && profile.samples[rightIndex].z < z) rightIndex += 1;
  const right = profile.samples[Math.min(rightIndex, profile.samples.length - 1)], left = profile.samples[Math.max(0, rightIndex - 1)];
  if (right.z === left.z) return right.radius;
  return left.radius + (right.radius - left.radius) * (z - left.z) / (right.z - left.z);
}

function ribSilhouette(profile: LathedProfile, innerRadius: number, notches: readonly RibNotch[] = []): Polygon2 {
  const first = profile.samples.findIndex(({ radius }) => radius > innerRadius);
  let last = -1;
  for (let index = profile.samples.length - 1; index >= 0; index -= 1) {
    if (profile.samples[index].radius > innerRadius) { last = index; break; }
  }
  if (first < 0 || last < first || profile.samples.slice(first, last + 1).some(({ radius }) => radius < innerRadius)) {
    throw new DecompositionError('JOINT', 'Profile cannot contain one connected shaft-clear spoke');
  }
  const crossing = (left: typeof profile.samples[number], right: typeof profile.samples[number]): Point2 => {
    const t = (innerRadius - left.radius) / (right.radius - left.radius);
    return [left.z + (right.z - left.z) * t, innerRadius];
  };
  const outer: Point2[] = [];
  if (first > 0) outer.push(crossing(profile.samples[first - 1], profile.samples[first]));
  for (let index = first; index <= last; index += 1) outer.push([profile.samples[index].z, profile.samples[index].radius]);
  if (last + 1 < profile.samples.length) outer.push(crossing(profile.samples[last], profile.samples[last + 1]));
  const zMin = outer[0][0], zMax = outer.at(-1)![0];
  const ordered = [...notches].sort((left, right) => left.axialZ - right.axialZ);
  for (let index = 0; index < ordered.length; index += 1) {
    const notch = ordered[index], low = notch.axialZ - notch.width / 2, high = notch.axialZ + notch.width / 2;
    const priorHigh = index === 0 ? zMin : ordered[index - 1].axialZ + ordered[index - 1].width / 2;
    const outerMinimum = minimumRadiusOverInterval(profile, low, high);
    if (low <= priorHigh || high >= zMax || notch.radialMin <= innerRadius || notch.radialMax <= notch.radialMin || notch.radialMax >= outerMinimum) {
      throw new DecompositionError('JOINT', 'Complementary rib notches do not leave a connected material tab');
    }
  }
  const innerPath: Point2[] = [[zMin, innerRadius]];
  for (const notch of ordered) {
    const low = notch.axialZ - notch.width / 2, high = notch.axialZ + notch.width / 2;
    appendPoint(innerPath, [low, innerRadius]); appendPoint(innerPath, [low, notch.radialMin]);
    appendPoint(innerPath, [high, notch.radialMin]); appendPoint(innerPath, [high, innerRadius]);
  }
  appendPoint(innerPath, [zMax, innerRadius]);
  const outerPath: Point2[] = [];
  let outerIndex = 0;
  for (const notch of ordered) {
    const low = notch.axialZ - notch.width / 2, high = notch.axialZ + notch.width / 2;
    while (outerIndex < outer.length && outer[outerIndex][0] < low) appendPoint(outerPath, outer[outerIndex++]);
    appendPoint(outerPath, [low, profileRadiusAt(profile, low)]);
    appendPoint(outerPath, [low, notch.radialMax]);
    appendPoint(outerPath, [high, notch.radialMax]);
    appendPoint(outerPath, [high, profileRadiusAt(profile, high)]);
    while (outerIndex < outer.length && outer[outerIndex][0] <= high) outerIndex += 1;
  }
  while (outerIndex < outer.length) appendPoint(outerPath, outer[outerIndex++]);
  const boundary: Point2[] = [...innerPath];
  for (let index = outerPath.length - 1; index >= 0; index -= 1) appendPoint(boundary, outerPath[index]);
  if (boundary.length > 1 && boundary[0][0] === boundary.at(-1)![0] && boundary[0][1] === boundary.at(-1)![1]) boundary.pop();
  return { points: boundary };
}

function contactPolygon(frame: MatingFrame): Polygon2 {
  const half = frame.tangentialWidth / 2;
  return { points: [[frame.axialZ - half, frame.radialMin], [frame.axialZ + half, frame.radialMin], [frame.axialZ + half, frame.radialMax], [frame.axialZ - half, frame.radialMax]] };
}

function contactFits(profile: LathedProfile, frame: MatingFrame, margin: number): boolean {
  const half = frame.tangentialWidth / 2;
  return frame.radialMin >= 0 && frame.radialMax + margin <= minimumRadiusOverInterval(profile, frame.axialZ - half, frame.axialZ + half);
}

export function generateParts(profileValue: unknown, materialValue: unknown, optionsValue: unknown, internals: Internals = {}): SpinnerKit {
  const { profile, material, options, hub, outer, height } = validate(profileValue, materialValue, optionsValue);
  const width = jointWidth(material, options.fit, Math.min(hub, outer - hub, height));
  const selectedFitAllowance = fitAllowance(material, options.fit);
  const shaftRadius = options.shaftMm / 2 + selectedFitAllowance / 2;
  const shaftPolygonRadius = shaftRadius / Math.cos(Math.PI / CIRCLE_SEGMENTS);
  const depth = Math.min(material.thicknessMm * 0.8, (hub - shaftPolygonRadius) / 3, (outer - hub) / 3);
  const jointCount = options.ringLayers * 2;
  const geometryScale = Math.max(outer, height, material.thicknessMm, shaftPolygonRadius);
  const structuralMargin = Math.max(material.thicknessMm * 0.02, geometryScale * 64 * Number.EPSILON);
  const spacerOuterRadius = options.ringLayers > 1 ? Math.min(hub, shaftPolygonRadius + material.thicknessMm) : undefined;
  const adjacentRibClearanceRadius = material.thicknessMm / 2 / Math.tan(Math.PI / options.ribCount);
  const ribInnerRadius = Math.max(shaftPolygonRadius, adjacentRibClearanceRadius, spacerOuterRadius ?? 0) + structuralMargin;
  const centerSpacing = height / (jointCount + 1);
  if (width + structuralMargin >= centerSpacing || depth <= 0) throw new DecompositionError('JOINT', 'Tab intervals overlap or have no structural depth');
  const zMin = profile.samples[0].z, zMax = profile.samples.at(-1)!.z;
  const preferredCenters = Array.from({ length: jointCount }, (_, index) => zMin + (index + 1) * (zMax - zMin) / (jointCount + 1));
  const requiredLocalRadius = ribInnerRadius + structuralMargin + Math.max(depth / 2, material.thicknessMm / 2);
  const centersHaveRadialRoom = (centers: readonly number[]): boolean => centers.every((axialZ) =>
    minimumRadiusOverInterval(profile, axialZ - width / 2, axialZ + width / 2) > requiredLocalRadius);
  const compactSpacing = width + structuralMargin * 2;
  const profileMiddle = (zMin + zMax) / 2;
  const compactCenters = Array.from({ length: jointCount }, (_, index) => profileMiddle + (index - (jointCount - 1) / 2) * compactSpacing);
  const tabCenters = centersHaveRadialRoom(preferredCenters) ? preferredCenters : compactCenters;
  const hubCenters = tabCenters.slice(0, options.ringLayers), ringCenters = tabCenters.slice(options.ringLayers);
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
  const shaftHole = circle(shaftPolygonRadius, true, CIRCLE_SEGMENTS);
  const hubLocalLimit = Math.min(...hubCenters.map((axialZ) => minimumRadiusOverInterval(profile, axialZ - width / 2, axialZ + width / 2))) - structuralMargin;
  const hubNotchTip = Math.min(hub - depth / 2, hubLocalLimit - depth / 2);
  const hubTabOuter = Math.min(Math.sqrt(hub * hub - (width / 2) ** 2) - structuralMargin, hubLocalLimit);
  if (!(hubNotchTip > shaftPolygonRadius + structuralMargin && hubTabOuter > hubNotchTip + structuralMargin)) throw new DecompositionError('JOINT', 'Hub notch cannot leave a shaft-clear material tab');
  const hubNotches = Array.from({ length: options.ribCount }, (_, rib): RadialNotch => ({ angleRad: rib * Math.PI * 2 / options.ribCount, width, innerRadius: hubNotchTip }));
  const hubGeometry = notchedCircle(hub, hubNotches);
  if (!validateOpenRadialNotches(hubGeometry.cuts, hubGeometry.support, [shaftHole], structuralMargin)) throw new DecompositionError('JOINT', 'Hub open notches breach actual polygon support, hole, or neighbour margins');
  const hubFrames = hubCenters.map((axialZ) => Array.from({ length: options.ribCount }, (_, rib): MatingFrame => ({ axialZ, angleRad: rib * Math.PI * 2 / options.ribCount, radialMin: hubNotchTip, radialMax: hubTabOuter, tangentialWidth: width, materialThicknessMm: material.thicknessMm, fitAllowanceMm: selectedFitAllowance })));
  if (hubFrames.flat().some((frame) => !contactFits(profile, frame, structuralMargin))) throw new DecompositionError('JOINT', 'Profile cannot contain hub contact frame');
  const hubId = id('hub', 0, { outline: hubGeometry.outline, shaftHole, cuts: hubGeometry.cuts }, true);
  const ringIds: string[] = [], ringCuts: Polygon2[][] = [], ringFrames: MatingFrame[][] = [];
  const ringParts: Part2D[] = [];
  for (let layer = 0; layer < options.ringLayers; layer += 1) {
    const ringDepth = Math.min(depth, material.thicknessMm * 0.8);
    const axialZ = ringCenters[layer], halfWidth = width / 2;
    const localRadius = minimumRadiusOverInterval(profile, axialZ - halfWidth, axialZ + halfWidth) - structuralMargin;
    if (!(localRadius > material.thicknessMm + structuralMargin * 2)) throw new DecompositionError('JOINT', 'Local profile cannot contain ring annulus');
    const inner = localRadius - material.thicknessMm;
    const ringNotchTip = inner + (localRadius - inner) / 2;
    const ringTabOuter = Math.sqrt(localRadius * localRadius - (width / 2) ** 2) - structuralMargin;
    if (!(ringNotchTip > inner + structuralMargin && ringTabOuter > ringNotchTip + structuralMargin && ringDepth > 0)) throw new DecompositionError('JOINT', 'Ring notch cannot leave a connected annulus and rib tab');
    const geometry = notchedCircle(localRadius, Array.from({ length: options.ribCount }, (_, rib): RadialNotch => ({ angleRad: rib * Math.PI * 2 / options.ribCount, width, innerRadius: ringNotchTip })));
    const ringHole = circle(inner, true, CIRCLE_SEGMENTS);
    if (!validateOpenRadialNotches(geometry.cuts, geometry.support, [ringHole], structuralMargin)) throw new DecompositionError('JOINT', 'Ring open notches breach actual polygon support, hole, or neighbour margins');
    const frames = Array.from({ length: options.ribCount }, (_, rib): MatingFrame => ({ axialZ, angleRad: rib * Math.PI * 2 / options.ribCount, radialMin: ringNotchTip, radialMax: ringTabOuter, tangentialWidth: width, materialThicknessMm: material.thicknessMm, fitAllowanceMm: selectedFitAllowance }));
    if (frames.some((frame) => !contactFits(profile, frame, structuralMargin))) throw new DecompositionError('JOINT', 'Profile cannot contain ring contact frame');
    const ringId = id('ring', layer, { outline: geometry.outline, ringHole, cuts: geometry.cuts, frames }, true); ringIds.push(ringId); ringCuts.push([...geometry.cuts]); ringFrames.push(frames);
    ringParts.push({ id: ringId, kind: 'outer-ring', outline: geometry.outline, holes: [ringHole], quantity: 1 });
  }
  const ribOutline = ribSilhouette(profile, ribInnerRadius, [...hubFrames.map((frames) => frames[0]), ...ringFrames.map((frames) => frames[0])].map((frame) => ({ axialZ: frame.axialZ, width: frame.tangentialWidth, radialMin: frame.radialMin, radialMax: frame.radialMax })));
  if (!isSimpleXMonotonePolygon(ribOutline)) throw new DecompositionError('JOINT', 'Complementary notch insertion produced a self-intersecting rib outline');
  const ribIds: string[] = [];
  const ribParts: Part2D[] = [];
  for (let rib = 0; rib < options.ribCount; rib += 1) {
    const contacts = [...hubFrames.map((frames) => frames[rib]), ...ringFrames.map((frames) => frames[rib])].map(contactPolygon);
    const ribId = id('rib', rib, { ribOutline, contacts, angleRad: rib * Math.PI * 2 / options.ribCount }, true);
    ribIds.push(ribId);
    ribParts.push({ id: ribId, kind: 'rib', outline: ribOutline, holes: [], quantity: 1, angleRad: rib * Math.PI * 2 / options.ribCount });
  }
  const parts: Part2D[] = [{ id: hubId, kind: 'hub-layer', outline: hubGeometry.outline, holes: [shaftHole], quantity: options.ringLayers, holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }] }, ...ribParts, ...ringParts];
  let spacerId: string | undefined;
  if (spacerOuterRadius !== undefined) {
    const spacerOutline = circle(spacerOuterRadius);
    spacerId = id('spacer', 0, { spacerOutline, shaftHole }, false);
    parts.push({ id: spacerId, kind: 'spacer', outline: spacerOutline, holes: [shaftHole], quantity: 2, holeMetadata: [{ purpose: 'shaft', center: [0, 0], radiusMm: shaftRadius, polygonIndex: 0 }] });
  }
  const instanceId = (kind: string, index: number, partId: string, placement: unknown): string => `${kind}-instance-${index}-${digest({ kind, index, partId, placement })}`;
  const instances: PartInstance[] = [];
  const hubInstanceIds = hubCenters.map((axialZ, index) => {
    const result = instanceId('hub', index, hubId, { axialZ });
    instances.push({ id: result, partId: hubId, axialZ });
    return result;
  });
  const ribInstanceIds = ribIds.map((partId, index) => {
    const angleRad = index * Math.PI * 2 / options.ribCount;
    const result = instanceId('rib', index, partId, { axialZ: 0, angleRad });
    instances.push({ id: result, partId, axialZ: 0, angleRad });
    return result;
  });
  const ringInstanceIds = ringIds.map((partId, index) => {
    const axialZ = ringCenters[index], result = instanceId('ring', index, partId, { axialZ });
    instances.push({ id: result, partId, axialZ });
    return result;
  });
  const spacerInstanceIds: string[] = [];
  if (spacerId) {
    const horizontalCenters = [...hubCenters, ...ringCenters];
    const stackMinimum = Math.min(...horizontalCenters), stackMaximum = Math.max(...horizontalCenters);
    for (const [index, axialZ] of [stackMinimum - material.thicknessMm, stackMaximum + material.thicknessMm].entries()) {
      const result = instanceId('spacer', index, spacerId, { axialZ, side: index === 0 ? 'negative-z' : 'positive-z' });
      spacerInstanceIds.push(result); instances.push({ id: result, partId: spacerId, axialZ });
    }
  }
  const joints = [], assembly: AssemblyEdge[] = []; let order = 0;
  for (let rib = 0; rib < ribIds.length; rib += 1) {
    const direction: Point2 = [Math.cos(rib * Math.PI * 2 / options.ribCount), Math.sin(rib * Math.PI * 2 / options.ribCount)];
    for (let layer = 0; layer < hubFrames.length; layer += 1) {
      const hubFrame = hubFrames[layer][rib], hubContact = contactPolygon(hubFrame), hubCut = hubGeometry.cuts[rib];
      const hubJoint = `joint-${digest({ slot: hubId, slotInstanceId: hubInstanceIds[layer], tab: ribIds[rib], tabInstanceId: ribInstanceIds[rib], frame: hubFrame })}`;
      joints.push(...jointPair(hubJoint, hubId, ribIds[rib], hubInstanceIds[layer], ribInstanceIds[rib], hubFrame, [hubFrame.radialMin * direction[0], hubFrame.radialMin * direction[1]], direction, [hubFrame.axialZ, (hubFrame.radialMin + hubFrame.radialMax) / 2], [0, 1], hubCut, hubContact));
      assembly.push({ kind: 'joint', fromPartId: hubId, toPartId: ribIds[rib], fromInstanceId: hubInstanceIds[layer], toInstanceId: ribInstanceIds[rib], jointId: hubJoint, order: order++ });
    }
    for (let layer = 0; layer < ringIds.length; layer += 1) {
      const frame = ringFrames[layer][rib], contact = contactPolygon(frame);
      const joint = `joint-${digest({ slot: ringIds[layer], slotInstanceId: ringInstanceIds[layer], tab: ribIds[rib], tabInstanceId: ribInstanceIds[rib], frame })}`;
      const ringPosition = [frame.radialMin * direction[0], frame.radialMin * direction[1]] as Point2;
      joints.push(...jointPair(joint, ringIds[layer], ribIds[rib], ringInstanceIds[layer], ribInstanceIds[rib], frame, ringPosition, direction, [frame.axialZ, (frame.radialMin + frame.radialMax) / 2], [0, 1], ringCuts[layer][rib], contact));
      assembly.push({ kind: 'joint', fromPartId: ringIds[layer], toPartId: ribIds[rib], fromInstanceId: ringInstanceIds[layer], toInstanceId: ribInstanceIds[rib], jointId: joint, order: order++ });
    }
  }
  if (spacerId) {
    assembly.push({ kind: 'placement', placementId: `placement-${digest({ hubInstanceId: hubInstanceIds[0], spacerInstanceId: spacerInstanceIds[0], side: -1 })}`, partId: spacerId, relativeToPartId: hubId, partInstanceId: spacerInstanceIds[0], relativeToInstanceId: hubInstanceIds[0], instance: 'negative-z', side: 'negative-z', order: order++ });
    assembly.push({ kind: 'placement', placementId: `placement-${digest({ hubInstanceId: hubInstanceIds.at(-1), spacerInstanceId: spacerInstanceIds[1], side: 1 })}`, partId: spacerId, relativeToPartId: hubId, partInstanceId: spacerInstanceIds[1], relativeToInstanceId: hubInstanceIds.at(-1)!, instance: 'positive-z', side: 'positive-z', order: order++ });
  }
  const kit: SpinnerKit = { parts, instances, joints, assembly, estimatedBalance: { kind: 'ideal-static-estimate', status: 'pass', centroidOffsetMm: 0, angularMassError: 0, assumptions: ['uniform material', 'ideal cuts', 'equal angular rib spacing', 'static estimate only'] } };
  validateAssemblyCollisions(kit, material, profile);
  return kit;
}
