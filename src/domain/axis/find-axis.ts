import type { Axis, Vec3 } from '../types';
import { massProperties } from '../mesh/mass-properties';
import type { TriangleMesh } from '../mesh/types';
import { radialSymmetry, type SurfaceSample } from './radial-symmetry';

export type AxisCandidate = Axis & {
  readonly radialRmsError: number;
  readonly centroidOffset: number;
  readonly source: 'inertia' | 'hole' | 'manual';
};

function canonical(direction: Vec3): Vec3 {
  let dominant = 0;
  for (let index = 1; index < 3; index += 1) {
    if (Math.abs(direction[index]) > Math.abs(direction[dominant])) dominant = index;
  }
  return direction[dominant] < 0
    ? [-direction[0], -direction[1], -direction[2]]
    : direction;
}

function eigenvectors(matrix: number[][]): Vec3[] {
  const a = matrix.map((row) => [...row]);
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let matrixScale = 0;
  for (const row of a) for (const value of row) matrixScale = Math.max(matrixScale, Math.abs(value));
  if (matrixScale === 0) throw new RangeError('Degenerate surface covariance');
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let p = 0;
    let q = 1;
    for (const [row, column] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[row][column]) > Math.abs(a[p][q])) [p, q] = [row, column];
    }
    if (Math.abs(a[p][q]) <= 16 * Number.EPSILON * matrixScale) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let index = 0; index < 3; index += 1) {
      const aip = a[index][p];
      const aiq = a[index][q];
      a[index][p] = cosine * aip - sine * aiq;
      a[index][q] = sine * aip + cosine * aiq;
    }
    for (let index = 0; index < 3; index += 1) {
      const api = a[p][index];
      const aqi = a[q][index];
      a[p][index] = cosine * api - sine * aqi;
      a[q][index] = sine * api + cosine * aqi;
    }
    a[p][q] = a[q][p] = 0;
    for (let index = 0; index < 3; index += 1) {
      const vip = vectors[index][p];
      const viq = vectors[index][q];
      vectors[index][p] = cosine * vip - sine * viq;
      vectors[index][q] = sine * vip + cosine * viq;
    }
  }
  return [0, 1, 2].map((column) => canonical([
    vectors[0][column], vectors[1][column], vectors[2][column],
  ]));
}

function referencedMesh(mesh: TriangleMesh): TriangleMesh {
  const mapping = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  for (let offset = 0; offset < mesh.indices.length; offset += 1) {
    const original = mesh.indices[offset];
    let compact = mapping.get(original);
    if (compact === undefined) {
      compact = mapping.size;
      mapping.set(original, compact);
      positions.push(mesh.positions[original * 3], mesh.positions[original * 3 + 1], mesh.positions[original * 3 + 2]);
    }
    indices[offset] = compact;
  }
  return { positions: new Float64Array(positions), indices };
}

function surfaceSamples(mesh: TriangleMesh, sampleCount: number): SurfaceSample[] {
  const samples: SurfaceSample[] = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ai = mesh.indices[offset] * 3;
    const bi = mesh.indices[offset + 1] * 3;
    const ci = mesh.indices[offset + 2] * 3;
    const abx = mesh.positions[bi] - mesh.positions[ai];
    const aby = mesh.positions[bi + 1] - mesh.positions[ai + 1];
    const abz = mesh.positions[bi + 2] - mesh.positions[ai + 2];
    const acx = mesh.positions[ci] - mesh.positions[ai];
    const acy = mesh.positions[ci + 1] - mesh.positions[ai + 1];
    const acz = mesh.positions[ci + 2] - mesh.positions[ai + 2];
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    const area = Math.hypot(crossX, crossY, crossZ) / 2;
    if (area === 0) continue;
    for (const barycentric of [[2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]] as const) {
      samples.push({
        point: [
          barycentric[0] * mesh.positions[ai] + barycentric[1] * mesh.positions[bi] + barycentric[2] * mesh.positions[ci],
          barycentric[0] * mesh.positions[ai + 1] + barycentric[1] * mesh.positions[bi + 1] + barycentric[2] * mesh.positions[ci + 1],
          barycentric[0] * mesh.positions[ai + 2] + barycentric[1] * mesh.positions[bi + 2] + barycentric[2] * mesh.positions[ci + 2],
        ],
        weight: area / 3,
      });
    }
  }
  if (samples.length === 0) throw new RangeError('Degenerate mesh surface');
  samples.sort((left, right) =>
    left.point[0] - right.point[0] || left.point[1] - right.point[1] || left.point[2] - right.point[2] || left.weight - right.weight
  );
  const quadratureLimit = sampleCount * 3;
  if (samples.length <= quadratureLimit) return samples;
  return Array.from(
    { length: quadratureLimit },
    (_, index) => samples[Math.floor(index * samples.length / quadratureLimit)],
  );
}

export function findAxisCandidates(
  mesh: TriangleMesh,
  options: { readonly sampleCount: number },
): AxisCandidate[] {
  if (!Number.isInteger(options.sampleCount) || options.sampleCount <= 0 || options.sampleCount > 100_000) {
    throw new RangeError('sampleCount must be a positive integer no greater than 100000');
  }
  if (mesh.positions.length % 3 !== 0 || mesh.positions.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Mesh positions must contain finite xyz coordinates');
  }
  const vertexCount = mesh.positions.length / 3;
  if (mesh.indices.length % 3 !== 0) throw new TypeError('Mesh indices must contain complete triangles');
  if (mesh.indices.some((index) => index >= vertexCount)) {
    throw new RangeError('Mesh triangle index is outside the vertex buffer');
  }
  const referenced = referencedMesh(mesh);
  const { centroid } = massProperties(referenced);
  const samples = surfaceSamples(referenced, options.sampleCount);
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let totalWeight = 0;
  for (const { point, weight } of samples) {
    const delta = [point[0] - centroid[0], point[1] - centroid[1], point[2] - centroid[2]];
    totalWeight += weight;
    for (let row = 0; row < 3; row += 1) {
      for (let column = row; column < 3; column += 1) {
        covariance[row][column] += weight * delta[row] * delta[column];
      }
    }
  }
  for (let row = 0; row < 3; row += 1) for (let column = row; column < 3; column += 1) {
    covariance[row][column] /= totalWeight;
    covariance[column][row] = covariance[row][column];
  }
  return eigenvectors(covariance).map((direction) => ({
    origin: centroid,
    direction,
    confirmed: false,
    source: 'inertia' as const,
    ...radialSymmetry(samples, centroid, direction),
  })).sort((left, right) =>
    right.confidence - left.confidence ||
    right.direction[2] - left.direction[2] ||
    right.direction[1] - left.direction[1] ||
    right.direction[0] - left.direction[0]
  );
}
