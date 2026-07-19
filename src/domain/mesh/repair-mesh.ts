import type { Vec3 } from '../types';
import { massProperties, MeshVolumeError } from './mass-properties';
import { meshNumerics } from './numerics';
import { analyzeMeshProblems } from './problem-report';
import type { MeshComparison, MeshRepairResult, TriangleMesh } from './types';

const WELD_RELATIVE_TOLERANCE = 1e-7;
const MAX_AXIS_CHANGE_PERCENT = 0.5;
const MAX_VOLUME_CHANGE_PERCENT = 1;

type Bounds = {
  readonly min: Vec3;
  readonly size: Vec3;
};

export function repairMeshSafe(mesh: TriangleMesh): MeshRepairResult {
  const referenced = compactVertices(mesh, mesh.indices);
  const before = analyzeMeshProblems(referenced);
  const filtered = filterFaces(referenced);
  const welded = weldVertices(referenced, filtered.indices);
  const repaired = compactVertices(referenced, welded.indices);
  const after = analyzeMeshProblems(repaired);
  const comparison = compareMeshes(referenced, repaired);
  const blockingReasons = meshRepairBlockingReasons(after, comparison);

  return {
    mode: 'safe',
    mesh: repaired,
    before,
    after,
    changes: {
      removedDegenerate: filtered.removedDegenerate,
      removedDuplicate: filtered.removedDuplicate,
      weldedVertices: welded.weldedVertices,
      splitVertices: 0,
      filledHoles: 0,
    },
    comparison,
    accepted: blockingReasons.length === 0,
    blockingReasons,
  };
}

export function compareMeshes(before: TriangleMesh, after: TriangleMesh): MeshComparison {
  const beforeGeometry = comparisonGeometry(before);
  const afterGeometry = comparisonGeometry(after);
  const beforeSize = referencedBounds(beforeGeometry).size;
  const afterSize = referencedBounds(afterGeometry).size;
  const beforeAbsoluteVolume = meshAbsoluteVolume(beforeGeometry);
  const afterAbsoluteVolume = meshAbsoluteVolume(afterGeometry);
  return {
    beforeSize,
    afterSize,
    axisChangePercent: [
      changePercent(beforeSize[0], afterSize[0]),
      changePercent(beforeSize[1], afterSize[1]),
      changePercent(beforeSize[2], afterSize[2]),
    ],
    beforeAbsoluteVolume,
    afterAbsoluteVolume,
    volumeChangePercent: changePercent(beforeAbsoluteVolume, afterAbsoluteVolume),
  };
}

function filterFaces(mesh: TriangleMesh): {
  readonly indices: readonly number[];
  readonly removedDegenerate: number;
  readonly removedDuplicate: number;
} {
  const { areaToleranceSquared } = meshNumerics(mesh);
  const indices: number[] = [];
  const triangleKeys = new Set<string>();
  let removedDegenerate = 0;
  let removedDuplicate = 0;

  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    if (isDegenerate(mesh, a, b, c, areaToleranceSquared)) {
      removedDegenerate += 1;
      continue;
    }
    const key = unorderedTriangleKey(a, b, c);
    if (triangleKeys.has(key)) {
      removedDuplicate += 1;
      continue;
    }
    triangleKeys.add(key);
    indices.push(a, b, c);
  }
  return { indices, removedDegenerate, removedDuplicate };
}

function weldVertices(
  mesh: TriangleMesh,
  indices: readonly number[],
): { readonly indices: readonly number[]; readonly weldedVertices: number } {
  const referenced = [...new Set(indices)].sort((left, right) => left - right);
  if (referenced.length === 0) return { indices: [], weldedVertices: 0 };

  const bounds = referencedBounds(mesh);
  const cellSize = Math.max(bounds.size[0], bounds.size[1], bounds.size[2]) * WELD_RELATIVE_TOLERANCE;
  const representativeByVertex = new Map<number, number>();
  let weldedVertices = 0;

  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    const representativeByPosition = new Map<string, number>();
    for (const vertex of referenced) {
      const key = positionKey(mesh, vertex);
      const representative = representativeByPosition.get(key);
      if (representative === undefined) {
        representativeByPosition.set(key, vertex);
        representativeByVertex.set(vertex, vertex);
      } else {
        representativeByVertex.set(vertex, representative);
        weldedVertices += 1;
      }
    }
  } else {
    const cells = new Map<string, number[]>();
    const toleranceSquared = cellSize ** 2;
    for (const vertex of referenced) {
      const cell = cellCoordinates(mesh, vertex, bounds.min, cellSize);
      let representative: number | undefined;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const candidates = cells.get(cellKey(cell[0] + dx, cell[1] + dy, cell[2] + dz));
            if (!candidates) continue;
            for (const candidate of candidates) {
              if (
                (representative === undefined || candidate < representative)
                && distanceSquared(mesh, vertex, candidate) <= toleranceSquared
              ) {
                representative = candidate;
              }
            }
          }
        }
      }
      if (representative === undefined) {
        representativeByVertex.set(vertex, vertex);
        const key = cellKey(cell[0], cell[1], cell[2]);
        const occupants = cells.get(key);
        if (occupants) occupants.push(vertex);
        else cells.set(key, [vertex]);
      } else {
        representativeByVertex.set(vertex, representative);
        weldedVertices += 1;
      }
    }
  }

  return {
    indices: indices.map((index) => representativeByVertex.get(index) ?? index),
    weldedVertices,
  };
}

function compactVertices(mesh: TriangleMesh, indices: Iterable<number>): TriangleMesh {
  const compactIndexBySource = new Map<number, number>();
  const positions: number[] = [];
  const compactIndices: number[] = [];
  for (const sourceIndex of indices) {
    let compactIndex = compactIndexBySource.get(sourceIndex);
    if (compactIndex === undefined) {
      compactIndex = compactIndexBySource.size;
      compactIndexBySource.set(sourceIndex, compactIndex);
      const offset = sourceIndex * 3;
      positions.push(mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]);
    }
    compactIndices.push(compactIndex);
  }
  return {
    positions: new Float64Array(positions),
    indices: new Uint32Array(compactIndices),
  };
}

export function meshRepairBlockingReasons(
  report: MeshRepairResult['after'],
  comparison: MeshComparison,
): string[] {
  const reasons: string[] = [];
  if (
    report.inspection.triangleCount === 0
    || comparison.afterSize.some((size) => !(size > 0) || !Number.isFinite(size))
    || !(comparison.afterAbsoluteVolume > 0)
    || !Number.isFinite(comparison.afterAbsoluteVolume)
  ) {
    reasons.push('修復結果無法形成有效實體');
  }
  if (report.inspection.boundaryEdgeCount > 0) reasons.push('仍有開放邊界');
  if (report.inspection.nonManifoldEdgeCount > 0) reasons.push('仍有非流形邊');
  if (report.inspection.degenerateTriangleCount > 0) reasons.push('仍有退化三角形');
  if (report.duplicateTriangleCount > 0) reasons.push('仍有重複三角形');
  if (report.inconsistentWindingEdgeCount > 0) reasons.push('修復結果仍有面方向不一致');
  if (report.selfIntersectionCount > 0) reasons.push('仍有三維自相交');
  if (!report.selfIntersectionAnalysisComplete) reasons.push('三維自相交分析超出安全工作上限，結果未能完整驗證');
  const axisNames = ['X', 'Y', 'Z'] as const;
  comparison.axisChangePercent.forEach((change, axis) => {
    if (change > MAX_AXIS_CHANGE_PERCENT) reasons.push(`${axisNames[axis]} 軸尺寸變化超過 0.5%`);
  });
  if (comparison.volumeChangePercent > MAX_VOLUME_CHANGE_PERCENT) {
    reasons.push('體積變化超過 1%');
  }
  return reasons;
}

function isDegenerate(
  mesh: TriangleMesh,
  a: number,
  b: number,
  c: number,
  areaToleranceSquared: number,
): boolean {
  if (a === b || b === c || c === a) return true;
  const ai = a * 3;
  const bi = b * 3;
  const ci = c * 3;
  const abx = mesh.positions[bi] - mesh.positions[ai];
  const aby = mesh.positions[bi + 1] - mesh.positions[ai + 1];
  const abz = mesh.positions[bi + 2] - mesh.positions[ai + 2];
  const acx = mesh.positions[ci] - mesh.positions[ai];
  const acy = mesh.positions[ci + 1] - mesh.positions[ai + 1];
  const acz = mesh.positions[ci + 2] - mesh.positions[ai + 2];
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  return crossX ** 2 + crossY ** 2 + crossZ ** 2 <= areaToleranceSquared;
}

function unorderedTriangleKey(a: number, b: number, c: number): string {
  const sorted = [a, b, c].sort((left, right) => left - right);
  return `${sorted[0]}:${sorted[1]}:${sorted[2]}`;
}

function referencedBounds(mesh: TriangleMesh): Bounds {
  return boundsForIndices(mesh, [...new Set(mesh.indices)]);
}

function comparisonGeometry(mesh: TriangleMesh): TriangleMesh {
  const referenced = compactVertices(mesh, mesh.indices);
  const filtered = filterFaces(referenced);
  return compactVertices(referenced, filtered.indices);
}

function boundsForIndices(mesh: TriangleMesh, indices: readonly number[]): Bounds {
  if (indices.length === 0) return { min: [0, 0, 0], size: [0, 0, 0] };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const index of indices) {
    const offset = index * 3;
    const x = mesh.positions[offset];
    const y = mesh.positions[offset + 1];
    const z = mesh.positions[offset + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    min: [minX, minY, minZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

function meshAbsoluteVolume(mesh: TriangleMesh): number {
  try {
    return Math.abs(massProperties(mesh).volume);
  } catch (error) {
    if (error instanceof MeshVolumeError) return 0;
    throw error;
  }
}

function changePercent(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.POSITIVE_INFINITY;
  const change = Math.abs((after - before) / before) * 100;
  for (const threshold of [MAX_AXIS_CHANGE_PERCENT, MAX_VOLUME_CHANGE_PERCENT]) {
    const tolerance = 64 * Number.EPSILON * Math.max(1, Math.abs(change), threshold);
    if (Math.abs(change - threshold) <= tolerance) return threshold;
  }
  return change;
}

function cellCoordinates(mesh: TriangleMesh, vertex: number, origin: Vec3, cellSize: number): Vec3 {
  const offset = vertex * 3;
  return [
    Math.floor((mesh.positions[offset] - origin[0]) / cellSize),
    Math.floor((mesh.positions[offset + 1] - origin[1]) / cellSize),
    Math.floor((mesh.positions[offset + 2] - origin[2]) / cellSize),
  ];
}

function cellKey(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

function positionKey(mesh: TriangleMesh, vertex: number): string {
  const offset = vertex * 3;
  return `${canonical(mesh.positions[offset])}:${canonical(mesh.positions[offset + 1])}:${canonical(mesh.positions[offset + 2])}`;
}

function canonical(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function distanceSquared(mesh: TriangleMesh, first: number, second: number): number {
  const firstOffset = first * 3;
  const secondOffset = second * 3;
  const dx = mesh.positions[firstOffset] - mesh.positions[secondOffset];
  const dy = mesh.positions[firstOffset + 1] - mesh.positions[secondOffset + 1];
  const dz = mesh.positions[firstOffset + 2] - mesh.positions[secondOffset + 2];
  return dx ** 2 + dy ** 2 + dz ** 2;
}
