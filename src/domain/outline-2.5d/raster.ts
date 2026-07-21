import type { Point2 } from '../decomposition/types';
import type { TriangleMesh } from '../mesh/types';
import type { Vec3 } from '../types';
import type { OutlineAxisSelection, OutlineBudgets, OutlineLayerSpec } from './types';

export type ProjectedVertex = readonly [number, number, number];
export type OutlineAxisBasis = {
  readonly origin: Vec3;
  readonly axial: Vec3;
  readonly planeX: Vec3;
  readonly planeY: Vec3;
};
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
  readonly enclosedVoids: readonly {
    readonly outer: readonly Point2[];
    readonly occupiedCellCount: number;
  }[];
  readonly sourceBoundsMm: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
  readonly sourceAreaMm2: number;
};

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
}

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

export function createOutlineAxisBasis(axis: Pick<OutlineAxisSelection['axis'], 'origin' | 'direction'>): OutlineAxisBasis {
  if (axis.origin.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Contour extraction requires a finite axis origin');
  }
  const axial = normalize(axis.direction);
  let leastAligned = 0;
  for (let component = 1; component < 3; component += 1) {
    if (Math.abs(axial[component]) < Math.abs(axial[leastAligned])) leastAligned = component;
  }
  const reference: Vec3 = leastAligned === 0 ? [1, 0, 0] : leastAligned === 1 ? [0, 1, 0] : [0, 0, 1];
  const planeX = normalize(cross(axial, reference));
  return { origin: axis.origin, axial, planeX, planeY: cross(axial, planeX) };
}

export function projectPointToOutlineBasis(point: Vec3, basis: OutlineAxisBasis): ProjectedVertex {
  const relative: Vec3 = [
    point[0] - basis.origin[0],
    point[1] - basis.origin[1],
    point[2] - basis.origin[2],
  ];
  if (relative.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Contour extraction requires finite mesh coordinates');
  }
  return [dot(relative, basis.planeX), dot(relative, basis.planeY), dot(relative, basis.axial)];
}

export function projectMesh(mesh: TriangleMesh, selection: OutlineAxisSelection, deadline = Infinity): ProjectedMesh {
  checkDeadline(deadline);
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0
    || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0
    || selection.axis.origin.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Contour extraction requires a finite non-empty triangle mesh');
  }
  const basis = createOutlineAxisBasis(selection.axis);
  const vertices: ProjectedVertex[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    if ((index & 1023) === 0) checkDeadline(deadline);
    const vertex = projectPointToOutlineBasis([
      mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2],
    ], basis);
    vertices.push(vertex);
  }
  const triangles: (readonly [number, number, number])[] = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    if ((index & 1023) === 0) checkDeadline(deadline);
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

function coordinateCells(value: number): readonly number[] {
  const nearest = Math.round(value);
  const tolerance = Math.max(1, Math.abs(value)) * 64 * Number.EPSILON;
  return Math.abs(value - nearest) <= tolerance ? [nearest - 1, nearest] : [Math.floor(value)];
}

/** Marks every and only closed grid cell intersected by the finite segment. */
export function markLineSupercover(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  deadline: number,
): void {
  checkDeadline(deadline);
  const dx = x1 - x0, dy = y1 - y0;
  const events: number[] = [0, 1];
  if (dx !== 0) {
    const minimum = Math.min(x0, x1), maximum = Math.max(x0, x1);
    for (let boundary = Math.floor(minimum) + 1; boundary < maximum; boundary += 1) {
      if ((events.length & 255) === 0) checkDeadline(deadline);
      events.push((boundary - x0) / dx);
    }
  }
  if (dy !== 0) {
    const minimum = Math.min(y0, y1), maximum = Math.max(y0, y1);
    for (let boundary = Math.floor(minimum) + 1; boundary < maximum; boundary += 1) {
      if ((events.length & 255) === 0) checkDeadline(deadline);
      events.push((boundary - y0) / dy);
    }
  }
  events.sort((left, right) => { checkDeadline(deadline); return left - right; });
  const uniqueEvents: number[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const event = events[index], prior = uniqueEvents[uniqueEvents.length - 1];
    if (prior === undefined || Math.abs(event - prior) > 64 * Number.EPSILON) uniqueEvents.push(event);
  }
  const markAt = (parameter: number): void => {
    const xCells = coordinateCells(x0 + dx * parameter), yCells = coordinateCells(y0 + dy * parameter);
    for (const x of xCells) for (const y of yCells) {
      if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1;
    }
  };
  for (let index = 0; index < uniqueEvents.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    markAt(uniqueEvents[index]);
    if (index + 1 < uniqueEvents.length) markAt((uniqueEvents[index] + uniqueEvents[index + 1]) / 2);
  }
}

function rasterizeTriangle(mask: Uint8Array, width: number, height: number, points: readonly Point2[], deadline: number): void {
  for (let edge = 0; edge < 3; edge += 1) {
    const start = points[edge], end = points[(edge + 1) % 3];
    markLineSupercover(mask, width, height, start[0], start[1], end[0], end[1], deadline);
  }
  const cross2 = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = cross2(points[0], points[1], points[2]);
  if (Math.abs(area) <= Number.EPSILON) return;
  const minX = Math.max(0, Math.floor(Math.min(...points.map(([x]) => x))));
  const maxX = Math.min(width - 1, Math.floor(Math.max(...points.map(([x]) => x))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map(([, y]) => y))));
  const maxY = Math.min(height - 1, Math.floor(Math.max(...points.map(([, y]) => y))));
  for (let y = minY; y <= maxY; y += 1) {
    checkDeadline(deadline);
    for (let x = minX; x <= maxX; x += 1) {
      if ((x & 255) === 0) checkDeadline(deadline);
      const point: Point2 = [x + 0.5, y + 0.5];
      const signs = [cross2(points[0], points[1], point), cross2(points[1], points[2], point), cross2(points[2], points[0], point)];
      if (signs.every((value) => value >= 0) || signs.every((value) => value <= 0)) mask[y * width + x] = 1;
    }
  }
}

function close3x3(source: Uint8Array, width: number, height: number, deadline: number): Uint8Array {
  const dilated = new Uint8Array(source.length), result = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    checkDeadline(deadline);
    for (let x = 0; x < width; x += 1) {
      for (let dy = -1; dy <= 1 && dilated[y * width + x] === 0; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && source[ny * width + nx]) { dilated[y * width + x] = 1; break; }
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    checkDeadline(deadline);
    for (let x = 0; x < width; x += 1) {
      let occupied = true;
      for (let dy = -1; dy <= 1 && occupied; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !dilated[ny * width + nx]) { occupied = false; break; }
      }
      if (occupied) result[y * width + x] = 1;
    }
  }
  return result;
}

function exteriorZeroMask(mask: Uint8Array, width: number, height: number, deadline: number): Uint8Array {
  const exterior = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  const enqueue = (index: number) => { if (!mask[index] && !exterior[index]) { exterior[index] = 1; queue[tail++] = index; } };
  for (let x = 0; x < width; x += 1) { if ((x & 255) === 0) checkDeadline(deadline); enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y + 1 < height; y += 1) { if ((y & 255) === 0) checkDeadline(deadline); enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    if ((head & 255) === 0) checkDeadline(deadline);
    const current = queue[head++], x = current % width, y = Math.floor(current / width);
    if (x > 0) enqueue(current - 1); if (x + 1 < width) enqueue(current + 1);
    if (y > 0) enqueue(current - width); if (y + 1 < height) enqueue(current + width);
  }
  return exterior;
}

function fillHoles(mask: Uint8Array, exterior: Uint8Array, deadline: number): void {
  for (let index = 0; index < mask.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    if (!mask[index] && !exterior[index]) mask[index] = 1;
  }
}

function greatestComponent(mask: Uint8Array, width: number, height: number, deadline: number): { readonly mask: Uint8Array; readonly count: number; readonly components: number } {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let best: number[] = [], bestMinX = Infinity, bestMinY = Infinity, components = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if ((start & 255) === 0) checkDeadline(deadline);
    if (mask[start] && !visited[start]) {
      components += 1; let head = 0, tail = 0, minX = start % width, minY = Math.floor(start / width);
      const cells: number[] = []; visited[start] = 1; queue[tail++] = start;
      while (head < tail) {
        if ((head & 255) === 0) checkDeadline(deadline);
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
  }
  if (best.length === 0) throw new RangeError('Projected contour raster produced an empty mask');
  const selected = new Uint8Array(mask.length);
  for (let index = 0; index < best.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    selected[best[index]] = 1;
  }
  return { mask: selected, count: best.length, components };
}

type Edge = readonly [number, number];
function traceOuter(
  mask: Uint8Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cellSize: number,
  deadline: number,
  requireSingleBoundary: true,
): readonly Point2[] | undefined;
function traceOuter(
  mask: Uint8Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cellSize: number,
  deadline: number,
  requireSingleBoundary?: false,
): readonly Point2[];
function traceOuter(
  mask: Uint8Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cellSize: number,
  deadline: number,
  requireSingleBoundary?: boolean,
): readonly Point2[] | undefined {
  const vertexWidth = width + 1, edges: Edge[] = [];
  const key = (x: number, y: number) => y * vertexWidth + x;
  const empty = (x: number, y: number) => x < 0 || x >= width || y < 0 || y >= height || mask[y * width + x] === 0;
  for (let y = 0; y < height; y += 1) {
    checkDeadline(deadline);
    for (let x = 0; x < width; x += 1) if (mask[y * width + x]) {
      if (empty(x, y - 1)) edges.push([key(x + 1, y), key(x, y)]);
      if (empty(x + 1, y)) edges.push([key(x + 1, y + 1), key(x + 1, y)]);
      if (empty(x, y + 1)) edges.push([key(x, y + 1), key(x + 1, y + 1)]);
      if (empty(x - 1, y)) edges.push([key(x, y), key(x, y + 1)]);
    }
  }
  edges.sort((left, right) => { checkDeadline(deadline); return left[0] - right[0] || left[1] - right[1]; });
  const outgoing = new Map<number, number[]>();
  for (let index = 0; index < edges.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const [start, end] = edges[index];
    const values = outgoing.get(start);
    if (values) values.push(end); else outgoing.set(start, [end]);
  }
  for (const values of outgoing.values()) values.sort((left, right) => { checkDeadline(deadline); return left - right; });
  const unused = new Set<string>(), loops: number[][] = [];
  for (let index = 0; index < edges.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    unused.add(`${edges[index][0]}:${edges[index][1]}`);
  }
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if ((edgeIndex & 255) === 0) checkDeadline(deadline);
    const [edgeStart, edgeEnd] = edges[edgeIndex];
    if (!unused.has(`${edgeStart}:${edgeEnd}`)) continue;
    const loop = [edgeStart]; let start = edgeStart, end = edgeEnd;
    for (let guard = 0; guard <= edges.length; guard += 1) {
      if ((guard & 255) === 0) checkDeadline(deadline);
      unused.delete(`${start}:${end}`); loop.push(end);
      if (end === edgeStart) break;
      const candidates = (outgoing.get(end) ?? []).filter((candidate) => unused.has(`${end}:${candidate}`));
      const coordinates = (vertex: number): readonly [number, number] => [vertex % vertexWidth, Math.floor(vertex / vertexWidth)];
      const direction = (from: number, to: number): number => {
        const [fromX, fromY] = coordinates(from), [toX, toY] = coordinates(to);
        return toX > fromX ? 0 : toY > fromY ? 1 : toX < fromX ? 2 : 3;
      };
      const incomingDirection = direction(start, end), turnRank = [1, 2, 3, 0];
      candidates.sort((left, right) => { checkDeadline(deadline); return turnRank[(direction(end, left) - incomingDirection + 4) % 4]
        - turnRank[(direction(end, right) - incomingDirection + 4) % 4] || left - right; });
      const next = candidates[0];
      if (next === undefined) throw new RangeError('Projected contour boundary is open');
      start = end; end = next;
    }
    if (loop[loop.length - 1] !== edgeStart) throw new RangeError('Projected contour tracing exceeded its edge budget');
    loops.push(loop.slice(0, -1));
  }
  if (requireSingleBoundary && loops.length !== 1) return undefined;
  const candidates: { points: Point2[]; area: number; minX: number; minY: number }[] = [];
  for (let loopIndex = 0; loopIndex < loops.length; loopIndex += 1) {
    checkDeadline(deadline);
    const loop = loops[loopIndex], points: Point2[] = [];
    let twiceArea = 0, minX = Infinity, minY = Infinity;
    for (let index = 0; index < loop.length; index += 1) {
      if ((index & 255) === 0) checkDeadline(deadline);
      const vertex = loop[index], x = vertex % vertexWidth, y = Math.floor(vertex / vertexWidth);
      const point: Point2 = [originX + x * cellSize, originY + y * cellSize];
      points.push(point); minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    }
    for (let index = 0; index < points.length; index += 1) {
      if ((index & 255) === 0) checkDeadline(deadline);
      const point = points[index], next = points[(index + 1) % points.length];
      twiceArea += point[0] * next[1] - next[0] * point[1];
    }
    candidates.push({ points, area: Math.abs(twiceArea / 2), minX, minY });
  }
  candidates.sort((left, right) => { checkDeadline(deadline); return right.area - left.area || left.minX - right.minX || left.minY - right.minY; });
  const outer = candidates[0]?.points;
  if (!outer) throw new RangeError('Projected contour boundary is empty');
  return outer;
}

function enclosedVoidContours(
  preFillMask: Uint8Array,
  exteriorZeros: Uint8Array,
  retainedFilledMask: Uint8Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cellSize: number,
  deadline: number,
): RasterContour['enclosedVoids'] {
  checkDeadline(deadline);
  const visited = new Uint8Array(preFillMask.length);
  checkDeadline(deadline);
  const queue = new Int32Array(preFillMask.length);
  const candidates: {
    readonly cells: number[];
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  }[] = [];
  for (let start = 0; start < preFillMask.length; start += 1) {
    if ((start & 255) === 0) checkDeadline(deadline);
    if (preFillMask[start] || exteriorZeros[start] || visited[start] || !retainedFilledMask[start]) continue;
    let head = 0, tail = 0, minX = start % width, minY = Math.floor(start / width);
    let maxX = minX, maxY = minY, retained = true;
    const cells: number[] = [];
    visited[start] = 1; queue[tail++] = start;
    while (head < tail) {
      if ((head & 255) === 0) checkDeadline(deadline);
      const current = queue[head++], x = current % width, y = Math.floor(current / width);
      cells.push(current); minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      if (!retainedFilledMask[current]) retained = false;
      for (const next of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y + 1 < height ? current + width : -1,
      ]) if (next >= 0 && !preFillMask[next] && !exteriorZeros[next] && !visited[next]) {
        visited[next] = 1; queue[tail++] = next;
      }
    }
    if (!retained) continue;
    candidates.push({ cells, minX, minY, maxX, maxY });
  }
  candidates.sort((left, right) => { checkDeadline(deadline); return right.cells.length - left.cells.length
    || left.minX - right.minX || left.minY - right.minY; });
  const result: { readonly outer: readonly Point2[]; readonly occupiedCellCount: number }[] = [];
  for (let index = 0; index < Math.min(candidates.length, 64); index += 1) {
    checkDeadline(deadline);
    const candidate = candidates[index];
    const componentWidth = candidate.maxX - candidate.minX + 1;
    const componentHeight = candidate.maxY - candidate.minY + 1;
    checkDeadline(deadline);
    const componentMask = new Uint8Array(componentWidth * componentHeight);
    for (let cellIndex = 0; cellIndex < candidate.cells.length; cellIndex += 1) {
      if ((cellIndex & 255) === 0) checkDeadline(deadline);
      const cell = candidate.cells[cellIndex], x = cell % width, y = Math.floor(cell / width);
      componentMask[(y - candidate.minY) * componentWidth + x - candidate.minX] = 1;
    }
    const outer = traceOuter(
      componentMask,
      componentWidth,
      componentHeight,
      originX + candidate.minX * cellSize,
      originY + candidate.minY * cellSize,
      cellSize,
      deadline,
      true,
    );
    if (outer) result.push({ outer, occupiedCellCount: candidate.cells.length });
  }
  return result;
}

export function rasterCellSize(projected: ProjectedMesh): number {
  return Math.min(0.5, Math.max(0.05, projected.planarDiameter / 512));
}

function convexHull(points: readonly Point2[]): Point2[] {
  const sorted = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (values: readonly Point2[]) => {
    const result: Point2[] = [];
    for (const point of values) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)];
}

function selectedSourceEvidence(
  projected: ProjectedMesh, activeTriangles: readonly number[], selected: Uint8Array,
  width: number, height: number, originX: number, originY: number, cellSize: number,
): { readonly bounds: RasterContour['sourceBoundsMm']; readonly area: number } {
  const parent = activeTriangles.map((_, index) => index), vertexOwner = new Map<number, number>();
  const find = (value: number): number => parent[value] === value ? value : (parent[value] = find(parent[value]));
  const join = (left: number, right: number) => { const a = find(left), b = find(right); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  activeTriangles.forEach((triangleIndex, localIndex) => {
    for (const vertex of projected.triangles[triangleIndex]) {
      const owner = vertexOwner.get(vertex);
      if (owner === undefined) vertexOwner.set(vertex, localIndex); else join(localIndex, owner);
    }
  });
  const groups = new Map<number, Set<number>>();
  activeTriangles.forEach((triangleIndex, localIndex) => {
    const vertices = groups.get(find(localIndex)) ?? new Set<number>();
    for (const vertex of projected.triangles[triangleIndex]) vertices.add(vertex);
    groups.set(find(localIndex), vertices);
  });
  const candidates = [...groups.values()].map((vertices) => {
    const points = [...vertices].map((vertex): Point2 => {
      const [x, y] = projected.vertices[vertex];
      return [x, y];
    });
    let score = 0;
    for (const [x, y] of points) {
      const cellX = Math.floor((x - originX) / cellSize), cellY = Math.floor((y - originY) / cellSize);
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cellX + dx, ny = cellY + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && selected[ny * width + nx]) { touches = true; break; }
      }
      if (touches) score += 1;
    }
    const hull = convexHull(points);
    const area = Math.abs(hull.reduce((sum, point, index) => { const next = hull[(index + 1) % hull.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0) / 2);
    return { points, score, area };
  }).sort((a, b) => b.score - a.score || b.area - a.area);
  const sourcePoints = candidates.filter(({ score }) => score > 0).flatMap(({ points }) => points);
  const hull = convexHull(sourcePoints);
  const area = Math.abs(hull.reduce((sum, point, index) => { const next = hull[(index + 1) % hull.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0) / 2);
  if (sourcePoints.length === 0 || area <= 0) throw new RangeError('Projected contour cannot identify retained source component');
  const xs = sourcePoints.map(([x]) => x), ys = sourcePoints.map(([, y]) => y);
  return { bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }, area };
}

export function rasterProjectLayer(
  projected: ProjectedMesh,
  spec: OutlineLayerSpec,
  budgets: OutlineBudgets,
  deadline: number,
): RasterContour {
  checkDeadline(deadline);
  if (![spec.zStart, spec.zEnd, spec.zMid].every(Number.isFinite) || spec.zEnd <= spec.zStart
    || spec.zMid < spec.zStart || spec.zMid > spec.zEnd) {
    throw new RangeError('Projected contour requires a finite interval containing its midpoint');
  }
  const cellSize = rasterCellSize(projected), originX = projected.minX - cellSize, originY = projected.minY - cellSize;
  const width = Math.ceil((projected.maxX - projected.minX) / cellSize) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / cellSize) + 3;
  if (width > budgets.maxRasterWidth || height > budgets.maxRasterHeight) throw new RangeError('Projected contour exceeds the raster dimension budget');
  if (width * height > budgets.maxRasterCellsTotal) throw new RangeError('Projected contour exceeds the total raster cell budget');
  const mask = new Uint8Array(width * height);
  const activeTriangles: number[] = [];
  for (let index = 0; index < projected.triangles.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const triangle = projected.triangles[index], vertices = triangle.map((vertex) => projected.vertices[vertex]);
    const minZ = Math.min(...vertices.map(([, , z]) => z)), maxZ = Math.max(...vertices.map(([, , z]) => z));
    if (maxZ < spec.zStart || minZ > spec.zEnd) continue;
    activeTriangles.push(index);
    rasterizeTriangle(mask, width, height, vertices.map(([x, y]) => [(x - originX) / cellSize, (y - originY) / cellSize] as const), deadline);
  }
  const closed = close3x3(mask, width, height, deadline);
  const exteriorZeros = exteriorZeroMask(closed, width, height, deadline);
  checkDeadline(deadline);
  const filled = closed.slice();
  checkDeadline(deadline);
  fillHoles(filled, exteriorZeros, deadline);
  const selected = greatestComponent(filled, width, height, deadline);
  const source = selectedSourceEvidence(projected, activeTriangles, selected.mask, width, height, originX, originY, cellSize);
  return {
    outer: traceOuter(selected.mask, width, height, originX, originY, cellSize, deadline),
    occupiedCellCount: selected.count,
    componentCount: selected.components,
    enclosedVoids: enclosedVoidContours(
      closed, exteriorZeros, selected.mask, width, height, originX, originY, cellSize, deadline,
    ),
    sourceBoundsMm: source.bounds,
    sourceAreaMm2: source.area,
  };
}
