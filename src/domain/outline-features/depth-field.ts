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

type CellComponent = {
  readonly mask: Uint8Array;
  readonly cells: readonly number[];
  readonly componentCount: number;
};

type ReliableTriangle = {
  readonly vertices: readonly [ProjectedVertex, ProjectedVertex, ProjectedVertex];
  readonly component: number;
};

type SurfaceHit = {
  readonly z: number;
  readonly facing: -1 | 1;
  readonly component: number;
};

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Depth feature extraction exceeded the runtime budget');
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
function reliableSurfaceTriangles(
  projected: ProjectedMesh,
  deadline: number,
  checkpoint: () => void,
): readonly ReliableTriangle[] {
  const parents = new Int32Array(projected.triangles.length);
  const edgeUses = new Map<string, number[]>();
  const vertices: (readonly [ProjectedVertex, ProjectedVertex, ProjectedVertex])[] = [];
  for (let triangleIndex = 0; triangleIndex < projected.triangles.length; triangleIndex += 1) {
    if ((triangleIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    parents[triangleIndex] = triangleIndex;
    const triangle = projected.triangles[triangleIndex];
    if (triangle.length !== 3 || triangle.some((vertex) => !Number.isSafeInteger(vertex)
      || vertex < 0 || vertex >= projected.vertices.length)) {
      throw new RangeError('Depth feature extraction requires valid source triangles');
    }
    const triangleVertices = triangle.map((index) => projected.vertices[index]) as unknown as [
      ProjectedVertex, ProjectedVertex, ProjectedVertex,
    ];
    if (triangleVertices.some((vertex) => vertex.length !== 3 || vertex.some((value) => !Number.isFinite(value)))) {
      throw new RangeError('Depth feature extraction requires finite source triangles');
    }
    vertices.push(triangleVertices);
    for (let edge = 0; edge < 3; edge += 1) {
      const first = triangle[edge], second = triangle[(edge + 1) % 3];
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      const uses = edgeUses.get(key);
      if (uses) uses.push(triangleIndex); else edgeUses.set(key, [triangleIndex]);
    }
  }
  const root = (value: number): number => {
    let current = value;
    while (parents[current] !== current) current = parents[current];
    while (parents[value] !== value) {
      const next = parents[value];
      parents[value] = current;
      value = next;
    }
    return current;
  };
  const join = (left: number, right: number): void => {
    const leftRoot = root(left), rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  for (const uses of edgeUses.values()) {
    checkRuntime(deadline, checkpoint);
    for (let index = 1; index < uses.length; index += 1) join(uses[0], uses[index]);
  }
  const closed = new Map<number, boolean>();
  for (let triangleIndex = 0; triangleIndex < parents.length; triangleIndex += 1) {
    if ((triangleIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    closed.set(root(triangleIndex), true);
  }
  for (const uses of edgeUses.values()) {
    checkRuntime(deadline, checkpoint);
    if (uses.length !== 2) closed.set(root(uses[0]), false);
  }
  const componentIds = new Map<number, number>();
  const result: ReliableTriangle[] = [];
  for (let triangleIndex = 0; triangleIndex < vertices.length; triangleIndex += 1) {
    if ((triangleIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    const componentRoot = root(triangleIndex);
    if (!closed.get(componentRoot)) continue;
    let component = componentIds.get(componentRoot);
    if (component === undefined) {
      component = componentIds.size;
      componentIds.set(componentRoot, component);
    }
    result.push({ vertices: vertices[triangleIndex], component });
  }
  return result;
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
  const hitsByCell = new Map<number, SurfaceHit[]>();
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
  const reliableTriangles = reliableSurfaceTriangles(projected, deadline, checkpoint);
  for (let triangleIndex = 0; triangleIndex < reliableTriangles.length; triangleIndex += 1) {
    if ((triangleIndex & 63) === 0) checkRuntime(deadline, checkpoint);
    const { vertices, component } = reliableTriangles[triangleIndex];
    const projectedArea = (vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1])
      - (vertices[1][1] - vertices[0][1]) * (vertices[2][0] - vertices[0][0]);
    if (projectedArea === 0) continue;
    const facing: -1 | 1 = projectedArea < 0 ? -1 : 1;
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
        const index = y * width + x;
        if (!eligible[index]) continue;
        const z = triangleSample(
          [origin[0] + (x + 0.5) * cellSize, origin[1] + (y + 0.5) * cellSize],
          vertices[0], vertices[1], vertices[2],
        );
        if (z === undefined) continue;
        const hits = hitsByCell.get(index);
        const hit = { z, facing, component } as const;
        if (hits) hits.push(hit); else hitsByCell.set(index, [hit]);
      }
    }
  }
  checkRuntime(deadline, checkpoint);
  const depthMm = new Float32Array(width * height), valid = new Uint8Array(width * height);
  const positiveTolerance = Math.max(1e-9, request.planarDiameterMm * 1e-12);
  for (let index = 0; index < depthMm.length; index += 1) {
    if ((index & 1023) === 0) checkRuntime(deadline, checkpoint);
    const hits = hitsByCell.get(index);
    if (!eligible[index] || !hits) continue;
    const byComponent = new Map<number, SurfaceHit[]>();
    for (const hit of hits) {
      const componentHits = byComponent.get(hit.component);
      if (componentHits) componentHits.push(hit); else byComponent.set(hit.component, [hit]);
    }
    let depth = 0;
    for (const componentHits of byComponent.values()) {
      componentHits.sort((left, right) => left.z - right.z || left.facing - right.facing);
      const unique: { z: number; facing: number }[] = [];
      for (const hit of componentHits) {
        const previous = unique[unique.length - 1];
        if (previous && Math.abs(previous.z - hit.z) <= positiveTolerance) previous.facing += hit.facing;
        else unique.push({ z: hit.z, facing: hit.facing });
      }
      if (unique.length < 2 || unique.length % 2 !== 0) continue;
      let componentDepth = 0, reliablePairs = true;
      for (let pair = 0; pair < unique.length; pair += 2) {
        const front = unique[pair], back = unique[pair + 1];
        if (front.facing === 0 || back.facing === 0 || Math.sign(front.facing) === Math.sign(back.facing)) {
          reliablePairs = false;
          break;
        }
        const clippedFront = Math.max(front.z, request.layer.zStart);
        const clippedBack = Math.min(back.z, request.layer.zEnd);
        if (clippedBack - clippedFront > positiveTolerance) componentDepth += clippedBack - clippedFront;
      }
      if (reliablePairs) depth = Math.max(depth, componentDepth);
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

function selectComponents(
  source: Uint8Array,
  width: number,
  height: number,
  minimumCells: number,
  deadline: number,
  checkpoint: () => void,
): readonly CellComponent[] {
  const visited = new Uint8Array(source.length), queue = new Int32Array(source.length);
  const candidates: { readonly cells: readonly number[]; readonly minX: number; readonly minY: number }[] = [];
  for (let start = 0; start < source.length; start += 1) {
    if ((start & 255) === 0) checkRuntime(deadline, checkpoint);
    if (!source[start] || visited[start]) continue;
    let head = 0, tail = 0, minX = start % width, minY = Math.floor(start / width);
    const cells: number[] = [];
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      if ((head & 255) === 0) checkRuntime(deadline, checkpoint);
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      cells.push(current);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) if (next >= 0 && source[next] && !visited[next]) {
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    if (cells.length < minimumCells) continue;
    candidates.push({ cells, minX, minY });
  }
  candidates.sort((left, right) => right.cells.length - left.cells.length
    || left.minX - right.minX || left.minY - right.minY);
  return candidates.map((candidate) => {
    const mask = new Uint8Array(source.length);
    for (let index = 0; index < candidate.cells.length; index += 1) {
      if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
      mask[candidate.cells[index]] = 1;
    }
    return { mask, cells: candidate.cells, componentCount: candidates.length };
  });
}

type GridEdge = readonly [number, number];

/** Opens raster holes with deterministic one-cell seams because public features are singular simple loops. */
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
    for (let x = seamX; x >= 0; x -= 1) {
      if ((x & 255) === 0) checkRuntime(deadline, checkpoint);
      result[seamY * width + x] = 0;
    }
  }
  return result;
}

function traceGreatestOuter(
  mask: Uint8Array,
  width: number,
  height: number,
  origin: Point2,
  cellSize: number,
  deadline: number,
  checkpoint: () => void,
): readonly Point2[] | undefined {
  const vertexWidth = width + 1, edges: GridEdge[] = [];
  const key = (x: number, y: number): number => y * vertexWidth + x;
  const empty = (x: number, y: number): boolean => x < 0 || x >= width || y < 0 || y >= height || !mask[y * width + x];
  for (let y = 0; y < height; y += 1) {
    checkRuntime(deadline, checkpoint);
    for (let x = 0; x < width; x += 1) if (mask[y * width + x]) {
      if (empty(x, y - 1)) edges.push([key(x + 1, y), key(x, y)]);
      if (empty(x + 1, y)) edges.push([key(x + 1, y + 1), key(x + 1, y)]);
      if (empty(x, y + 1)) edges.push([key(x, y + 1), key(x + 1, y + 1)]);
      if (empty(x - 1, y)) edges.push([key(x, y), key(x, y + 1)]);
    }
  }
  if (edges.length === 0) return undefined;
  edges.sort((left, right) => {
    checkRuntime(deadline, checkpoint);
    return left[0] - right[0] || left[1] - right[1];
  });
  const outgoing = new Map<number, number[]>(), unused = new Set<string>();
  for (let index = 0; index < edges.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    const [start, end] = edges[index], values = outgoing.get(start);
    if (values) values.push(end); else outgoing.set(start, [end]);
    unused.add(`${start}:${end}`);
  }
  for (const values of outgoing.values()) values.sort((left, right) => {
    checkRuntime(deadline, checkpoint);
    return left - right;
  });
  const loops: number[][] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if ((edgeIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    const [edgeStart, edgeEnd] = edges[edgeIndex];
    if (!unused.has(`${edgeStart}:${edgeEnd}`)) continue;
    const loop = [edgeStart];
    let start = edgeStart, end = edgeEnd;
    for (let guard = 0; guard <= edges.length; guard += 1) {
      if ((guard & 255) === 0) checkRuntime(deadline, checkpoint);
      unused.delete(`${start}:${end}`);
      loop.push(end);
      if (end === edgeStart) break;
      const candidates = (outgoing.get(end) ?? []).filter((candidate) => unused.has(`${end}:${candidate}`));
      const coordinates = (vertex: number): readonly [number, number] => [vertex % vertexWidth, Math.floor(vertex / vertexWidth)];
      const direction = (from: number, to: number): number => {
        const [fromX, fromY] = coordinates(from), [toX, toY] = coordinates(to);
        return toX > fromX ? 0 : toY > fromY ? 1 : toX < fromX ? 2 : 3;
      };
      const incoming = direction(start, end), turnRank = [1, 2, 3, 0];
      candidates.sort((left, right) => turnRank[(direction(end, left) - incoming + 4) % 4]
        - turnRank[(direction(end, right) - incoming + 4) % 4] || left - right);
      const next = candidates[0];
      if (next === undefined) return undefined;
      start = end;
      end = next;
    }
    if (loop[loop.length - 1] !== edgeStart) return undefined;
    loops.push(loop.slice(0, -1));
  }
  const candidates: { readonly points: readonly Point2[]; readonly area: number; readonly bounds: ReturnType<typeof contourBounds> }[] = [];
  for (let loopIndex = 0; loopIndex < loops.length; loopIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const loop = loops[loopIndex], points: Point2[] = [];
    for (let index = 0; index < loop.length; index += 1) {
      if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
      const vertex = loop[index];
      const x = vertex % vertexWidth, y = Math.floor(vertex / vertexWidth);
      points.push([origin[0] + x * cellSize, origin[1] + y * cellSize]);
    }
    const bounds = contourBounds(points, deadline, checkpoint);
    candidates.push({ points, area: Math.abs(signedArea(points, deadline, checkpoint)), bounds });
  }
  candidates.sort((left, right) => {
    checkRuntime(deadline, checkpoint);
    return right.area - left.area || left.bounds.minX - right.bounds.minX || left.bounds.minY - right.bounds.minY;
  });
  return candidates[0]?.points;
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

export function selectGreatestValidDepthFeatureContour(
  candidates: readonly FeatureContour[],
  isValid: (candidate: FeatureContour) => boolean,
): FeatureContour | undefined {
  return [...candidates].sort((left, right) => right.areaMm2 - left.areaMm2
    || left.boundsMm.minX - right.boundsMm.minX
    || left.boundsMm.minY - right.boundsMm.minY)
    .find(isValid);
}

function featureCandidatesFromMask(
  role: 'DEEP_RED' | 'LIGHT_BLUE',
  mask: Uint8Array,
  field: DepthField,
  request: DepthFeatureRequest,
  minimumCells: number,
  deadline: number,
  checkpoint: () => void,
): readonly DepthFeatureCandidate[] {
  const selectedComponents = selectComponents(
    mask, field.width, field.height, minimumCells, deadline, checkpoint,
  );
  const candidates: DepthFeatureCandidate[] = [];
  for (const selected of selectedComponents) {
    checkRuntime(deadline, checkpoint);
    const simpleMask = openEnclosedVoids(
      selected.mask, field.width, field.height, deadline, checkpoint,
    );
    const retainedCells: number[] = [];
    for (let index = 0; index < selected.cells.length; index += 1) {
      if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
      const cell = selected.cells[index];
      if (simpleMask[cell]) retainedCells.push(cell);
    }
    if (retainedCells.length < minimumCells) continue;
    const source = traceGreatestOuter(
      simpleMask, field.width, field.height, field.origin, field.cellSizeMm, deadline, checkpoint,
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
    let minimumDepthMm = Infinity, maximumDepthMm = -Infinity;
    for (let index = 0; index < retainedCells.length; index += 1) {
      if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
      const depth = field.depthMm[retainedCells[index]];
      minimumDepthMm = Math.min(minimumDepthMm, depth);
      maximumDepthMm = Math.max(maximumDepthMm, depth);
    }
    candidates.push({
      contour: {
        id: `${request.layerId}-${role === 'DEEP_RED' ? 'deep' : 'light'}`,
        role,
        outer: simplified,
        boundsMm: contourBounds(simplified, deadline, checkpoint),
        areaMm2: Math.abs(signedArea(simplified, deadline, checkpoint)),
      },
      evidence: {
        occupiedCellCount: retainedCells.length,
        componentCount: selected.componentCount,
        sourceAreaMm2: retainedCells.length * field.cellSizeMm * field.cellSizeMm,
        minimumDepthMm,
        maximumDepthMm,
      },
    });
  }
  return candidates;
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
  const redCandidates = featureCandidatesFromMask(
    'DEEP_RED', closedRed, field, request, minimumCells, deadline, checkpoint,
  );
  const blueCandidates = featureCandidatesFromMask(
    'LIGHT_BLUE', closedBlue, field, request, minimumCells, deadline, checkpoint,
  );
  const clearanceMm = Math.max(field.cellSizeMm, request.planarDiameterMm * 0.001);
  const centralHole = holeLoop(request);
  const red = selectGreatestValidDepthFeatureContour(
    redCandidates.map((candidate) => candidate.contour),
    (candidate) => validateDepthFeatureContours({
    exterior: request.exterior,
    centralHole,
    red: candidate,
    clearanceMm,
    deadline,
    checkpoint,
    }).ok,
  );
  const redCandidate = redCandidates.find((candidate) => candidate.contour === red);
  const blue = selectGreatestValidDepthFeatureContour(
    blueCandidates.map((candidate) => candidate.contour),
    (candidate) => validateDepthFeatureContours({
    exterior: request.exterior,
    centralHole,
    red,
    blue: candidate,
    clearanceMm,
    deadline,
    checkpoint,
    }).ok,
  );
  const blueCandidate = blueCandidates.find((candidate) => candidate.contour === blue);
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
