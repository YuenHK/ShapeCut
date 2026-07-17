import type { Axis, Vec3 } from '../types';
import { massProperties } from '../mesh/mass-properties';
import type { TriangleMesh } from '../mesh/types';
import { radialSymmetry } from './radial-symmetry';

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
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let p = 0;
    let q = 1;
    for (const [row, column] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[row][column]) > Math.abs(a[p][q])) [p, q] = [row, column];
    }
    if (Math.abs(a[p][q]) <= Number.EPSILON * Math.max(1, Math.abs(a[p][p]), Math.abs(a[q][q]))) break;
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

export function findAxisCandidates(
  mesh: TriangleMesh,
  options: { readonly sampleCount: number },
): AxisCandidate[] {
  if (!Number.isInteger(options.sampleCount) || options.sampleCount <= 0) {
    throw new RangeError('sampleCount must be a positive integer');
  }
  if (mesh.positions.length % 3 !== 0 || mesh.positions.some((value) => !Number.isFinite(value))) {
    throw new TypeError('Mesh positions must contain finite xyz coordinates');
  }
  const vertexCount = mesh.positions.length / 3;
  if (mesh.indices.some((index) => index >= vertexCount)) {
    throw new RangeError('Mesh triangle index is outside the vertex buffer');
  }
  const { centroid } = massProperties(mesh);
  const count = Math.min(options.sampleCount, vertexCount);
  const points: Vec3[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    const vertex = Math.floor(sample * vertexCount / count) * 3;
    points.push([mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]]);
  }
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const point of points) {
    const delta = [point[0] - centroid[0], point[1] - centroid[1], point[2] - centroid[2]];
    for (let row = 0; row < 3; row += 1) {
      for (let column = row; column < 3; column += 1) {
        covariance[row][column] += delta[row] * delta[column] / points.length;
        covariance[column][row] = covariance[row][column];
      }
    }
  }
  return eigenvectors(covariance).map((direction) => ({
    origin: centroid,
    direction,
    confirmed: false,
    source: 'inertia' as const,
    ...radialSymmetry(points, centroid, direction),
  })).sort((left, right) =>
    right.confidence - left.confidence ||
    right.direction[2] - left.direction[2] ||
    right.direction[1] - left.direction[1] ||
    right.direction[0] - left.direction[0]
  );
}
