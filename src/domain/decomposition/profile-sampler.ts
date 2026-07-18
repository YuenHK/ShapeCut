import type { Axis, Vec3 } from '../types';
import type { TriangleMesh } from '../mesh/types';
import { DecompositionError, type LathedProfile } from './types';

const MAX_TRIANGLES = 1_000_000;
const MAX_BINS = 512;
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vector(value: unknown): value is Vec3 { return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite); }

export function sampleLathedProfile(meshValue: unknown, axisValue: unknown, binCount = 64): LathedProfile {
  if (meshValue === null || typeof meshValue !== 'object') throw new DecompositionError('PROFILE', 'Mesh must be an object');
  const mesh = meshValue as TriangleMesh;
  if (!(mesh.positions instanceof Float64Array) || mesh.positions.length === 0 || mesh.positions.length % 3 !== 0 || !(mesh.indices instanceof Uint32Array) || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0 || mesh.indices.length / 3 > MAX_TRIANGLES) throw new DecompositionError('PROFILE', 'Mesh buffers must contain bounded indexed triangles');
  for (let index = 0; index < mesh.positions.length; index += 1) if (!Number.isFinite(mesh.positions[index])) throw new DecompositionError('PROFILE', 'Mesh positions must be finite');
  for (let index = 0; index < mesh.indices.length; index += 1) if (mesh.indices[index] >= mesh.positions.length / 3) throw new DecompositionError('PROFILE', 'Mesh index out of range');
  if (axisValue === null || typeof axisValue !== 'object') throw new DecompositionError('PROFILE', 'Axis must be an object');
  const axis = axisValue as Axis;
  if (!axis.confirmed || !vector(axis.origin) || !vector(axis.direction)) throw new DecompositionError('PROFILE', 'Axis must be finite and confirmed');
  const length = Math.hypot(axis.direction[0], axis.direction[1], axis.direction[2]);
  if (!Number.isFinite(length) || length === 0 || !Number.isInteger(binCount) || binCount < 2 || binCount > MAX_BINS) throw new DecompositionError('PROFILE', 'Axis and bin count must be valid');
  const direction: Vec3 = [axis.direction[0] / length, axis.direction[1] / length, axis.direction[2] / length];
  let minZ = Infinity, maxZ = -Infinity;
  const vertexZ = new Float64Array(mesh.positions.length / 3);
  for (let vertex = 0; vertex < vertexZ.length; vertex += 1) {
    const offset = vertex * 3;
    const relative: Vec3 = [mesh.positions[offset] - axis.origin[0], mesh.positions[offset + 1] - axis.origin[1], mesh.positions[offset + 2] - axis.origin[2]];
    vertexZ[vertex] = dot(relative, direction);
    minZ = Math.min(minZ, vertexZ[vertex]); maxZ = Math.max(maxZ, vertexZ[vertex]);
  }
  if (!(maxZ > minZ)) throw new DecompositionError('PROFILE', 'Mesh has no axial extent');
  const radii = new Float64Array(binCount); radii.fill(-Infinity);
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const ids = [mesh.indices[triangle], mesh.indices[triangle + 1], mesh.indices[triangle + 2]];
    let triMin = Infinity, triMax = -Infinity;
    for (let i = 0; i < 3; i += 1) { triMin = Math.min(triMin, vertexZ[ids[i]]); triMax = Math.max(triMax, vertexZ[ids[i]]); }
    const first = Math.max(0, Math.ceil((triMin - minZ) / (maxZ - minZ) * (binCount - 1) - 1e-12));
    const last = Math.min(binCount - 1, Math.floor((triMax - minZ) / (maxZ - minZ) * (binCount - 1) + 1e-12));
    for (let bin = first; bin <= last; bin += 1) {
      const plane = minZ + (maxZ - minZ) * bin / (binCount - 1);
      for (let edge = 0; edge < 3; edge += 1) {
        const a = ids[edge], b = ids[(edge + 1) % 3], za = vertexZ[a], zb = vertexZ[b];
        if (plane < Math.min(za, zb) - 1e-12 || plane > Math.max(za, zb) + 1e-12) continue;
        const t = za === zb ? 0 : (plane - za) / (zb - za);
        if (t < 0 || t > 1) continue;
        const ao = a * 3, bo = b * 3;
        const point: Vec3 = [mesh.positions[ao] + (mesh.positions[bo] - mesh.positions[ao]) * t, mesh.positions[ao + 1] + (mesh.positions[bo + 1] - mesh.positions[ao + 1]) * t, mesh.positions[ao + 2] + (mesh.positions[bo + 2] - mesh.positions[ao + 2]) * t];
        const relative: Vec3 = [point[0] - axis.origin[0], point[1] - axis.origin[1], point[2] - axis.origin[2]];
        const z = dot(relative, direction);
        const rx = relative[0] - z * direction[0], ry = relative[1] - z * direction[1], rz = relative[2] - z * direction[2];
        radii[bin] = Math.max(radii[bin], Math.hypot(rx, ry, rz));
      }
    }
  }
  const samples = [];
  for (let bin = 0; bin < binCount; bin += 1) {
    if (!Number.isFinite(radii[bin])) throw new DecompositionError('PROFILE', 'Surface does not intersect every axial sample plane');
    samples.push({ z: minZ + (maxZ - minZ) * bin / (binCount - 1), radius: radii[bin] });
  }
  return { samples };
}
