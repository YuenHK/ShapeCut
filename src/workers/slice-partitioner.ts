export interface SlicePartitionMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface SliceWorkPartition extends SlicePartitionMesh {
  readonly partitionIndex: number;
  readonly planeIndices: Uint32Array;
  readonly planes: Float64Array;
  readonly estimatedByteCost: number;
}

interface PlaneCost {
  readonly planeIndex: number;
  readonly overlapCount: number;
  readonly estimatedByteCost: number;
}

const PLANE_BYTES = Float64Array.BYTES_PER_ELEMENT;
const ESTIMATED_OVERLAP_BYTES = (
  3 * Uint32Array.BYTES_PER_ELEMENT
  + 3 * 3 * Float32Array.BYTES_PER_ELEMENT
  + 4 * Float64Array.BYTES_PER_ELEMENT
);

export function resolveSliceWorkerCount(hardwareConcurrency: number | undefined): 1 | 2 | 4 {
  if (!Number.isFinite(hardwareConcurrency) || (hardwareConcurrency ?? 0) <= 2) return 1;
  if ((hardwareConcurrency as number) <= 5) return 2;
  return 4;
}

export function partitionSliceWork(
  mesh: SlicePartitionMesh,
  planes: Float64Array,
  workerCount: number,
): readonly SliceWorkPartition[] {
  validateInput(mesh, planes, workerCount);
  const degenerateTriangles = classifyDegenerateTriangles(mesh);
  const targetCount = Math.max(1, Math.min(workerCount, planes.length));
  const planeCosts = estimatePlaneCosts(mesh, planes, degenerateTriangles);
  const assignments = Array.from({ length: targetCount }, (_, partitionIndex) => ({
    partitionIndex,
    estimatedByteCost: 0,
    planeIndices: [] as number[],
  }));

  for (const plane of [...planeCosts].sort((left, right) => (
    right.estimatedByteCost - left.estimatedByteCost || left.planeIndex - right.planeIndex
  ))) {
    const target = assignments.reduce((best, candidate) => (
      candidate.estimatedByteCost < best.estimatedByteCost
        || (candidate.estimatedByteCost === best.estimatedByteCost
          && candidate.partitionIndex < best.partitionIndex)
        ? candidate
        : best
    ));
    target.planeIndices.push(plane.planeIndex);
    target.estimatedByteCost += plane.estimatedByteCost;
  }

  return Object.freeze(assignments.map((assignment) => {
    assignment.planeIndices.sort((left, right) => left - right);
    const partitionPlanes = Float64Array.from(
      assignment.planeIndices,
      (planeIndex) => planes[planeIndex],
    );
    const partitionMesh = copyOverlappingTriangles(
      mesh,
      partitionPlanes,
      degenerateTriangles,
      assignment.partitionIndex === 0,
    );
    return Object.freeze({
      partitionIndex: assignment.partitionIndex,
      planeIndices: Uint32Array.from(assignment.planeIndices),
      planes: partitionPlanes,
      positions: partitionMesh.positions,
      indices: partitionMesh.indices,
      estimatedByteCost: assignment.estimatedByteCost,
    });
  }));
}

function estimatePlaneCosts(
  mesh: SlicePartitionMesh,
  planes: Float64Array,
  degenerateTriangles: readonly boolean[],
): readonly PlaneCost[] {
  const costs = Array.from(planes, (plane, planeIndex): PlaneCost => ({
    planeIndex,
    overlapCount: countOverlaps(mesh, plane, degenerateTriangles),
    estimatedByteCost: 0,
  }));
  return costs.map((cost) => Object.freeze({
    ...cost,
    estimatedByteCost: PLANE_BYTES + cost.overlapCount * ESTIMATED_OVERLAP_BYTES,
  }));
}

function countOverlaps(
  mesh: SlicePartitionMesh,
  plane: number,
  degenerateTriangles: readonly boolean[],
): number {
  let count = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    if (degenerateTriangles[offset / 3]) continue;
    const z0 = mesh.positions[mesh.indices[offset] * 3 + 2];
    const z1 = mesh.positions[mesh.indices[offset + 1] * 3 + 2];
    const z2 = mesh.positions[mesh.indices[offset + 2] * 3 + 2];
    if (overlapsPlaneWithinKernelTolerance(z0, z1, z2, plane)) count += 1;
  }
  return count;
}

function copyOverlappingTriangles(
  mesh: SlicePartitionMesh,
  planes: Float64Array,
  degenerateTriangles: readonly boolean[],
  includeDegenerateTriangles: boolean,
): SlicePartitionMesh {
  const sourceVertexIndices: number[] = [];
  const remap = new Map<number, number>();
  const indices: number[] = [];

  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangleIndex = offset / 3;
    const triangle = [
      mesh.indices[offset],
      mesh.indices[offset + 1],
      mesh.indices[offset + 2],
    ] as const;
    const z0 = mesh.positions[triangle[0] * 3 + 2];
    const z1 = mesh.positions[triangle[1] * 3 + 2];
    const z2 = mesh.positions[triangle[2] * 3 + 2];
    const include = degenerateTriangles[triangleIndex]
      ? includeDegenerateTriangles
      : planes.some((plane) => overlapsPlaneWithinKernelTolerance(z0, z1, z2, plane));
    if (!include) continue;

    for (const sourceIndex of triangle) {
      let partitionIndex = remap.get(sourceIndex);
      if (partitionIndex === undefined) {
        partitionIndex = sourceVertexIndices.length;
        remap.set(sourceIndex, partitionIndex);
        sourceVertexIndices.push(sourceIndex);
      }
      indices.push(partitionIndex);
    }
  }

  const positions = new Float32Array(sourceVertexIndices.length * 3);
  for (let targetIndex = 0; targetIndex < sourceVertexIndices.length; targetIndex += 1) {
    const sourceOffset = sourceVertexIndices[targetIndex] * 3;
    const targetOffset = targetIndex * 3;
    positions[targetOffset] = mesh.positions[sourceOffset];
    positions[targetOffset + 1] = mesh.positions[sourceOffset + 1];
    positions[targetOffset + 2] = mesh.positions[sourceOffset + 2];
  }
  return Object.freeze({ positions, indices: Uint32Array.from(indices) });
}

function overlapsPlaneWithinKernelTolerance(
  z0: number,
  z1: number,
  z2: number,
  plane: number,
): boolean {
  const axialMagnitude = Math.max(1, Math.abs(plane), Math.abs(z0), Math.abs(z1), Math.abs(z2));
  const epsilon = Math.max(1e-9, axialMagnitude * 64 * Number.EPSILON);
  return Math.min(z0, z1, z2) <= plane + epsilon
    && Math.max(z0, z1, z2) >= plane - epsilon;
}

function classifyDegenerateTriangles(mesh: SlicePartitionMesh): readonly boolean[] {
  const result: boolean[] = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const first = vertex(mesh, mesh.indices[offset]);
    const second = vertex(mesh, mesh.indices[offset + 1]);
    const third = vertex(mesh, mesh.indices[offset + 2]);
    const ab = [second.x - first.x, second.y - first.y, second.z - first.z] as const;
    const ac = [third.x - first.x, third.y - first.y, third.z - first.z] as const;
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ] as const;
    const areaMeasure = Math.hypot(Math.hypot(cross[0], cross[1]), cross[2]);
    const localEdgeScale = Math.max(
      edgeLength(first, second),
      edgeLength(second, third),
      edgeLength(third, first),
    );
    const areaTolerance = Math.max(
      2.2250738585072014e-308,
      localEdgeScale * localEdgeScale * 64 * Number.EPSILON,
    );
    result.push(areaMeasure <= areaTolerance);
  }
  return Object.freeze(result);
}

interface Vertex { readonly x: number; readonly y: number; readonly z: number }

function vertex(mesh: SlicePartitionMesh, index: number): Vertex {
  const offset = index * 3;
  return { x: mesh.positions[offset], y: mesh.positions[offset + 1], z: mesh.positions[offset + 2] };
}

function edgeLength(first: Vertex, second: Vertex): number {
  return Math.hypot(
    Math.hypot(second.x - first.x, second.y - first.y),
    second.z - first.z,
  );
}

function validateInput(
  mesh: SlicePartitionMesh,
  planes: Float64Array,
  workerCount: number,
): void {
  if (Object.getPrototypeOf(mesh.positions) !== Float32Array.prototype
    || Object.getPrototypeOf(mesh.indices) !== Uint32Array.prototype
    || Object.getPrototypeOf(planes) !== Float64Array.prototype
    || mesh.positions.length % 3 !== 0
    || mesh.indices.length % 3 !== 0
    || !Number.isSafeInteger(workerCount)
    || workerCount < 1
    || workerCount > 4) {
    throw new TypeError('Invalid slice partition request');
  }
  const vertexCount = mesh.positions.length / 3;
  for (const position of mesh.positions) {
    if (!Number.isFinite(position)) throw new TypeError('Slice positions must be finite');
  }
  for (const index of mesh.indices) {
    if (index >= vertexCount) throw new RangeError('Slice triangle index is out of range');
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const plane of planes) {
    if (!Number.isFinite(plane) || plane <= previous) {
      throw new TypeError('Slice planes must be finite and strictly increasing');
    }
    previous = plane;
  }
}
