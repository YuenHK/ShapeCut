import type { Axis, Vec3 } from '../types';
import type { TriangleMesh } from '../mesh/types';
import { DecompositionError, type LathedProfile } from './types';

const MAX_TRIANGLES = 1_000_000;
const MAX_BINS = 512;
const TRIANGLE_RELATIVE_EPSILON = 64 * Number.EPSILON;
const SPLITTER = 134_217_729;
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
type CandidateTriangle = { readonly ids: readonly [number, number, number] };
type ValidTriangle = CandidateTriangle & { readonly axialMin: number; readonly axialMax: number };

function vector(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function twoDifference(left: number, right: number): readonly [number, number] {
  const difference = left - right;
  const rightVirtual = left - difference;
  const leftVirtual = difference + rightVirtual;
  return [difference, (left - leftVirtual) + (rightVirtual - right)];
}

function twoProduct(left: number, right: number): readonly [number, number] {
  const product = left * right;
  if (!Number.isFinite(product) || Math.abs(left) > Number.MAX_VALUE / SPLITTER || Math.abs(right) > Number.MAX_VALUE / SPLITTER) return [product, 0];
  const leftSplit = SPLITTER * left, leftHigh = leftSplit - (leftSplit - left), leftLow = left - leftHigh;
  const rightSplit = SPLITTER * right, rightHigh = rightSplit - (rightSplit - right), rightLow = right - rightHigh;
  const error = leftLow * rightLow - (((product - leftHigh * rightHigh) - leftLow * rightHigh) - leftHigh * rightLow);
  return [product, error];
}

/** Compensated a*b-c*d, used for Plucker moments whose leading products cancel. */
function productDifference(a: number, b: number, c: number, d: number): number {
  const [left, leftError] = twoProduct(a, b), [right, rightError] = twoProduct(c, d);
  const [difference, differenceError] = twoDifference(left, right);
  return difference + (leftError - rightError + differenceError);
}

function robustCross(left: Vec3, right: Vec3): Vec3 {
  return [
    productDifference(left[1], right[2], left[2], right[1]),
    productDifference(left[2], right[0], left[0], right[2]),
    productDifference(left[0], right[1], left[1], right[0]),
  ];
}

function dot(left: Vec3, right: Vec3): number {
  const [x, xError] = twoProduct(left[0], right[0]);
  const [y, yError] = twoProduct(left[1], right[1]);
  const [z, zError] = twoProduct(left[2], right[2]);
  const xy = x + y, xyError = Math.abs(x) >= Math.abs(y) ? (x - xy) + y : (y - xy) + x;
  const xyz = xy + z, xyzError = Math.abs(xy) >= Math.abs(z) ? (xy - xyz) + z : (z - xyz) + xy;
  return xyz + (xError + yError + zError + xyError + xyzError);
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function localTriangleIsValid(positions: Float64Array, ids: readonly [number, number, number]): boolean {
  const a = ids[0] * 3, b = ids[1] * 3, c = ids[2] * 3;
  const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
  const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
  const bcx = positions[c] - positions[b], bcy = positions[c + 1] - positions[b + 1], bcz = positions[c + 2] - positions[b + 2];
  const ab = Math.hypot(abx, aby, abz), ac = Math.hypot(acx, acy, acz), bc = Math.hypot(bcx, bcy, bcz);
  const edgeScale = Math.max(ab, ac, bc), shortest = Math.min(ab, ac, bc);
  if (!Number.isFinite(edgeScale) || !(edgeScale > 0) || shortest <= edgeScale * TRIANGLE_RELATIVE_EPSILON) return false;
  const ux = abx / edgeScale, uy = aby / edgeScale, uz = abz / edgeScale;
  const vx = acx / edgeScale, vy = acy / edgeScale, vz = acz / edgeScale;
  const normalizedArea = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  return Number.isFinite(normalizedArea) && normalizedArea > TRIANGLE_RELATIVE_EPSILON;
}

function planeTolerance(span: number, left: number, right: number): number {
  return Math.max(
    Number.MIN_VALUE,
    span * 64 * Number.EPSILON,
    32 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)),
  );
}

/** Sorts and clusters only values representing the same plane; the median member is deterministic. */
function clusterPlanes(values: number[], span: number): number[] {
  values.sort((left, right) => left - right);
  const clustered: number[] = [];
  let start = 0;
  while (start < values.length) {
    let end = start + 1;
    while (end < values.length && values[end] - values[start] <= planeTolerance(span, values[start], values[end])) end += 1;
    clustered.push(values[Math.floor((start + end - 1) / 2)]);
    start = end;
  }
  return clustered;
}

function finiteTrianglePositions(mesh: TriangleMesh, ids: readonly [number, number, number]): void {
  for (const vertex of ids) {
    const offset = vertex * 3;
    if (!Number.isFinite(mesh.positions[offset]) || !Number.isFinite(mesh.positions[offset + 1]) || !Number.isFinite(mesh.positions[offset + 2])) {
      throw new DecompositionError('PROFILE', 'Referenced mesh positions must be finite');
    }
  }
}

function validTriangleCandidates(mesh: TriangleMesh): { readonly triangles: CandidateTriangle[]; readonly vertices: Set<number> } {
  const vertexCount = mesh.positions.length / 3;
  const triangles: CandidateTriangle[] = [], vertices = new Set<number>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]] as const;
    if (ids[0] >= vertexCount || ids[1] >= vertexCount || ids[2] >= vertexCount) throw new DecompositionError('PROFILE', 'Mesh index out of range');
    finiteTrianglePositions(mesh, ids);
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[2] === ids[0] || !localTriangleIsValid(mesh.positions, ids)) continue;
    triangles.push({ ids });
    vertices.add(ids[0]); vertices.add(ids[1]); vertices.add(ids[2]);
  }
  if (triangles.length === 0 || vertices.size === 0) throw new DecompositionError('PROFILE', 'Mesh has no valid finite nondegenerate surface triangles');
  return { triangles, vertices };
}

function validVertexReference(mesh: TriangleMesh, vertices: ReadonlySet<number>): Vec3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const vertex of vertices) {
    const offset = vertex * 3, x = mesh.positions[offset], y = mesh.positions[offset + 1], z = mesh.positions[offset + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return [minX / 2 + maxX / 2, minY / 2 + maxY / 2, minZ / 2 + maxZ / 2];
}

/** Vector from the mesh-local reference to the closest point on the infinite axis line. */
function stableAxisPerpendicular(axis: Axis, reference: Vec3): { readonly direction: Vec3; readonly perpendicular: Vec3 } {
  const directionScale = Math.max(Math.abs(axis.direction[0]), Math.abs(axis.direction[1]), Math.abs(axis.direction[2]));
  const powerOfTwo = 2 ** Math.floor(Math.log2(directionScale));
  const scaled: Vec3 = [axis.direction[0] / powerOfTwo, axis.direction[1] / powerOfTwo, axis.direction[2] / powerOfTwo];
  const length = Math.hypot(scaled[0], scaled[1], scaled[2]), lengthSquared = length * length;
  const direction: Vec3 = [scaled[0] / length, scaled[1] / length, scaled[2] / length];
  const originMoment = robustCross(axis.origin, scaled), referenceMoment = robustCross(reference, scaled);
  const moment: Vec3 = [
    twoDifference(originMoment[0], referenceMoment[0]).reduce((sum, value) => sum + value, 0),
    twoDifference(originMoment[1], referenceMoment[1]).reduce((sum, value) => sum + value, 0),
    twoDifference(originMoment[2], referenceMoment[2]).reduce((sum, value) => sum + value, 0),
  ];
  const numerator = robustCross(scaled, moment);
  const perpendicular: Vec3 = [numerator[0] / lengthSquared, numerator[1] / lengthSquared, numerator[2] / lengthSquared];
  if (![...direction, ...perpendicular].every(Number.isFinite)) throw new DecompositionError('PROFILE', 'Axis line cannot be represented stably');
  return { direction, perpendicular };
}

export function sampleLathedProfile(meshValue: unknown, axisValue: unknown, binCount = 64, internals: Internals = {}): LathedProfile {
  if (meshValue === null || typeof meshValue !== 'object') throw new DecompositionError('PROFILE', 'Mesh must be an object');
  const mesh = meshValue as TriangleMesh;
  if (!(mesh.positions instanceof Float64Array) || mesh.positions.length === 0 || mesh.positions.length % 3 !== 0
    || !(mesh.indices instanceof Uint32Array) || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0
    || mesh.indices.length / 3 > MAX_TRIANGLES) {
    throw new DecompositionError('PROFILE', 'Mesh buffers must contain bounded indexed triangles');
  }
  if (axisValue === null || typeof axisValue !== 'object') throw new DecompositionError('PROFILE', 'Axis must be an object');
  const axis = axisValue as Axis;
  if (!axis.confirmed || !vector(axis.origin) || !vector(axis.direction)) throw new DecompositionError('PROFILE', 'Axis must be finite and confirmed');
  const directionLength = Math.hypot(axis.direction[0], axis.direction[1], axis.direction[2]);
  if (!Number.isFinite(directionLength) || directionLength === 0 || !Number.isInteger(binCount) || binCount < 2 || binCount > MAX_BINS) {
    throw new DecompositionError('PROFILE', 'Axis and bin count must be valid');
  }

  // Invalid faces are discarded before they can influence any global reference or tolerance.
  const candidates = validTriangleCandidates(mesh);
  const reference = validVertexReference(mesh, candidates.vertices);
  const { direction, perpendicular: axisPerpendicular } = stableAxisPerpendicular(axis, reference);
  const projected = new Map<number, ProjectedVertex>();
  for (const vertex of candidates.vertices) {
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
  for (const triangle of candidates.triangles) {
    const a = projected.get(triangle.ids[0])!.axial, b = projected.get(triangle.ids[1])!.axial, c = projected.get(triangle.ids[2])!.axial;
    triangles.push({ ...triangle, axialMin: Math.min(a, b, c), axialMax: Math.max(a, b, c) });
  }
  let minZ = Infinity, maxZ = -Infinity;
  for (const vertex of candidates.vertices) {
    const axial = projected.get(vertex)!.axial;
    minZ = Math.min(minZ, axial); maxZ = Math.max(maxZ, axial);
  }
  if (!(maxZ > minZ)) throw new DecompositionError('PROFILE', 'Mesh has no axial extent');
  const span = maxZ - minZ;
  const rawPlanes: number[] = [];
  for (let bin = 0; bin < binCount; bin += 1) rawPlanes.push(minZ + span * bin / (binCount - 1));
  for (const vertex of candidates.vertices) rawPlanes.push(projected.get(vertex)!.axial);
  const planes = clusterPlanes(rawPlanes, span);
  if (planes.length > MAX_PROFILE_SAMPLES) throw new DecompositionError('PROFILE', `Conservative profile requires more than ${MAX_PROFILE_SAMPLES} samples`);
  const tolerance = planeTolerance(span, minZ, maxZ);

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
