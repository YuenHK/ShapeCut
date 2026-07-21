import type { Point2 } from '../decomposition/types';
import type { ProjectedMesh, ProjectedVertex } from '../outline-2.5d/raster';
import { contourBounds, signedArea, simplifyClosedLoop } from '../outline-2.5d/simplify';
import type { OutlineBudgets, OutlineLayerSpec } from '../outline-2.5d/types';
import type { FeatureContour } from './types';
import { isStrictlyContainedLoop } from './hole';
import { validateDepthFeatureContours } from './validate';

export const DEPTH_CONTRAST_OMISSION_WARNING = '表面深度差不足，已省略雕刻特徵';
export const DEPTH_DATA_OMISSION_WARNING = '表面深度資料不足，已省略雕刻特徵';
export const DEPTH_GEOMETRY_OMISSION_WARNING = '雕刻特徵不可靠，已局部省略';

export type DepthFeatureOmissionCode =
  | 'INSUFFICIENT_CONTRAST'
  | 'INSUFFICIENT_DEPTH_DATA'
  | 'UNRELIABLE_DEPTH_GEOMETRY';

export type DepthField = {
  readonly width: number;
  readonly height: number;
  readonly cellSizeMm: number;
  readonly depthMm: Float32Array;
  readonly valid: Uint8Array;
  readonly origin: Point2;
};

export type DepthFeatureRequest = {
  readonly layerId: string;
  readonly layer: OutlineLayerSpec;
  readonly exterior: readonly Point2[];
  readonly centralHole?: readonly Point2[] | { readonly outer: readonly Point2[] };
  readonly exteriorAreaMm2: number;
  readonly cellSizeMm: number;
  readonly planarDiameterMm: number;
  readonly budgets: OutlineBudgets;
  /** Supplies the caller's full batch size so one-layer calls cannot evade total budgets. */
  readonly totalLayerCount?: number;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
  /** Optional stricter test/caller cap; it may never exceed the derived global hit budget. */
  readonly maximumSurfaceHits?: number;
  readonly maximumComponentBytes?: number;
  readonly resourceObserver?: (event: DepthFeatureResourceEvent) => void;
};

export type DepthFeatureResourceEvent = {
  readonly phase: 'topology-sort' | 'surface-hit-storage' | 'surface-hit-sort' | 'component-labels'
    | 'component-candidate' | 'component-boundary' | 'component-boundary-rejected' | 'component-final';
  readonly liveBytes: number;
  readonly rasterCells: number;
  readonly sourceCellCount?: number;
  readonly finalAreaMm2?: number;
  readonly minimumX?: number;
};

export type DepthFeatureSourceEvidence = {
  readonly occupiedCellCount: number;
  readonly componentCount: number;
  readonly sourceAreaMm2: number;
  readonly minimumDepthMm: number;
  readonly maximumDepthMm: number;
};

export type DepthFeatureDiagnostics = {
  readonly cellSizeMm: number;
  readonly contrastMm: number;
  readonly redThresholdMm: number;
  readonly blueThresholdMm: number;
  readonly omissionCode?: DepthFeatureOmissionCode;
};

export type DepthFeatureResult = {
  readonly red?: FeatureContour;
  readonly blue?: FeatureContour;
  readonly warning?: string;
  readonly omissionCode?: DepthFeatureOmissionCode;
  readonly diagnostics: DepthFeatureDiagnostics;
  readonly evidence: {
    readonly red?: DepthFeatureSourceEvidence;
    readonly blue?: DepthFeatureSourceEvidence;
  };
};

type LabeledComponents = {
  readonly labels: Int32Array;
  readonly order: Int32Array;
  readonly counts: Int32Array;
  readonly minX: Int32Array;
  readonly minY: Int32Array;
  readonly maxX: Int32Array;
  readonly maxY: Int32Array;
  readonly componentCount: number;
  readonly workspaceBytes: number;
};

const MAX_DEPTH_HIT_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH_TOPOLOGY_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH_COMPONENT_BYTES = 64 * 1024 * 1024;
const HIT_RECORD_BYTES = Float64Array.BYTES_PER_ELEMENT + Int32Array.BYTES_PER_ELEMENT;
const ESTIMATED_POINT_BYTES = 64;

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Depth feature extraction exceeded the runtime budget');
}

function observeResources(
  request: DepthFeatureRequest,
  phase: DepthFeatureResourceEvent['phase'],
  liveBytes: number,
  rasterCells: number,
  details: Pick<DepthFeatureResourceEvent, 'sourceCellCount' | 'finalAreaMm2' | 'minimumX'> = {},
): void {
  request.resourceObserver?.({ phase, liveBytes, rasterCells, ...details });
}

function holeLoop(request: DepthFeatureRequest): readonly Point2[] | undefined {
  if (!request.centralHole) return undefined;
  return 'outer' in request.centralHole
    ? request.centralHole.outer
    : request.centralHole;
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointLocation(point: Point2, polygon: readonly Point2[], deadline: number, checkpoint: () => void): -1 | 0 | 1 {
  let scale = 1;
  for (let index = 0; index < polygon.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const [x, y] = polygon[index];
    scale = Math.max(scale, Math.abs(x), Math.abs(y));
  }
  const areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  const onSegment = (a: Point2, b: Point2): boolean => Math.abs(cross(a, b, point)) <= areaTolerance
    && point[0] >= Math.min(a[0], b[0]) - lengthTolerance
    && point[0] <= Math.max(a[0], b[0]) + lengthTolerance
    && point[1] >= Math.min(a[1], b[1]) - lengthTolerance
    && point[1] <= Math.max(a[1], b[1]) + lengthTolerance;
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if (onSegment(a, b)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const intersectionX = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (intersectionX > point[0]) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const parameter = denominator === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator,
  ));
  return Math.hypot(point[0] - start[0] - parameter * dx, point[1] - start[1] - parameter * dy);
}

function pointBoundaryDistance(
  point: Point2,
  polygon: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let minimum = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    if ((index & 63) === 0) checkRuntime(deadline, checkpoint);
    minimum = Math.min(minimum, pointSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return minimum;
}

function validateRequest(projected: ProjectedMesh, request: DepthFeatureRequest, deadline: number, checkpoint: () => void): void {
  checkRuntime(deadline, checkpoint);
  const layer = request.layer;
  const totalLayerCount = request.totalLayerCount ?? 1;
  if (typeof request.layerId !== 'string' || request.layerId.trim().length === 0
    || !Number.isSafeInteger(layer.index) || layer.index < 0
    || ![layer.zStart, layer.zMid, layer.zEnd].every(Number.isFinite)
    || layer.zEnd <= layer.zStart || layer.zMid < layer.zStart || layer.zMid > layer.zEnd
    || !Number.isFinite(request.cellSizeMm) || request.cellSizeMm <= 0
    || !Number.isFinite(request.planarDiameterMm) || request.planarDiameterMm <= 0
    || !Number.isFinite(request.exteriorAreaMm2) || request.exteriorAreaMm2 <= 0
    || request.maximumSurfaceHits !== undefined
      && (!Number.isSafeInteger(request.maximumSurfaceHits) || request.maximumSurfaceHits <= 0)
    || request.maximumComponentBytes !== undefined
      && (!Number.isSafeInteger(request.maximumComponentBytes) || request.maximumComponentBytes <= 0
        || request.maximumComponentBytes > MAX_DEPTH_COMPONENT_BYTES)
    || !Number.isSafeInteger(totalLayerCount) || totalLayerCount <= 0 || totalLayerCount > request.budgets.maxLayers) {
    throw new RangeError('Depth feature extraction requires finite bounded layer evidence');
  }
  const exteriorValidation = validateDepthFeatureContours({
    exterior: request.exterior,
    centralHole: holeLoop(request),
    clearanceMm: 0,
    deadline,
    checkpoint,
  });
  if (!exteriorValidation.ok) throw new RangeError(`Depth feature extraction requires valid cut geometry: ${exteriorValidation.reasons.join('; ')}`);
  const retainedHole = holeLoop(request);
  const cutClearance = Math.max(request.cellSizeMm, request.planarDiameterMm * 0.001);
  if (retainedHole && !isStrictlyContainedLoop(
    request.exterior, retainedHole, cutClearance, deadline, checkpoint,
  )) throw new RangeError('Depth feature extraction requires a reliable retained central hole');
  const width = Math.ceil((projected.maxX - projected.minX) / request.cellSizeMm) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / request.cellSizeMm) + 3;
  if (![projected.minX, projected.minY, projected.maxX, projected.maxY, projected.planarDiameter].every(Number.isFinite)
    || projected.maxX <= projected.minX || projected.maxY <= projected.minY
    || width > request.budgets.maxRasterWidth || height > request.budgets.maxRasterHeight) {
    throw new RangeError('Depth feature extraction exceeds the raster dimension budget');
  }
  if (width * height * totalLayerCount > request.budgets.maxRasterCellsTotal) {
    throw new RangeError('Depth feature extraction exceeds the total raster cell budget');
  }
  if (projected.triangles.length * totalLayerCount > request.budgets.maxTriangleLayerTests) {
    throw new RangeError('Depth feature extraction exceeds the triangle-layer test budget');
  }
}

function triangleSample(
  point: Point2,
  a: ProjectedVertex,
  b: ProjectedVertex,
  c: ProjectedVertex,
): number | undefined {
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const scale = Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), Math.abs(c[0]), Math.abs(c[1]));
  if (Math.abs(denominator) <= scale * scale * 64 * Number.EPSILON) return undefined;
  const first = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const second = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const third = 1 - first - second;
  const tolerance = 256 * Number.EPSILON * Math.max(1, Math.abs(first), Math.abs(second), Math.abs(third));
  if (first < -tolerance || second < -tolerance || third < -tolerance) return undefined;
  const z = first * a[2] + second * b[2] + third * c[2];
  if (!Number.isFinite(z)) throw new RangeError('Depth feature extraction encountered a non-finite axial sample');
  return z;
}

/**
 * A pair of axial samples is meaningful only when it comes from a closed,
 * two-manifold surface component.  This prevents unrelated open sheets from
 * being mistaken for the front and back of solid material.
 */
function reliableSurfaceComponents(
  projected: ProjectedMesh,
  request: DepthFeatureRequest,
  rasterCells: number,
  deadline: number,
  checkpoint: () => void,
): Int32Array {
  const triangleCount = projected.triangles.length;
  const topologyBytes = triangleCount * 61;
  if (!Number.isSafeInteger(topologyBytes) || topologyBytes > MAX_DEPTH_TOPOLOGY_BYTES) {
    throw new RangeError('Depth feature extraction exceeds the surface-topology resource budget');
  }
  const parents = new Int32Array(triangleCount);
  const edgeCount = triangleCount * 3;
  const edgeFirst = new Uint32Array(edgeCount), edgeSecond = new Uint32Array(edgeCount);
  const edgeTriangle = new Uint32Array(edgeCount), edgeOrder = new Uint32Array(edgeCount);
  for (let triangleIndex = 0; triangleIndex < projected.triangles.length; triangleIndex += 1) {
    if ((triangleIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    parents[triangleIndex] = triangleIndex;
    const triangle = projected.triangles[triangleIndex];
    if (triangle.length !== 3 || triangle.some((vertex) => !Number.isSafeInteger(vertex)
      || vertex < 0 || vertex >= projected.vertices.length)) {
      throw new RangeError('Depth feature extraction requires valid source triangles');
    }
    const triangleVertices = triangle.map((index) => projected.vertices[index]);
    if (triangleVertices.some((vertex) => vertex.length !== 3 || vertex.some((value) => !Number.isFinite(value)))) {
      throw new RangeError('Depth feature extraction requires finite source triangles');
    }
    for (let edge = 0; edge < 3; edge += 1) {
      const first = triangle[edge], second = triangle[(edge + 1) % 3];
      const edgeIndex = triangleIndex * 3 + edge;
      edgeFirst[edgeIndex] = Math.min(first, second);
      edgeSecond[edgeIndex] = Math.max(first, second);
      edgeTriangle[edgeIndex] = triangleIndex;
      edgeOrder[edgeIndex] = edgeIndex;
    }
  }
  observeResources(request, 'topology-sort', topologyBytes, rasterCells);
  checkRuntime(deadline, checkpoint);
  let sortComparisons = 0;
  edgeOrder.sort((leftIndex, rightIndex) => {
    if ((sortComparisons++ & 255) === 0) checkRuntime(deadline, checkpoint);
    return edgeFirst[leftIndex] - edgeFirst[rightIndex]
      || edgeSecond[leftIndex] - edgeSecond[rightIndex]
      || edgeTriangle[leftIndex] - edgeTriangle[rightIndex];
  });
  let unionOperations = 0;
  const unionCheckpoint = (): void => {
    if ((unionOperations++ & 255) === 0) checkRuntime(deadline, checkpoint);
  };
  const root = (value: number): number => {
    let current = value;
    while (parents[current] !== current) {
      unionCheckpoint();
      current = parents[current];
    }
    while (parents[value] !== value) {
      unionCheckpoint();
      const next = parents[value];
      parents[value] = current;
      value = next;
    }
    return current;
  };
  const join = (left: number, right: number): void => {
    unionCheckpoint();
    const leftRoot = root(left), rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  for (let start = 0; start < edgeOrder.length;) {
    if ((start & 255) === 0) checkRuntime(deadline, checkpoint);
    const firstEdge = edgeOrder[start];
    let end = start + 1;
    while (end < edgeOrder.length && edgeFirst[edgeOrder[end]] === edgeFirst[firstEdge]
      && edgeSecond[edgeOrder[end]] === edgeSecond[firstEdge]) {
      unionCheckpoint();
      end += 1;
    }
    for (let index = start + 1; index < end; index += 1) {
      unionCheckpoint();
      join(edgeTriangle[firstEdge], edgeTriangle[edgeOrder[index]]);
    }
    start = end;
  }
  const closed = new Uint8Array(triangleCount);
  for (let triangleIndex = 0; triangleIndex < parents.length; triangleIndex += 1) {
    if ((triangleIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    closed[root(triangleIndex)] = 1;
  }
  for (let start = 0; start < edgeOrder.length;) {
    if ((start & 255) === 0) checkRuntime(deadline, checkpoint);
    const firstEdge = edgeOrder[start];
    let end = start + 1;
    while (end < edgeOrder.length && edgeFirst[edgeOrder[end]] === edgeFirst[firstEdge]
      && edgeSecond[edgeOrder[end]] === edgeSecond[firstEdge]) {
      unionCheckpoint();
      end += 1;
    }
    if (end - start !== 2) closed[root(edgeTriangle[firstEdge])] = 0;
    start = end;
  }
  const componentByTriangle = new Int32Array(triangleCount);
  componentByTriangle.fill(-1);
  const componentByRoot = new Int32Array(triangleCount);
  componentByRoot.fill(-1);
  let componentCount = 0;
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    if ((triangleIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    const componentRoot = root(triangleIndex);
    if (!closed[componentRoot]) continue;
    let component = componentByRoot[componentRoot];
    if (component < 0) {
      component = componentCount++;
      componentByRoot[componentRoot] = component;
    }
    componentByTriangle[triangleIndex] = component;
  }
  checkRuntime(deadline, checkpoint);
  return componentByTriangle;
}

function rasterReliableSurfaceHits(
  projected: ProjectedMesh,
  componentByTriangle: Int32Array,
  eligible: Uint8Array,
  width: number,
  height: number,
  origin: Point2,
  cellSize: number,
  deadline: number,
  checkpoint: () => void,
  accept: (cell: number, z: number, packedComponentFacing: number) => void,
): void {
  for (let triangleIndex = 0; triangleIndex < projected.triangles.length; triangleIndex += 1) {
    if ((triangleIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    const component = componentByTriangle[triangleIndex];
    if (component < 0) continue;
    const triangle = projected.triangles[triangleIndex];
    const vertices = [
      projected.vertices[triangle[0]], projected.vertices[triangle[1]], projected.vertices[triangle[2]],
    ] as const;
    const projectedArea = (vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1])
      - (vertices[1][1] - vertices[0][1]) * (vertices[2][0] - vertices[0][0]);
    if (projectedArea === 0) continue;
    const packedComponentFacing = component * 2 + (projectedArea > 0 ? 1 : 0);
    const minimumX = Math.min(...vertices.map(([x]) => x));
    const maximumX = Math.max(...vertices.map(([x]) => x));
    const minimumY = Math.min(...vertices.map(([, y]) => y));
    const maximumY = Math.max(...vertices.map(([, y]) => y));
    const minimumCellX = Math.max(0, Math.floor((minimumX - origin[0]) / cellSize - 0.5) - 1);
    const maximumCellX = Math.min(width - 1, Math.ceil((maximumX - origin[0]) / cellSize - 0.5) + 1);
    const minimumCellY = Math.max(0, Math.floor((minimumY - origin[1]) / cellSize - 0.5) - 1);
    const maximumCellY = Math.min(height - 1, Math.ceil((maximumY - origin[1]) / cellSize - 0.5) + 1);
    for (let y = minimumCellY; y <= maximumCellY; y += 1) {
      checkRuntime(deadline, checkpoint);
      for (let x = minimumCellX; x <= maximumCellX; x += 1) {
        if ((x & 255) === 0) checkRuntime(deadline, checkpoint);
        const cell = y * width + x;
        if (!eligible[cell]) continue;
        const z = triangleSample(
          [origin[0] + (x + 0.5) * cellSize, origin[1] + (y + 0.5) * cellSize],
          vertices[0], vertices[1], vertices[2],
        );
        if (z !== undefined) accept(cell, z, packedComponentFacing);
      }
    }
  }
}

function sortSurfaceHitRange(
  zValues: Float64Array,
  packedValues: Int32Array,
  start: number,
  end: number,
  deadline: number,
  checkpoint: () => void,
): void {
  const length = end - start;
  if (length < 2) return;
  let operations = 0;
  const compare = (left: number, right: number): number => {
    if ((operations++ & 255) === 0) checkRuntime(deadline, checkpoint);
    const leftPacked = packedValues[start + left], rightPacked = packedValues[start + right];
    return (leftPacked >>> 1) - (rightPacked >>> 1)
      || zValues[start + left] - zValues[start + right]
      || (leftPacked & 1) - (rightPacked & 1);
  };
  const swap = (left: number, right: number): void => {
    const leftIndex = start + left, rightIndex = start + right;
    const z = zValues[leftIndex];
    zValues[leftIndex] = zValues[rightIndex];
    zValues[rightIndex] = z;
    const packed = packedValues[leftIndex];
    packedValues[leftIndex] = packedValues[rightIndex];
    packedValues[rightIndex] = packed;
  };
  const siftDown = (root: number, limit: number): void => {
    while (root * 2 + 1 < limit) {
      if ((operations++ & 255) === 0) checkRuntime(deadline, checkpoint);
      let child = root * 2 + 1;
      if (child + 1 < limit && compare(child, child + 1) < 0) child += 1;
      if (compare(root, child) >= 0) return;
      swap(root, child);
      root = child;
    }
  };
  for (let root = Math.floor(length / 2) - 1; root >= 0; root -= 1) siftDown(root, length);
  for (let limit = length - 1; limit > 0; limit -= 1) {
    if ((operations++ & 255) === 0) checkRuntime(deadline, checkpoint);
    swap(0, limit);
    siftDown(0, limit);
  }
  checkRuntime(deadline, checkpoint);
}

export function buildDepthField(projected: ProjectedMesh, request: DepthFeatureRequest): DepthField {
  const deadline = request.deadline ?? Date.now() + request.budgets.maxRuntimeMs;
  const checkpoint = request.checkpoint ?? (() => undefined);
  validateRequest(projected, request, deadline, checkpoint);
  const cellSize = request.cellSizeMm;
  const width = Math.ceil((projected.maxX - projected.minX) / cellSize) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / cellSize) + 3;
  const origin: Point2 = [projected.minX - cellSize, projected.minY - cellSize];
  checkRuntime(deadline, checkpoint);
  const eligible = new Uint8Array(width * height);
  const cutClearance = Math.max(cellSize, request.planarDiameterMm * 0.001);
  const centerMargin = cutClearance + cellSize * Math.SQRT1_2;
  const retainedHole = holeLoop(request);
  for (let y = 0; y < height; y += 1) {
    checkRuntime(deadline, checkpoint);
    for (let x = 0; x < width; x += 1) {
      if ((x & 255) === 0) checkRuntime(deadline, checkpoint);
      const point: Point2 = [origin[0] + (x + 0.5) * cellSize, origin[1] + (y + 0.5) * cellSize];
      if (pointLocation(point, request.exterior, deadline, checkpoint) !== 1
        || pointBoundaryDistance(point, request.exterior, deadline, checkpoint) + 1e-12 < centerMargin) continue;
      if (retainedHole && (pointLocation(point, retainedHole, deadline, checkpoint) >= 0
        || pointBoundaryDistance(point, retainedHole, deadline, checkpoint) <= centerMargin + 1e-12)) continue;
      eligible[y * width + x] = 1;
    }
  }
  const rasterCells = width * height;
  const totalLayerCount = request.totalLayerCount ?? 1;
  const hitIndexBytes = rasterCells * (
    Uint32Array.BYTES_PER_ELEMENT * 3
  ) + Uint32Array.BYTES_PER_ELEMENT;
  if (hitIndexBytes >= MAX_DEPTH_HIT_BYTES) {
    throw new RangeError('Depth feature extraction exceeds the surface-hit resource budget');
  }
  const derivedMaximumSurfaceHits = Math.min(
    Math.floor(request.budgets.maxTriangleLayerTests / totalLayerCount),
    rasterCells * 8,
    Math.floor((MAX_DEPTH_HIT_BYTES - hitIndexBytes) / HIT_RECORD_BYTES),
  );
  if (request.maximumSurfaceHits !== undefined && request.maximumSurfaceHits > derivedMaximumSurfaceHits) {
    throw new RangeError('Depth feature extraction exceeds the surface-hit resource budget');
  }
  const maximumSurfaceHits = request.maximumSurfaceHits ?? derivedMaximumSurfaceHits;
  const componentByTriangle = reliableSurfaceComponents(
    projected, request, rasterCells, deadline, checkpoint,
  );
  const hitCounts = new Uint32Array(rasterCells);
  let totalHits = 0;
  rasterReliableSurfaceHits(
    projected, componentByTriangle, eligible, width, height, origin, cellSize, deadline, checkpoint,
    (cell) => {
      if (totalHits >= maximumSurfaceHits) {
        throw new RangeError('Depth feature extraction exceeds the surface-hit resource budget');
      }
      hitCounts[cell] += 1;
      totalHits += 1;
    },
  );
  const hitOffsets = new Uint32Array(rasterCells + 1);
  for (let index = 0; index < rasterCells; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    hitOffsets[index + 1] = hitOffsets[index] + hitCounts[index];
  }
  const hitCursors = hitOffsets.slice(0, rasterCells);
  const hitZ = new Float64Array(totalHits), hitPacked = new Int32Array(totalHits);
  const hitStorageBytes = hitCounts.byteLength + hitOffsets.byteLength + hitCursors.byteLength
    + hitZ.byteLength + hitPacked.byteLength;
  if (hitStorageBytes > MAX_DEPTH_HIT_BYTES) {
    throw new RangeError('Depth feature extraction exceeds the surface-hit resource budget');
  }
  observeResources(request, 'surface-hit-storage', hitStorageBytes, rasterCells);
  checkRuntime(deadline, checkpoint);
  rasterReliableSurfaceHits(
    projected, componentByTriangle, eligible, width, height, origin, cellSize, deadline, checkpoint,
    (cell, z, packed) => {
      const position = hitCursors[cell]++;
      hitZ[position] = z;
      hitPacked[position] = packed;
    },
  );
  observeResources(request, 'surface-hit-sort', hitStorageBytes, rasterCells);
  checkRuntime(deadline, checkpoint);
  const depthMm = new Float32Array(width * height), valid = new Uint8Array(width * height);
  const positiveTolerance = Math.max(1e-9, request.planarDiameterMm * 1e-12);
  for (let index = 0; index < depthMm.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    const start = hitOffsets[index], end = hitOffsets[index + 1];
    if (!eligible[index] || start === end) continue;
    sortSurfaceHitRange(hitZ, hitPacked, start, end, deadline, checkpoint);
    let depth = 0;
    let componentStart = start;
    while (componentStart < end) {
      if (((componentStart - start) & 255) === 0) checkRuntime(deadline, checkpoint);
      const component = hitPacked[componentStart] >>> 1;
      let componentEnd = componentStart + 1;
      while (componentEnd < end && (hitPacked[componentEnd] >>> 1) === component) {
        if (((componentEnd - componentStart) & 255) === 0) checkRuntime(deadline, checkpoint);
        componentEnd += 1;
      }
      let cursor = componentStart, uniqueCount = 0, componentDepth = 0;
      let frontZ = 0, frontFacing = 0, reliablePairs = true;
      while (cursor < componentEnd) {
        if (((cursor - componentStart) & 255) === 0) checkRuntime(deadline, checkpoint);
        const z = hitZ[cursor];
        let facing = 0, duplicateEnd = cursor;
        while (duplicateEnd < componentEnd && Math.abs(hitZ[duplicateEnd] - z) <= positiveTolerance) {
          if (((duplicateEnd - cursor) & 255) === 0) checkRuntime(deadline, checkpoint);
          facing += (hitPacked[duplicateEnd] & 1) === 1 ? 1 : -1;
          duplicateEnd += 1;
        }
        if (facing === 0) reliablePairs = false;
        if ((uniqueCount & 1) === 0) {
          frontZ = z;
          frontFacing = facing;
        } else {
          if (frontFacing === 0 || facing === 0 || Math.sign(frontFacing) === Math.sign(facing)) {
            reliablePairs = false;
          }
          const clippedFront = Math.max(frontZ, request.layer.zStart);
          const clippedBack = Math.min(z, request.layer.zEnd);
          if (clippedBack - clippedFront > positiveTolerance) componentDepth += clippedBack - clippedFront;
        }
        uniqueCount += 1;
        cursor = duplicateEnd;
      }
      if ((uniqueCount & 1) !== 0) reliablePairs = false;
      if (reliablePairs) depth = Math.max(depth, componentDepth);
      componentStart = componentEnd;
    }
    if (!Number.isFinite(depth)) throw new RangeError('Depth feature extraction encountered non-finite paired surface samples');
    if (depth <= positiveTolerance) continue;
    depthMm[index] = depth;
    valid[index] = 1;
  }
  checkRuntime(deadline, checkpoint);
  return { width, height, cellSizeMm: cellSize, depthMm, valid, origin };
}

function quantile(sorted: readonly number[], percentile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * percentile)))];
}

function close3x3(source: Uint8Array, width: number, height: number, deadline: number, checkpoint: () => void): Uint8Array {
  checkRuntime(deadline, checkpoint);
  const dilated = new Uint8Array(source.length), result = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    checkRuntime(deadline, checkpoint);
    for (let x = 0; x < width; x += 1) {
      for (let dy = -1; dy <= 1 && !dilated[y * width + x]; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && source[ny * width + nx]) {
          dilated[y * width + x] = 1;
          break;
        }
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    checkRuntime(deadline, checkpoint);
    for (let x = 0; x < width; x += 1) {
      let occupied = true;
      for (let dy = -1; dy <= 1 && occupied; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !dilated[ny * width + nx]) {
          occupied = false;
          break;
        }
      }
      if (occupied) result[y * width + x] = 1;
    }
  }
  return result;
}

export function closeDepthBandMask(
  source: Uint8Array,
  legalDomain: Uint8Array,
  competingRole: Uint8Array,
  width: number,
  height: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): Uint8Array {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
    || source.length !== width * height || legalDomain.length !== source.length
    || competingRole.length !== source.length) {
    throw new RangeError('Depth band closing requires matching bounded masks');
  }
  const closed = close3x3(source, width, height, deadline, checkpoint);
  for (let index = 0; index < closed.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    if (!legalDomain[index] || competingRole[index]) closed[index] = 0;
  }
  return closed;
}

function labelComponents(
  source: Uint8Array,
  width: number,
  height: number,
  minimumCells: number,
  deadline: number,
  checkpoint: () => void,
  request: DepthFeatureRequest,
  retainedExternalBytes = 0,
): LabeledComponents {
  const labels = new Int32Array(source.length), queue = new Int32Array(source.length);
  labels.fill(-1);
  const maximumComponents = Math.floor(source.length / minimumCells);
  const counts = new Int32Array(maximumComponents), minXValues = new Int32Array(maximumComponents);
  const minYValues = new Int32Array(maximumComponents), maxXValues = new Int32Array(maximumComponents);
  const maxYValues = new Int32Array(maximumComponents);
  let componentCount = 0;
  for (let start = 0; start < source.length; start += 1) {
    if ((start & 255) === 0) checkRuntime(deadline, checkpoint);
    if (!source[start] || labels[start] !== -1) continue;
    let head = 0, tail = 0, minimumX = start % width, minimumY = Math.floor(start / width);
    let maximumX = minimumX, maximumY = minimumY;
    labels[start] = -2;
    queue[tail++] = start;
    while (head < tail) {
      if ((head & 255) === 0) checkRuntime(deadline, checkpoint);
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) if (next >= 0 && source[next] && labels[next] === -1) {
        labels[next] = -2;
        queue[tail++] = next;
      }
    }
    if (tail < minimumCells) continue;
    if (componentCount >= maximumComponents) {
      throw new RangeError('Depth feature extraction exceeds the component resource budget');
    }
    for (let index = 0; index < tail; index += 1) {
      if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
      labels[queue[index]] = componentCount;
    }
    counts[componentCount] = tail;
    minXValues[componentCount] = minimumX;
    minYValues[componentCount] = minimumY;
    maxXValues[componentCount] = maximumX;
    maxYValues[componentCount] = maximumY;
    componentCount += 1;
  }
  const order = new Int32Array(componentCount);
  for (let index = 0; index < componentCount; index += 1) order[index] = index;
  const workspaceBytes = labels.byteLength + queue.byteLength + counts.byteLength
    + minXValues.byteLength + minYValues.byteLength + maxXValues.byteLength + maxYValues.byteLength
    + order.byteLength;
  observeResources(request, 'component-labels', workspaceBytes + retainedExternalBytes, source.length);
  checkRuntime(deadline, checkpoint);
  let comparisons = 0;
  order.sort((left, right) => {
    if ((comparisons++ & 255) === 0) checkRuntime(deadline, checkpoint);
    return counts[right] - counts[left]
      || minXValues[left] - minXValues[right]
      || minYValues[left] - minYValues[right];
  });
  checkRuntime(deadline, checkpoint);
  return {
    labels,
    order,
    counts,
    minX: minXValues,
    minY: minYValues,
    maxX: maxXValues,
    maxY: maxYValues,
    componentCount,
    workspaceBytes,
  };
}

/** Opens raster holes with a deterministic bounded seam because public features are singular simple loops. */
function openEnclosedVoids(
  source: Uint8Array,
  width: number,
  height: number,
  deadline: number,
  checkpoint: () => void,
): Uint8Array {
  const result = new Uint8Array(source.length), exterior = new Uint8Array(source.length), queue = new Int32Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    result[index] = source[index];
  }
  let head = 0, tail = 0;
  const enqueueExterior = (index: number): void => {
    if (!result[index] && !exterior[index]) {
      exterior[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x += 1) {
    if ((x & 255) === 0) checkRuntime(deadline, checkpoint);
    enqueueExterior(x);
    enqueueExterior((height - 1) * width + x);
  }
  for (let y = 1; y + 1 < height; y += 1) {
    if ((y & 255) === 0) checkRuntime(deadline, checkpoint);
    enqueueExterior(y * width);
    enqueueExterior(y * width + width - 1);
  }
  while (head < tail) {
    if ((head & 255) === 0) checkRuntime(deadline, checkpoint);
    const current = queue[head++], x = current % width, y = Math.floor(current / width);
    if (x > 0) enqueueExterior(current - 1);
    if (x + 1 < width) enqueueExterior(current + 1);
    if (y > 0) enqueueExterior(current - width);
    if (y + 1 < height) enqueueExterior(current + width);
  }
  const visited = new Uint8Array(exterior.length);
  for (let index = 0; index < exterior.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    visited[index] = exterior[index];
  }
  for (let start = 0; start < result.length; start += 1) {
    if ((start & 255) === 0) checkRuntime(deadline, checkpoint);
    if (result[start] || visited[start]) continue;
    head = 0;
    tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let seamCell = start;
    while (head < tail) {
      if ((head & 255) === 0) checkRuntime(deadline, checkpoint);
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      const seamX = seamCell % width, seamY = Math.floor(seamCell / width);
      if (x < seamX || x === seamX && y < seamY) seamCell = current;
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) if (next >= 0 && !result[next] && !visited[next]) {
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    const seamX = seamCell % width, seamY = Math.floor(seamCell / width);
    for (let row = seamY; row <= Math.min(height - 1, seamY + 1); row += 1) {
      checkRuntime(deadline, checkpoint);
      for (let x = seamX; x >= 0; x -= 1) {
        if ((x & 255) === 0) checkRuntime(deadline, checkpoint);
        result[row * width + x] = 0;
      }
    }
  }
  return result;
}

function traceSingleOuter(
  mask: Uint8Array,
  width: number,
  height: number,
  origin: Point2,
  cellSize: number,
  request: DepthFeatureRequest,
  existingLiveBytes: number,
  candidateMinimumX: number,
  deadline: number,
  checkpoint: () => void,
): readonly Point2[] | undefined {
  const vertexWidth = width + 1;
  const key = (x: number, y: number): number => y * vertexWidth + x;
  const empty = (x: number, y: number): boolean => x < 0 || x >= width || y < 0 || y >= height || !mask[y * width + x];
  let edgeCount = 0;
  for (let y = 0; y < height; y += 1) {
    checkRuntime(deadline, checkpoint);
    for (let x = 0; x < width; x += 1) if (mask[y * width + x]) {
      if (empty(x, y - 1)) edgeCount += 1;
      if (empty(x + 1, y)) edgeCount += 1;
      if (empty(x, y + 1)) edgeCount += 1;
      if (empty(x - 1, y)) edgeCount += 1;
    }
  }
  if (edgeCount === 0) return undefined;
  const vertexCount = vertexWidth * (height + 1);
  const traceBytes = edgeCount * (
    Uint32Array.BYTES_PER_ELEMENT * 3 + ESTIMATED_POINT_BYTES
  ) + vertexCount * (
    Int32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT * 2
  );
  const liveBytes = existingLiveBytes + traceBytes;
  const componentByteLimit = request.maximumComponentBytes ?? MAX_DEPTH_COMPONENT_BYTES;
  if (!Number.isSafeInteger(traceBytes) || liveBytes > componentByteLimit) {
    observeResources(request, 'component-boundary-rejected', liveBytes, mask.length, { minimumX: candidateMinimumX });
    checkRuntime(deadline, checkpoint);
    return undefined;
  }
  observeResources(request, 'component-boundary', liveBytes, mask.length, { minimumX: candidateMinimumX });
  checkRuntime(deadline, checkpoint);
  const edgeStarts = new Uint32Array(edgeCount), edgeEnds = new Uint32Array(edgeCount);
  const loopVertices = new Uint32Array(edgeCount), outgoingEdge = new Int32Array(vertexCount);
  const incomingDegree = new Uint8Array(vertexCount), outgoingDegree = new Uint8Array(vertexCount);
  outgoingEdge.fill(-1);
  let edgeIndex = 0, reliable = true, firstVertex = Infinity;
  const addEdge = (start: number, end: number): void => {
    if ((edgeIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    edgeStarts[edgeIndex] = start;
    edgeEnds[edgeIndex] = end;
    if (outgoingDegree[start] !== 0 || incomingDegree[end] !== 0) reliable = false;
    if (outgoingDegree[start] < 255) outgoingDegree[start] += 1;
    if (incomingDegree[end] < 255) incomingDegree[end] += 1;
    outgoingEdge[start] = edgeIndex;
    firstVertex = Math.min(firstVertex, start);
    edgeIndex += 1;
  };
  for (let y = 0; y < height; y += 1) {
    checkRuntime(deadline, checkpoint);
    for (let x = 0; x < width; x += 1) if (mask[y * width + x]) {
      if (empty(x, y - 1)) addEdge(key(x + 1, y), key(x, y));
      if (empty(x + 1, y)) addEdge(key(x + 1, y + 1), key(x + 1, y));
      if (empty(x, y + 1)) addEdge(key(x, y + 1), key(x + 1, y + 1));
      if (empty(x - 1, y)) addEdge(key(x, y), key(x, y + 1));
    }
  }
  if (!reliable || edgeIndex !== edgeCount || !Number.isFinite(firstVertex)) return undefined;
  let currentVertex = firstVertex;
  for (let step = 0; step < edgeCount; step += 1) {
    if ((step & 255) === 0) checkRuntime(deadline, checkpoint);
    if (step > 0 && currentVertex === firstVertex) return undefined;
    if (incomingDegree[currentVertex] !== 1 || outgoingDegree[currentVertex] !== 1) return undefined;
    loopVertices[step] = currentVertex;
    const nextEdge = outgoingEdge[currentVertex];
    if (nextEdge < 0 || edgeStarts[nextEdge] !== currentVertex) return undefined;
    currentVertex = edgeEnds[nextEdge];
  }
  if (currentVertex !== firstVertex) return undefined;
  const points: Point2[] = new Array(edgeCount);
  for (let index = 0; index < edgeCount; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    const vertex = loopVertices[index], x = vertex % vertexWidth, y = Math.floor(vertex / vertexWidth);
    points[index] = [origin[0] + x * cellSize, origin[1] + y * cellSize];
  }
  checkRuntime(deadline, checkpoint);
  return points;
}

export function simplifyDepthFeatureLoop(
  source: readonly Point2[],
  cellSize: number,
  planarDiameter: number,
  maximumPoints: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
  initialTolerance = Math.max(cellSize * 1.5, planarDiameter * 0.001),
): readonly Point2[] | undefined {
  const sourceBounds = contourBounds(source, deadline, checkpoint);
  const sourceArea = Math.abs(signedArea(source, deadline, checkpoint));
  const sourceWidth = sourceBounds.maxX - sourceBounds.minX;
  const sourceHeight = sourceBounds.maxY - sourceBounds.minY;
  if (!Number.isFinite(sourceArea) || sourceArea <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return undefined;
  let tolerance = initialTolerance;
  for (let attempt = 0; attempt < 17; attempt += 1) {
    checkRuntime(deadline, checkpoint);
    try {
      const simplified = simplifyClosedLoop(source, tolerance, maximumPoints, deadline);
      const outputBounds = contourBounds(simplified, deadline, checkpoint);
      const outputArea = Math.abs(signedArea(simplified, deadline, checkpoint));
      const boundsDrift = Math.max(
        Math.abs((outputBounds.maxX - outputBounds.minX) - sourceWidth) / sourceWidth,
        Math.abs((outputBounds.maxY - outputBounds.minY) - sourceHeight) / sourceHeight,
      );
      const areaDrift = Math.abs(outputArea - sourceArea) / sourceArea;
      if (boundsDrift <= 0.03 + 1e-12 && areaDrift <= 0.03 + 1e-12) return simplified;
    } catch (error) {
      if (error instanceof RangeError && /runtime budget/i.test(error.message)) throw error;
    }
    tolerance /= 2;
  }
  return undefined;
}

type DepthFeatureCandidate = {
  readonly contour: FeatureContour;
  readonly evidence: DepthFeatureSourceEvidence;
};

function greatestValidFeatureFromMask(
  role: 'DEEP_RED' | 'LIGHT_BLUE',
  mask: Uint8Array,
  field: DepthField,
  request: DepthFeatureRequest,
  minimumCells: number,
  deadline: number,
  checkpoint: () => void,
  retainedExternalBytes: number,
  isValid: (candidate: FeatureContour) => boolean,
): DepthFeatureCandidate | undefined {
  const selected = labelComponents(
    mask, field.width, field.height, minimumCells, deadline, checkpoint, request, retainedExternalBytes,
  );
  const componentByteLimit = request.maximumComponentBytes ?? MAX_DEPTH_COMPONENT_BYTES;
  let best: DepthFeatureCandidate | undefined;
  for (let orderIndex = 0; orderIndex < selected.order.length; orderIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const component = selected.order[orderIndex];
    const minimumX = selected.minX[component], minimumY = selected.minY[component];
    const maximumX = selected.maxX[component], maximumY = selected.maxY[component];
    const localWidth = maximumX - minimumX + 3, localHeight = maximumY - minimumY + 3;
    const bestRetainedBytes = (best?.contour.outer.length ?? 0) * ESTIMATED_POINT_BYTES;
    const candidatePeakBytes = selected.workspaceBytes + localWidth * localHeight * 8
      + retainedExternalBytes + bestRetainedBytes;
    if (candidatePeakBytes > componentByteLimit) {
      observeResources(
        request, 'component-boundary-rejected', candidatePeakBytes, field.valid.length, { minimumX },
      );
      checkRuntime(deadline, checkpoint);
      continue;
    }
    const localMask = new Uint8Array(localWidth * localHeight);
    for (let y = minimumY; y <= maximumY; y += 1) {
      checkRuntime(deadline, checkpoint);
      for (let x = minimumX; x <= maximumX; x += 1) {
        if ((x & 255) === 0) checkRuntime(deadline, checkpoint);
        if (selected.labels[y * field.width + x] === component) {
          localMask[(y - minimumY + 1) * localWidth + x - minimumX + 1] = 1;
        }
      }
    }
    observeResources(
      request,
      'component-candidate',
      candidatePeakBytes,
      field.valid.length,
      { sourceCellCount: selected.counts[component], minimumX },
    );
    checkRuntime(deadline, checkpoint);
    const simpleMask = openEnclosedVoids(
      localMask, localWidth, localHeight, deadline, checkpoint,
    );
    let retainedCellCount = 0, minimumDepthMm = Infinity, maximumDepthMm = -Infinity;
    for (let localY = 1; localY + 1 < localHeight; localY += 1) {
      checkRuntime(deadline, checkpoint);
      for (let localX = 1; localX + 1 < localWidth; localX += 1) {
        if ((localX & 255) === 0) checkRuntime(deadline, checkpoint);
        if (!simpleMask[localY * localWidth + localX]) continue;
        const globalX = minimumX + localX - 1, globalY = minimumY + localY - 1;
        const depth = field.depthMm[globalY * field.width + globalX];
        retainedCellCount += 1;
        minimumDepthMm = Math.min(minimumDepthMm, depth);
        maximumDepthMm = Math.max(maximumDepthMm, depth);
      }
    }
    if (retainedCellCount < minimumCells) continue;
    const localOrigin: Point2 = [
      field.origin[0] + (minimumX - 1) * field.cellSizeMm,
      field.origin[1] + (minimumY - 1) * field.cellSizeMm,
    ];
    const source = traceSingleOuter(
      simpleMask,
      localWidth,
      localHeight,
      localOrigin,
      field.cellSizeMm,
      request,
      selected.workspaceBytes + localMask.length * 2 + retainedExternalBytes + bestRetainedBytes,
      minimumX,
      deadline,
      checkpoint,
    );
    if (!source) continue;
    const simplified = simplifyDepthFeatureLoop(
      source,
      field.cellSizeMm,
      request.planarDiameterMm,
      request.budgets.maxContourPointsPerLayer,
      deadline,
      checkpoint,
    );
    if (!simplified) continue;
    const contour: FeatureContour = {
        id: `${request.layerId}-${role === 'DEEP_RED' ? 'deep' : 'light'}`,
        role,
        outer: simplified,
        boundsMm: contourBounds(simplified, deadline, checkpoint),
        areaMm2: Math.abs(signedArea(simplified, deadline, checkpoint)),
    };
    if (!isValid(contour)) continue;
    observeResources(
      request,
      'component-final',
      selected.workspaceBytes + retainedExternalBytes + bestRetainedBytes
        + contour.outer.length * ESTIMATED_POINT_BYTES,
      field.valid.length,
      { sourceCellCount: selected.counts[component], finalAreaMm2: contour.areaMm2, minimumX },
    );
    checkRuntime(deadline, checkpoint);
    const candidate: DepthFeatureCandidate = {
      contour,
      evidence: {
        occupiedCellCount: retainedCellCount,
        componentCount: selected.componentCount,
        sourceAreaMm2: retainedCellCount * field.cellSizeMm * field.cellSizeMm,
        minimumDepthMm,
        maximumDepthMm,
      },
    };
    if (!best || candidate.contour.areaMm2 > best.contour.areaMm2 + 1e-12
      || Math.abs(candidate.contour.areaMm2 - best.contour.areaMm2) <= 1e-12
        && (candidate.contour.boundsMm.minX < best.contour.boundsMm.minX
          || candidate.contour.boundsMm.minX === best.contour.boundsMm.minX
            && candidate.contour.boundsMm.minY < best.contour.boundsMm.minY)) {
      best = candidate;
    }
  }
  return best;
}

function omission(
  code: DepthFeatureOmissionCode,
  warning: string,
  diagnostics: Omit<DepthFeatureDiagnostics, 'omissionCode'>,
): DepthFeatureResult {
  return {
    red: undefined,
    blue: undefined,
    warning,
    omissionCode: code,
    diagnostics: { ...diagnostics, omissionCode: code },
    evidence: {},
  };
}

export function extractAdaptiveDepthFeatures(projected: ProjectedMesh, request: DepthFeatureRequest): DepthFeatureResult {
  const deadline = request.deadline ?? Date.now() + request.budgets.maxRuntimeMs;
  const checkpoint = request.checkpoint ?? (() => undefined);
  checkRuntime(deadline, checkpoint);
  const effectiveRequest = { ...request, deadline, checkpoint };
  const field = buildDepthField(projected, effectiveRequest);
  const samples: number[] = [];
  for (let index = 0; index < field.depthMm.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    if (field.valid[index] && Number.isFinite(field.depthMm[index]) && field.depthMm[index] > 0) {
      samples.push(field.depthMm[index]);
    }
  }
  if (samples.length === 0) return omission('INSUFFICIENT_DEPTH_DATA', DEPTH_DATA_OMISSION_WARNING, {
    cellSizeMm: field.cellSizeMm,
    contrastMm: 0,
    redThresholdMm: 0,
    blueThresholdMm: 0,
  });
  samples.sort((left, right) => {
    checkRuntime(deadline, checkpoint);
    return left - right;
  });
  const blueThresholdMm = quantile(samples, 0.4), redThresholdMm = quantile(samples, 0.75);
  const contrastMm = redThresholdMm - blueThresholdMm;
  const diagnostics = { field: undefined, cellSizeMm: field.cellSizeMm, contrastMm, redThresholdMm, blueThresholdMm };
  const { field: _field, ...publicDiagnostics } = diagnostics;
  if (contrastMm + 1e-12 < Math.max(2 * field.cellSizeMm, request.planarDiameterMm * 0.005)) {
    return omission('INSUFFICIENT_CONTRAST', DEPTH_CONTRAST_OMISSION_WARNING, publicDiagnostics);
  }
  const redSource = new Uint8Array(field.valid.length), blueSource = new Uint8Array(field.valid.length);
  for (let index = 0; index < field.valid.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    if (!field.valid[index]) continue;
    const depth = field.depthMm[index];
    if (depth >= redThresholdMm) redSource[index] = 1;
    else if (depth >= blueThresholdMm) blueSource[index] = 1;
  }
  const closedRed = closeDepthBandMask(
    redSource, field.valid, blueSource, field.width, field.height, deadline, checkpoint,
  );
  const closedBlue = closeDepthBandMask(
    blueSource, field.valid, redSource, field.width, field.height, deadline, checkpoint,
  );
  for (let index = 0; index < field.valid.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    if (closedRed[index]) closedBlue[index] = 0;
  }
  const minimumCells = Math.ceil(Math.max(
    4,
    request.exteriorAreaMm2 * 0.001 / (field.cellSizeMm * field.cellSizeMm),
  ));
  const clearanceMm = Math.max(field.cellSizeMm, request.planarDiameterMm * 0.001);
  const centralHole = holeLoop(request);
  const redCandidate = greatestValidFeatureFromMask(
    'DEEP_RED', closedRed, field, request, minimumCells, deadline, checkpoint,
    0,
    (red) => validateDepthFeatureContours({
      exterior: request.exterior,
      centralHole,
      red,
      clearanceMm,
      deadline,
      checkpoint,
    }).ok,
  );
  const red = redCandidate?.contour;
  const blueCandidate = greatestValidFeatureFromMask(
    'LIGHT_BLUE', closedBlue, field, request, minimumCells, deadline, checkpoint,
    (red?.outer.length ?? 0) * ESTIMATED_POINT_BYTES,
    (blue) => validateDepthFeatureContours({
      exterior: request.exterior,
      centralHole,
      red,
      blue,
      clearanceMm,
      deadline,
      checkpoint,
    }).ok,
  );
  const blue = blueCandidate?.contour;
  checkRuntime(deadline, checkpoint);
  const incomplete = !red || !blue;
  return {
    red,
    blue,
    warning: incomplete ? DEPTH_GEOMETRY_OMISSION_WARNING : undefined,
    omissionCode: incomplete ? 'UNRELIABLE_DEPTH_GEOMETRY' : undefined,
    diagnostics: incomplete
      ? { ...publicDiagnostics, omissionCode: 'UNRELIABLE_DEPTH_GEOMETRY' }
      : publicDiagnostics,
    evidence: {
      red: red ? redCandidate?.evidence : undefined,
      blue: blue ? blueCandidate?.evidence : undefined,
    },
  };
}
