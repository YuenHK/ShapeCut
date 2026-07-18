import type { Axis, Vec3 } from '../types';
import { meshNumerics } from '../mesh/numerics';
import type { TriangleMesh } from '../mesh/types';
import { DecompositionError, type LathedProfile } from './types';

const MAX_TRIANGLES = 1_000_000;
const MAX_BINS = 512;
export const MAX_PROFILE_SAMPLES = 4096;
export const MAX_INTERSECTION_WORK = 2_000_000;

export type ProfileSamplingStats = {
  readonly validTriangleCount: number;
  readonly sampleCount: number;
  readonly intersectionWork: number;
  readonly budgetExceeded: boolean;
};

type Internals = { readonly onStats?: (stats: ProfileSamplingStats) => void };
type ProjectedVertex = { readonly axial: number; readonly radial: Vec3 };
type ValidTriangle = { readonly ids: readonly [number, number, number]; readonly axialMin: number; readonly axialMax: number };

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vector(value: unknown): value is Vec3 { return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite); }

function lowerBound(values: readonly number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (values[middle] < target) low = middle + 1; else high = middle; }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (values[middle] <= target) low = middle + 1; else high = middle; }
  return low;
}

export function sampleLathedProfile(meshValue: unknown, axisValue: unknown, binCount = 64, internals: Internals = {}): LathedProfile {
  if (meshValue === null || typeof meshValue !== 'object') throw new DecompositionError('PROFILE', 'Mesh must be an object');
  const mesh = meshValue as TriangleMesh;
  if (!(mesh.positions instanceof Float64Array) || mesh.positions.length === 0 || mesh.positions.length % 3 !== 0 || !(mesh.indices instanceof Uint32Array) || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0 || mesh.indices.length / 3 > MAX_TRIANGLES) throw new DecompositionError('PROFILE', 'Mesh buffers must contain bounded indexed triangles');
  const vertexCount = mesh.positions.length / 3;
  const referenced = new Set<number>();
  for (let offset = 0; offset < mesh.indices.length; offset += 1) {
    const index = mesh.indices[offset];
    if (index >= vertexCount) throw new DecompositionError('PROFILE', 'Mesh index out of range');
    referenced.add(index);
  }
  const referencedPositions = new Float64Array(referenced.size * 3);
  let referencedOffset = 0;
  for (const vertex of referenced) {
    const offset = vertex * 3;
    const x = mesh.positions[offset], y = mesh.positions[offset + 1], z = mesh.positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new DecompositionError('PROFILE', 'Referenced mesh positions must be finite');
    referencedPositions.set([x, y, z], referencedOffset);
    referencedOffset += 3;
  }
  if (axisValue === null || typeof axisValue !== 'object') throw new DecompositionError('PROFILE', 'Axis must be an object');
  const axis = axisValue as Axis;
  if (!axis.confirmed || !vector(axis.origin) || !vector(axis.direction)) throw new DecompositionError('PROFILE', 'Axis must be finite and confirmed');
  const directionLength = Math.hypot(axis.direction[0], axis.direction[1], axis.direction[2]);
  if (!Number.isFinite(directionLength) || directionLength === 0 || !Number.isInteger(binCount) || binCount < 2 || binCount > MAX_BINS) throw new DecompositionError('PROFILE', 'Axis and bin count must be valid');
  const direction: Vec3 = [axis.direction[0] / directionLength, axis.direction[1] / directionLength, axis.direction[2] / directionLength];
  const numerics = meshNumerics({ positions: referencedPositions, indices: new Uint32Array() });
  const reference = numerics.reference;
  const axisRelative: Vec3 = [axis.origin[0] - reference[0], axis.origin[1] - reference[1], axis.origin[2] - reference[2]];
  const axisAxial = dot(axisRelative, direction);
  const axisPerpendicular: Vec3 = [axisRelative[0] - axisAxial * direction[0], axisRelative[1] - axisAxial * direction[1], axisRelative[2] - axisAxial * direction[2]];
  const projected = new Map<number, ProjectedVertex>();
  for (const vertex of referenced) {
    const offset = vertex * 3;
    const local: Vec3 = [mesh.positions[offset] - reference[0], mesh.positions[offset + 1] - reference[1], mesh.positions[offset + 2] - reference[2]];
    const axial = dot(local, direction);
    projected.set(vertex, { axial, radial: [
      local[0] - axial * direction[0] - axisPerpendicular[0],
      local[1] - axial * direction[1] - axisPerpendicular[1],
      local[2] - axial * direction[2] - axisPerpendicular[2],
    ] });
  }
  const triangles: ValidTriangle[] = [];
  const validVertices = new Set<number>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]] as const;
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[2] === ids[0]) continue;
    const aOffset = ids[0] * 3, bOffset = ids[1] * 3, cOffset = ids[2] * 3;
    const abx = mesh.positions[bOffset] - mesh.positions[aOffset], aby = mesh.positions[bOffset + 1] - mesh.positions[aOffset + 1], abz = mesh.positions[bOffset + 2] - mesh.positions[aOffset + 2];
    const acx = mesh.positions[cOffset] - mesh.positions[aOffset], acy = mesh.positions[cOffset + 1] - mesh.positions[aOffset + 1], acz = mesh.positions[cOffset + 2] - mesh.positions[aOffset + 2];
    const crossX = aby * acz - abz * acy, crossY = abz * acx - abx * acz, crossZ = abx * acy - aby * acx;
    if (crossX * crossX + crossY * crossY + crossZ * crossZ <= numerics.areaToleranceSquared) continue;
    const za = projected.get(ids[0])!.axial, zb = projected.get(ids[1])!.axial, zc = projected.get(ids[2])!.axial;
    triangles.push({ ids, axialMin: Math.min(za, zb, zc), axialMax: Math.max(za, zb, zc) });
    validVertices.add(ids[0]); validVertices.add(ids[1]); validVertices.add(ids[2]);
  }
  if (triangles.length === 0 || validVertices.size === 0) throw new DecompositionError('PROFILE', 'Mesh has no valid finite nondegenerate surface triangles');
  let minZ = Infinity, maxZ = -Infinity;
  for (const vertex of validVertices) { const axial = projected.get(vertex)!.axial; minZ = Math.min(minZ, axial); maxZ = Math.max(maxZ, axial); }
  if (!(maxZ > minZ)) throw new DecompositionError('PROFILE', 'Mesh has no axial extent');
  const planeSet = new Set<number>();
  for (let bin = 0; bin < binCount; bin += 1) planeSet.add(minZ + (maxZ - minZ) * bin / (binCount - 1));
  for (const vertex of validVertices) { const axial = projected.get(vertex)!.axial; planeSet.add(Object.is(axial, -0) ? 0 : axial); }
  const planes = [...planeSet].sort((left, right) => left - right);
  if (planes.length > MAX_PROFILE_SAMPLES) throw new DecompositionError('PROFILE', `Conservative profile requires more than ${MAX_PROFILE_SAMPLES} samples`);
  const tolerance = Math.max(Number.MIN_VALUE, (maxZ - minZ) * 64 * Number.EPSILON);
  let intersectionWork = 0;
  for (const triangle of triangles) {
    const first = lowerBound(planes, triangle.axialMin - tolerance), last = upperBound(planes, triangle.axialMax + tolerance);
    const covered = Math.max(0, last - first);
    if (covered > MAX_INTERSECTION_WORK - intersectionWork) {
      internals.onStats?.({ validTriangleCount: triangles.length, sampleCount: planes.length, intersectionWork, budgetExceeded: true });
      throw new DecompositionError('PROFILE', `Triangle-plane intersection work exceeds ${MAX_INTERSECTION_WORK}`);
    }
    intersectionWork += covered;
  }
  const radii = new Float64Array(planes.length); radii.fill(-Infinity);
  for (const triangle of triangles) {
    const first = lowerBound(planes, triangle.axialMin - tolerance), last = upperBound(planes, triangle.axialMax + tolerance);
    for (let planeIndex = first; planeIndex < last; planeIndex += 1) {
      const plane = planes[planeIndex];
      for (let edge = 0; edge < 3; edge += 1) {
        const a = projected.get(triangle.ids[edge])!, b = projected.get(triangle.ids[(edge + 1) % 3])!;
        if (plane < Math.min(a.axial, b.axial) - tolerance || plane > Math.max(a.axial, b.axial) + tolerance) continue;
        const delta = b.axial - a.axial;
        if (Math.abs(delta) <= tolerance && Math.abs(plane - a.axial) > tolerance) continue;
        const t = Math.abs(delta) <= tolerance ? 0 : Math.max(0, Math.min(1, (plane - a.axial) / delta));
        const rx = a.radial[0] + (b.radial[0] - a.radial[0]) * t;
        const ry = a.radial[1] + (b.radial[1] - a.radial[1]) * t;
        const rz = a.radial[2] + (b.radial[2] - a.radial[2]) * t;
        radii[planeIndex] = Math.max(radii[planeIndex], Math.hypot(rx, ry, rz));
      }
    }
  }
  const samples = planes.map((z, index) => {
    if (!Number.isFinite(radii[index])) throw new DecompositionError('PROFILE', 'Surface does not intersect every axial sample plane');
    return { z, radius: radii[index] };
  });
  internals.onStats?.({ validTriangleCount: triangles.length, sampleCount: planes.length, intersectionWork, budgetExceeded: false });
  return { samples };
}
