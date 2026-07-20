import type { Point2 } from '../decomposition/types';
import type { TriangleMesh } from '../mesh/types';
import type { Vec3 } from '../types';
import type { OutlineAxisSelection, OutlineBudgets, OutlineLayerSpec } from './types';

export type ProjectedVertex = readonly [number, number, number];
export type ProjectedMesh = {
  readonly vertices: readonly ProjectedVertex[];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly planarDiameter: number;
};
export type RasterContour = {
  readonly outer: readonly Point2[];
  readonly occupiedCellCount: number;
  readonly componentCount: number;
};

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('Contour extraction requires a finite non-zero axis');
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export function projectMesh(mesh: TriangleMesh, selection: OutlineAxisSelection): ProjectedMesh {
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0
    || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0
    || selection.axis.origin.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Contour extraction requires a finite non-empty triangle mesh');
  }
  const axial = normalize(selection.axis.direction);
  let leastAligned = 0;
  for (let component = 1; component < 3; component += 1) {
    if (Math.abs(axial[component]) < Math.abs(axial[leastAligned])) leastAligned = component;
  }
  const reference: Vec3 = leastAligned === 0 ? [1, 0, 0] : leastAligned === 1 ? [0, 1, 0] : [0, 0, 1];
  const planeX = normalize(cross(axial, reference)), planeY = cross(axial, planeX);
  const vertices: ProjectedVertex[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const relative: Vec3 = [
      mesh.positions[index] - selection.axis.origin[0],
      mesh.positions[index + 1] - selection.axis.origin[1],
      mesh.positions[index + 2] - selection.axis.origin[2],
    ];
    if (relative.some((value) => !Number.isFinite(value))) throw new RangeError('Contour extraction requires finite mesh coordinates');
    const vertex: ProjectedVertex = [dot(relative, planeX), dot(relative, planeY), dot(relative, axial)];
    vertices.push(vertex);
  }
  const triangles: (readonly [number, number, number])[] = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const triangle = [mesh.indices[index], mesh.indices[index + 1], mesh.indices[index + 2]] as const;
    if (triangle.some((vertex) => vertex >= vertices.length)) throw new RangeError('Contour extraction requires valid triangle indices');
    triangles.push(triangle);
    for (const vertexIndex of triangle) {
      const [x, y] = vertices[vertexIndex];
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  const width = maxX - minX, height = maxY - minY, planarDiameter = Math.hypot(width, height);
  if (![width, height, planarDiameter].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new RangeError('Contour extraction requires non-zero planar mesh bounds');
  }
  return { vertices, triangles, minX, minY, maxX, maxY, planarDiameter };
}

function markLine(mask: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 4));
  let priorX = Math.floor(x0), priorY = Math.floor(y0);
  const mark = (x: number, y: number) => {
    for (const [nx, ny] of [[x, y], [x - 1, y], [x, y - 1], [x - 1, y - 1]]) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) mask[ny * width + nx] = 1;
    }
  };
  mark(priorX, priorY);
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.floor(x0 + (x1 - x0) * (step / steps)), y = Math.floor(y0 + (y1 - y0) * (step / steps));
    if (x !== priorX && y !== priorY) mark(x, priorY);
    mark(x, y); priorX = x; priorY = y;
  }
}

function rasterizeTriangle(mask: Uint8Array, width: number, height: number, points: readonly Point2[]): void {
  for (let edge = 0; edge < 3; edge += 1) {
    const start = points[edge], end = points[(edge + 1) % 3];
    markLine(mask, width, height, start[0], start[1], end[0], end[1]);
  }
  const cross2 = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = cross2(points[0], points[1], points[2]);
  if (Math.abs(area) <= Number.EPSILON) return;
  const minX = Math.max(0, Math.floor(Math.min(...points.map(([x]) => x))));
  const maxX = Math.min(width - 1, Math.floor(Math.max(...points.map(([x]) => x))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map(([, y]) => y))));
  const maxY = Math.min(height - 1, Math.floor(Math.max(...points.map(([, y]) => y))));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const point: Point2 = [x + 0.5, y + 0.5];
    const signs = [cross2(points[0], points[1], point), cross2(points[1], points[2], point), cross2(points[2], points[0], point)];
    if (signs.every((value) => value >= 0) || signs.every((value) => value <= 0)) mask[y * width + x] = 1;
  }
}

function close3x3(source: Uint8Array, width: number, height: number): Uint8Array {
  const dilated = new Uint8Array(source.length), result = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    for (let dy = -1; dy <= 1 && dilated[y * width + x] === 0; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && source[ny * width + nx]) { dilated[y * width + x] = 1; break; }
    }
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let occupied = true;
    for (let dy = -1; dy <= 1 && occupied; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || !dilated[ny * width + nx]) { occupied = false; break; }
    }
    if (occupied) result[y * width + x] = 1;
  }
  return result;
}

function fillHoles(mask: Uint8Array, width: number, height: number): void {
  const exterior = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  const enqueue = (index: number) => { if (!mask[index] && !exterior[index]) { exterior[index] = 1; queue[tail++] = index; } };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y + 1 < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const current = queue[head++], x = current % width, y = Math.floor(current / width);
    if (x > 0) enqueue(current - 1); if (x + 1 < width) enqueue(current + 1);
    if (y > 0) enqueue(current - width); if (y + 1 < height) enqueue(current + width);
  }
  for (let index = 0; index < mask.length; index += 1) if (!mask[index] && !exterior[index]) mask[index] = 1;
}

function greatestComponent(mask: Uint8Array, width: number, height: number): { readonly mask: Uint8Array; readonly count: number; readonly components: number } {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let best: number[] = [], bestMinX = Infinity, bestMinY = Infinity, components = 0;
  for (let start = 0; start < mask.length; start += 1) if (mask[start] && !visited[start]) {
    components += 1; let head = 0, tail = 0, minX = start % width, minY = Math.floor(start / width);
    const cells: number[] = []; visited[start] = 1; queue[tail++] = start;
    while (head < tail) {
      const current = queue[head++], x = current % width, y = Math.floor(current / width); cells.push(current);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
        if (next >= 0 && mask[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
      }
    }
    if (cells.length > best.length || (cells.length === best.length && (minX < bestMinX || (minX === bestMinX && minY < bestMinY)))) {
      best = cells; bestMinX = minX; bestMinY = minY;
    }
  }
  if (best.length === 0) throw new RangeError('Projected contour raster produced an empty mask');
  const selected = new Uint8Array(mask.length); for (const cell of best) selected[cell] = 1;
  return { mask: selected, count: best.length, components };
}

type Edge = readonly [number, number];
function traceOuter(mask: Uint8Array, width: number, height: number, originX: number, originY: number, cellSize: number): readonly Point2[] {
  const vertexWidth = width + 1, edges: Edge[] = [];
  const key = (x: number, y: number) => y * vertexWidth + x;
  const empty = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height || mask[y * width + x] === 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (mask[y * width + x]) {
    if (empty(x, y - 1)) edges.push([key(x + 1, y), key(x, y)]);
    if (empty(x + 1, y)) edges.push([key(x + 1, y + 1), key(x + 1, y)]);
    if (empty(x, y + 1)) edges.push([key(x, y + 1), key(x + 1, y + 1)]);
    if (empty(x - 1, y)) edges.push([key(x, y), key(x, y + 1)]);
  }
  edges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const outgoing = new Map<number, number[]>();
  for (const [start, end] of edges) outgoing.set(start, [...(outgoing.get(start) ?? []), end]);
  for (const values of outgoing.values()) values.sort((left, right) => left - right);
  const unused = new Set(edges.map(([start, end]) => `${start}:${end}`)), loops: number[][] = [];
  for (const [edgeStart, edgeEnd] of edges) {
    if (!unused.has(`${edgeStart}:${edgeEnd}`)) continue;
    const loop = [edgeStart]; let start = edgeStart, end = edgeEnd;
    for (let guard = 0; guard <= edges.length; guard += 1) {
      unused.delete(`${start}:${end}`); loop.push(end);
      if (end === edgeStart) break;
      const candidates = (outgoing.get(end) ?? []).filter((candidate) => unused.has(`${end}:${candidate}`));
      const coordinates = (vertex: number): readonly [number, number] => [vertex % vertexWidth, Math.floor(vertex / vertexWidth)];
      const direction = (from: number, to: number): number => {
        const [fromX, fromY] = coordinates(from), [toX, toY] = coordinates(to);
        return toX > fromX ? 0 : toY > fromY ? 1 : toX < fromX ? 2 : 3;
      };
      const incomingDirection = direction(start, end), turnRank = [1, 2, 3, 0];
      candidates.sort((left, right) => turnRank[(direction(end, left) - incomingDirection + 4) % 4]
        - turnRank[(direction(end, right) - incomingDirection + 4) % 4] || left - right);
      const next = candidates[0];
      if (next === undefined) throw new RangeError('Projected contour boundary is open');
      start = end; end = next;
    }
    if (loop[loop.length - 1] !== edgeStart) throw new RangeError('Projected contour tracing exceeded its edge budget');
    loops.push(loop.slice(0, -1));
  }
  const pointsFor = (loop: readonly number[]): Point2[] => loop.map((vertex) => {
    const x = vertex % vertexWidth, y = Math.floor(vertex / vertexWidth);
    return [originX + x * cellSize, originY + y * cellSize];
  });
  const area = (points: readonly Point2[]) => Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]; return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
  return loops.map(pointsFor).sort((left, right) => area(right) - area(left)
    || Math.min(...left.map(([x]) => x)) - Math.min(...right.map(([x]) => x))
    || Math.min(...left.map(([, y]) => y)) - Math.min(...right.map(([, y]) => y)))[0];
}

export function rasterCellSize(projected: ProjectedMesh): number {
  return Math.min(0.5, Math.max(0.05, projected.planarDiameter / 512));
}

export function rasterProjectLayer(
  projected: ProjectedMesh,
  spec: OutlineLayerSpec,
  budgets: OutlineBudgets,
  deadline: number,
): RasterContour {
  if (![spec.zStart, spec.zEnd, spec.zMid].every(Number.isFinite) || spec.zEnd <= spec.zStart) {
    throw new RangeError('Projected contour requires a finite positive layer interval');
  }
  const cellSize = rasterCellSize(projected), originX = projected.minX - cellSize, originY = projected.minY - cellSize;
  const width = Math.ceil((projected.maxX - projected.minX) / cellSize) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / cellSize) + 3;
  if (width > budgets.maxRasterWidth || height > budgets.maxRasterHeight) throw new RangeError('Projected contour exceeds the raster dimension budget');
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < projected.triangles.length; index += 1) {
    if ((index & 1023) === 0 && Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
    const triangle = projected.triangles[index], vertices = triangle.map((vertex) => projected.vertices[vertex]);
    const minZ = Math.min(...vertices.map(([, , z]) => z)), maxZ = Math.max(...vertices.map(([, , z]) => z));
    if (maxZ < spec.zStart || minZ > spec.zEnd) continue;
    rasterizeTriangle(mask, width, height, vertices.map(([x, y]) => [(x - originX) / cellSize, (y - originY) / cellSize] as const));
  }
  const closed = close3x3(mask, width, height); fillHoles(closed, width, height);
  const selected = greatestComponent(closed, width, height);
  return {
    outer: traceOuter(selected.mask, width, height, originX, originY, cellSize),
    occupiedCellCount: selected.count,
    componentCount: selected.components,
  };
}
