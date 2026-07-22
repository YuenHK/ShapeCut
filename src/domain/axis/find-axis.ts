import type { Axis, Vec3 } from '../types';
import { massProperties } from '../mesh/mass-properties';
import type { TriangleMesh } from '../mesh/types';
import { radialSymmetry, type SurfaceSample } from './radial-symmetry';

export const AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD = 0.8;

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

function checkAxisRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Axis analysis exceeded the runtime budget');
}

function eigenvectors(matrix: number[][], deadline: number, checkpoint: () => void): Vec3[] {
  const a = matrix.map((row) => [...row]);
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let matrixScale = 0;
  for (const row of a) for (const value of row) matrixScale = Math.max(matrixScale, Math.abs(value));
  if (matrixScale === 0) throw new RangeError('Degenerate surface covariance');
  for (let iteration = 0; iteration < 32; iteration += 1) {
    checkAxisRuntime(deadline, checkpoint);
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

function referencedMesh(mesh: TriangleMesh, deadline: number, checkpoint: () => void): TriangleMesh {
  const mapping = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  for (let offset = 0; offset < mesh.indices.length; offset += 1) {
    if ((offset & 1023) === 0) checkAxisRuntime(deadline, checkpoint);
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

type WeightedTriangle = {
  readonly vertices: readonly [Vec3, Vec3, Vec3];
  readonly area: number;
  readonly priority: number;
  readonly geometryKey: string;
};

const QUADRATURE = [[2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]] as const;

function triangleGeometry(mesh: TriangleMesh, offset: number): { vertices: [Vec3, Vec3, Vec3]; area: number } | undefined {
  const indices = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
  const vertices = indices.map((index) => [
    mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2],
  ] as Vec3) as [Vec3, Vec3, Vec3];
  const [a, b, c] = vertices;
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const area = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2;
  return area === 0 ? undefined : { vertices, area };
}

function canonicalGeometryKey(vertices: readonly Vec3[], center: Vec3, scale: number): string {
  const ordered = [...vertices].sort((left, right) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  );
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const parts: string[] = [];
  for (const vertex of ordered) for (let component = 0; component < 3; component += 1) {
    const normalized = (vertex[component] - center[component]) / scale;
    view.setFloat64(0, Object.is(normalized, -0) ? 0 : normalized, true);
    parts.push(view.getUint32(4, true).toString(16).padStart(8, '0'));
    parts.push(view.getUint32(0, true).toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

function defaultPriorityHash(geometryKey: string): number {
  let hash = 2166136261;
  for (let index = 0; index < geometryKey.length; index += 1) {
    hash = Math.imul(hash ^ geometryKey.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

function compareRank(left: WeightedTriangle, right: WeightedTriangle): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.geometryKey < right.geometryKey ? -1 : left.geometryKey > right.geometryKey ? 1 : 0;
}

function heapPushBounded(
  heap: WeightedTriangle[],
  selectedKeys: Set<string>,
  triangle: WeightedTriangle,
  capacity: number,
): void {
  if (selectedKeys.has(triangle.geometryKey)) return;
  if (heap.length < capacity) {
    heap.push(triangle);
    selectedKeys.add(triangle.geometryKey);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareRank(heap[parent], heap[index]) >= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (compareRank(triangle, heap[0]) >= 0) return;
  selectedKeys.delete(heap[0].geometryKey);
  heap[0] = triangle;
  selectedKeys.add(triangle.geometryKey);
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const largest = right < heap.length && compareRank(heap[right], heap[left]) > 0 ? right : left;
    if (compareRank(heap[index], heap[largest]) >= 0) break;
    [heap[index], heap[largest]] = [heap[largest], heap[index]];
    index = largest;
  }
}

export function selectRadialSurfaceSamples(
  mesh: TriangleMesh,
  sampleCount: number,
  options: {
    readonly hashFn?: (geometryKey: string) => number;
    readonly deadline?: number;
    readonly checkpoint?: () => void;
  } = {},
): { readonly samples: SurfaceSample[]; readonly selectedTriangleCount: number } {
  const deadline = options.deadline ?? Infinity;
  const checkpoint = options.checkpoint ?? (() => undefined);
  checkAxisRuntime(deadline, checkpoint);
  const pointsPerTriangle = Math.min(3, sampleCount);
  const capacity = Math.max(1, Math.floor(sampleCount / pointsPerTriangle));
  const heap: WeightedTriangle[] = [];
  const selectedKeys = new Set<string>();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    if ((offset & 1023) === 0) checkAxisRuntime(deadline, checkpoint);
    const geometry = triangleGeometry(mesh, offset);
    if (!geometry) continue;
    for (const vertex of geometry.vertices) {
      minX = Math.min(minX, vertex[0]);
      minY = Math.min(minY, vertex[1]);
      minZ = Math.min(minZ, vertex[2]);
      maxX = Math.max(maxX, vertex[0]);
      maxY = Math.max(maxY, vertex[1]);
      maxZ = Math.max(maxZ, vertex[2]);
    }
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const hashScale = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  if (!Number.isFinite(hashScale) || hashScale === 0) throw new RangeError('Degenerate mesh surface');
  let totalArea = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    if ((offset & 1023) === 0) checkAxisRuntime(deadline, checkpoint);
    const geometry = triangleGeometry(mesh, offset);
    if (!geometry) continue;
    totalArea += geometry.area;
    const geometryKey = canonicalGeometryKey(geometry.vertices, center, hashScale);
    const hash = (options.hashFn ?? defaultPriorityHash)(geometryKey) >>> 0;
    const uniform = (hash + 0.5) / 0x1_0000_0000;
    heapPushBounded(heap, selectedKeys, {
      ...geometry,
      priority: -Math.log(uniform) / geometry.area,
      geometryKey,
    }, capacity);
  }
  if (heap.length === 0) throw new RangeError('Degenerate mesh surface');
  const representativeWeight = totalArea / heap.length / pointsPerTriangle;
  const samples: SurfaceSample[] = [];
  for (let heapIndex = 0; heapIndex < heap.length; heapIndex += 1) {
    if ((heapIndex & 255) === 0) checkAxisRuntime(deadline, checkpoint);
    const { vertices } = heap[heapIndex];
    for (let quadratureIndex = 0; quadratureIndex < pointsPerTriangle; quadratureIndex += 1) {
      const barycentric = QUADRATURE[quadratureIndex];
      samples.push({
        point: [
          barycentric[0] * vertices[0][0] + barycentric[1] * vertices[1][0] + barycentric[2] * vertices[2][0],
          barycentric[0] * vertices[0][1] + barycentric[1] * vertices[1][1] + barycentric[2] * vertices[2][1],
          barycentric[0] * vertices[0][2] + barycentric[1] * vertices[1][2] + barycentric[2] * vertices[2][2],
        ],
        weight: representativeWeight,
      });
    }
  }
  return { samples, selectedTriangleCount: heap.length };
}

function surfaceCovariance(
  mesh: TriangleMesh,
  centroid: Vec3,
  deadline: number,
  checkpoint: () => void,
): number[][] {
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let totalWeight = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    if ((offset & 1023) === 0) checkAxisRuntime(deadline, checkpoint);
    const geometry = triangleGeometry(mesh, offset);
    if (!geometry) continue;
    for (const barycentric of QUADRATURE) {
      const point: Vec3 = [0, 1, 2].map((component) =>
        barycentric[0] * geometry.vertices[0][component]
        + barycentric[1] * geometry.vertices[1][component]
        + barycentric[2] * geometry.vertices[2][component]
      ) as unknown as Vec3;
      const weight = geometry.area / 3;
      const delta = [point[0] - centroid[0], point[1] - centroid[1], point[2] - centroid[2]];
      totalWeight += weight;
      for (let row = 0; row < 3; row += 1) for (let column = row; column < 3; column += 1) {
        covariance[row][column] += weight * delta[row] * delta[column];
      }
    }
  }
  if (totalWeight === 0) throw new RangeError('Degenerate mesh surface');
  for (let row = 0; row < 3; row += 1) for (let column = row; column < 3; column += 1) {
    covariance[row][column] /= totalWeight;
    covariance[column][row] = covariance[row][column];
  }
  return covariance;
}

export function findAxisCandidates(
  mesh: TriangleMesh,
  options: {
    readonly sampleCount: number;
    readonly deadline?: number;
    readonly checkpoint?: () => void;
  },
): AxisCandidate[] {
  const deadline = options.deadline ?? Infinity;
  const checkpoint = options.checkpoint ?? (() => undefined);
  checkAxisRuntime(deadline, checkpoint);
  if (!Number.isInteger(options.sampleCount) || options.sampleCount <= 0 || options.sampleCount > 100_000) {
    throw new RangeError('sampleCount must be a positive integer no greater than 100000');
  }
  if (mesh.positions.length % 3 !== 0) {
    throw new TypeError('Mesh positions must contain finite xyz coordinates');
  }
  for (let index = 0; index < mesh.positions.length; index += 1) {
    if ((index & 1023) === 0) checkAxisRuntime(deadline, checkpoint);
    if (!Number.isFinite(mesh.positions[index])) throw new TypeError('Mesh positions must contain finite xyz coordinates');
  }
  const vertexCount = mesh.positions.length / 3;
  if (mesh.indices.length % 3 !== 0) throw new TypeError('Mesh indices must contain complete triangles');
  for (let offset = 0; offset < mesh.indices.length; offset += 1) {
    if ((offset & 1023) === 0) checkAxisRuntime(deadline, checkpoint);
    if (mesh.indices[offset] >= vertexCount) throw new RangeError('Mesh triangle index is outside the vertex buffer');
  }
  const referenced = referencedMesh(mesh, deadline, checkpoint);
  const { centroid } = massProperties(referenced, deadline, checkpoint);
  const covariance = surfaceCovariance(referenced, centroid, deadline, checkpoint);
  const { samples } = selectRadialSurfaceSamples(referenced, options.sampleCount, { deadline, checkpoint });
  const candidates = eigenvectors(covariance, deadline, checkpoint).map((direction) => {
    checkAxisRuntime(deadline, checkpoint);
    return {
      origin: centroid,
      direction,
      confirmed: false,
      source: 'inertia' as const,
      ...radialSymmetry(samples, centroid, direction, deadline, checkpoint),
    };
  });
  return candidates.sort((left, right) =>
    right.confidence - left.confidence ||
    right.direction[2] - left.direction[2] ||
    right.direction[1] - left.direction[1] ||
    right.direction[0] - left.direction[0]
  );
}
