import type { Axis, Vec3 } from '../types';
import type { TriangleMesh } from '../mesh/types';
import { DecompositionError, type LathedProfile } from './types';

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function vector(value: unknown): value is Vec3 { return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite); }

export function sampleLathedProfile(meshValue: unknown, axisValue: unknown, binCount = 64): LathedProfile {
  if (meshValue === null || typeof meshValue !== 'object') throw new DecompositionError('PROFILE', 'Mesh must be an object');
  const mesh = meshValue as TriangleMesh;
  if (!(mesh.positions instanceof Float64Array) || mesh.positions.length === 0 || mesh.positions.length % 3 !== 0 || !(mesh.indices instanceof Uint32Array) || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0 || [...mesh.indices].some((index) => index >= mesh.positions.length / 3) || [...mesh.positions].some((value) => !Number.isFinite(value))) {
    throw new DecompositionError('PROFILE', 'Mesh buffers must contain finite, indexed triangles');
  }
  if (axisValue === null || typeof axisValue !== 'object') throw new DecompositionError('PROFILE', 'Axis must be an object');
  const axis = axisValue as Axis;
  if (!axis.confirmed || !vector(axis.origin) || !vector(axis.direction)) throw new DecompositionError('PROFILE', 'Axis must be finite and confirmed');
  const length = Math.hypot(...axis.direction);
  if (!Number.isFinite(length) || length === 0 || !Number.isInteger(binCount) || binCount < 2) {
    throw new DecompositionError('PROFILE', 'Axis and bin count must be valid');
  }
  const direction: Vec3 = axis.direction.map((value) => value / length) as unknown as Vec3;
  const vertices: { z: number; radius: number }[] = [];
  const referenced = [...new Set(mesh.indices)];
  for (const vertexIndex of referenced) {
    const index = vertexIndex * 3;
    const relative: Vec3 = [mesh.positions[index] - axis.origin[0], mesh.positions[index + 1] - axis.origin[1], mesh.positions[index + 2] - axis.origin[2]];
    const z = dot(relative, direction);
    const radial: Vec3 = [relative[0] - z * direction[0], relative[1] - z * direction[1], relative[2] - z * direction[2]];
    vertices.push({ z, radius: Math.hypot(...radial) });
  }
  if (vertices.length === 0 || vertices.some(({ z, radius }) => !Number.isFinite(z) || !Number.isFinite(radius))) {
    throw new DecompositionError('PROFILE', 'Mesh positions must be finite and non-empty');
  }
  const min = Math.min(...vertices.map(({ z }) => z));
  const max = Math.max(...vertices.map(({ z }) => z));
  if (max <= min) throw new DecompositionError('PROFILE', 'Mesh has no axial extent');
  const bins = Array.from({ length: binCount }, () => ({ radius: -Infinity, zSum: 0, count: 0 }));
  for (const vertex of vertices) {
    const index = Math.min(binCount - 1, Math.floor(((vertex.z - min) / (max - min)) * binCount));
    bins[index].radius = Math.max(bins[index].radius, vertex.radius);
    bins[index].zSum += vertex.z;
    bins[index].count += 1;
  }
  return { samples: bins.filter(({ count }) => count > 0).map((bin) => ({ z: bin.zSum / bin.count, radius: bin.radius })) };
}
