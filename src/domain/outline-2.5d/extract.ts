import type { Point2 } from '../decomposition/types';
import type { TriangleMesh } from '../mesh/types';
import { projectMesh, rasterCellSize, rasterProjectLayer, type ProjectedMesh } from './raster';
import { contourBounds, signedArea, simplifyClosedLoop, type Bounds2 } from './simplify';
import type { OutlineAxisSelection, OutlineBudgets, OutlineLayerSpec } from './types';
import { validateOutlineLayer } from './validate';

export type OutlineLayer = {
  readonly id: string;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly contour: { readonly outer: readonly Point2[]; readonly holes: readonly [] };
  readonly sourceAreaMm2: number;
  readonly simplifiedAreaMm2: number;
  readonly sourceBoundsMm: Bounds2;
  readonly simplificationToleranceMm: number;
  readonly boundsDriftRatio: number;
  readonly areaDriftRatio: number;
  readonly removedComponentCount: number;
};
export type OutlineExtraction = {
  readonly layers: readonly OutlineLayer[];
  readonly cellSizeMm?: number;
  readonly removedComponentCount: number;
};

/** Exact slice topology is ambiguous, so projected extraction may be attempted. */
export class ExactContourAmbiguityError extends RangeError {}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
}

function validateBudgets(budgets: OutlineBudgets): void {
  if (!Number.isFinite(budgets.maxRuntimeMs) || budgets.maxRuntimeMs <= 0
    || !Number.isInteger(budgets.maxContourPointsPerLayer) || budgets.maxContourPointsPerLayer < 3
    || budgets.maxContourPointsPerLayer > 4096) {
    throw new RangeError('Contour extraction requires valid fail-closed budgets');
  }
}

function validateRequest(projected: ProjectedMesh, specs: readonly OutlineLayerSpec[], budgets: OutlineBudgets, deadline: number): void {
  checkDeadline(deadline);
  if (specs.length === 0 || specs.length > budgets.maxLayers) throw new RangeError('Contour extraction requires layers within budget');
  if (projected.triangles.length * specs.length > budgets.maxTriangleLayerTests) {
    throw new RangeError('Contour extraction exceeds the triangle-layer test budget');
  }
  for (let index = 0; index < specs.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const spec = specs[index];
    if (![spec.zStart, spec.zMid, spec.zEnd].every(Number.isFinite) || spec.zEnd <= spec.zStart
      || spec.zMid < spec.zStart || spec.zMid > spec.zEnd) {
      throw new RangeError('Contour extraction requires each finite layer interval to contain its midpoint');
    }
  }
}

function withinDrift(sourceBounds: Bounds2, simplified: readonly Point2[], deadline: number): boolean {
  return boundsDriftRatio(sourceBounds, simplified, deadline) <= 0.03 + 1e-12;
}

export function outlineBoundsDriftMetrics(source: Bounds2, output: Bounds2): { readonly direct: number; readonly legacyEdge: number } {
  const width = source.maxX - source.minX, height = source.maxY - source.minY;
  return {
    direct: Math.max(Math.abs((output.maxX - output.minX) - width) / width, Math.abs((output.maxY - output.minY) - height) / height),
    legacyEdge: Math.max(
      Math.abs(output.minX - source.minX) / width, Math.abs(output.maxX - source.maxX) / width,
      Math.abs(output.minY - source.minY) / height, Math.abs(output.maxY - source.maxY) / height,
    ),
  };
}

function boundsDriftRatio(sourceBounds: Bounds2, simplified: readonly Point2[], deadline: number): number {
  const result = contourBounds(simplified, deadline);
  return outlineBoundsDriftMetrics(sourceBounds, result).direct;
}

function makeLayer(
  spec: OutlineLayerSpec,
  source: readonly Point2[],
  tolerance: number,
  budgets: OutlineBudgets,
  deadline: number,
  removedComponentCount: number,
  sourceEvidence?: Readonly<{ bounds: Bounds2; area: number }>,
): OutlineLayer {
  checkDeadline(deadline);
  const sourceAreaMm2 = sourceEvidence?.area ?? Math.abs(signedArea(source, deadline));
  const sourceBoundsMm = sourceEvidence?.bounds ?? contourBounds(source, deadline);
  let currentTolerance = tolerance;
  let simplified = simplifyClosedLoop(source, currentTolerance, budgets.maxContourPointsPerLayer, deadline);
  let simplifiedAreaMm2 = Math.abs(signedArea(simplified, deadline));
  for (let attempt = 0; attempt < 16 && (!withinDrift(sourceBoundsMm, simplified, deadline)
    || Math.abs(simplifiedAreaMm2 - sourceAreaMm2) / sourceAreaMm2 > 0.03); attempt += 1) {
    checkDeadline(deadline);
    currentTolerance /= 2;
    simplified = simplifyClosedLoop(source, currentTolerance, budgets.maxContourPointsPerLayer, deadline);
    simplifiedAreaMm2 = Math.abs(signedArea(simplified, deadline));
  }
  if (!withinDrift(sourceBoundsMm, simplified, deadline)) throw new RangeError('Simplified contour bounds drift exceeds three percent');
  const finalAreaDrift = Math.abs(simplifiedAreaMm2 - sourceAreaMm2) / sourceAreaMm2;
  if (finalAreaDrift > 0.03 + 1e-12) throw new RangeError(`Projected component area drift exceeds three percent (${finalAreaDrift})`);
  const layer: OutlineLayer = {
    id: `outline-layer-${spec.index}`,
    index: spec.index,
    zStart: spec.zStart,
    zEnd: spec.zEnd,
    contour: { outer: simplified, holes: [] },
    sourceAreaMm2,
    simplifiedAreaMm2,
    sourceBoundsMm,
    simplificationToleranceMm: currentTolerance,
    boundsDriftRatio: boundsDriftRatio(sourceBoundsMm, simplified, deadline),
    areaDriftRatio: finalAreaDrift,
    removedComponentCount,
  };
  const validation = validateOutlineLayer(layer, deadline);
  if (!validation.ok) throw new RangeError(`Invalid outline layer: ${validation.reasons.join('; ')}`);
  return layer;
}

export function extractProjectedContours(
  mesh: TriangleMesh,
  selection: OutlineAxisSelection,
  specs: readonly OutlineLayerSpec[],
  budgets: OutlineBudgets,
  deadline = Date.now() + budgets.maxRuntimeMs,
): OutlineExtraction {
  validateBudgets(budgets);
  const projected = projectMesh(mesh, selection, deadline); validateRequest(projected, specs, budgets, deadline);
  const cellSizeMm = rasterCellSize(projected);
  const width = Math.ceil((projected.maxX - projected.minX) / cellSizeMm) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / cellSizeMm) + 3;
  if (width * height * specs.length > budgets.maxRasterCellsTotal) throw new RangeError('Projected contour exceeds the total raster cell budget');
  let removedComponentCount = 0;
  const tolerance = Math.max(cellSizeMm * 1.5, projected.planarDiameter * 0.001);
  const layers: OutlineLayer[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    checkDeadline(deadline);
    const spec = specs[index];
    const raster = rasterProjectLayer(projected, spec, budgets, deadline);
    removedComponentCount += raster.componentCount - 1;
    layers.push(makeLayer(spec, raster.outer, tolerance, budgets, deadline, raster.componentCount - 1, {
      bounds: raster.sourceBoundsMm, area: Math.abs(signedArea(raster.outer, deadline)),
    }));
  }
  return { layers, cellSizeMm, removedComponentCount };
}

type Segment = readonly [Point2, Point2];
type PlaneEdge = { readonly segment: Segment; readonly side: -1 | 1 };

function sliceSegments(projected: ProjectedMesh, z: number, deadline: number): readonly Segment[] {
  const epsilon = Math.max(1e-9, projected.planarDiameter * 1e-10), segments: Segment[] = [];
  const planeEdges = new Map<string, PlaneEdge[]>();
  const pointKey = ([x, y]: Point2): string => `${Math.round(x / epsilon)},${Math.round(y / epsilon)}`;
  const segmentKey = ([a, b]: Segment): string => {
    const ka = pointKey(a), kb = pointKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (let triangleIndex = 0; triangleIndex < projected.triangles.length; triangleIndex += 1) {
    if ((triangleIndex & 255) === 0) checkDeadline(deadline);
    const triangle = projected.triangles[triangleIndex];
    const vertices = triangle.map((index) => projected.vertices[index]);
    const distances = vertices.map((vertex) => vertex[2] - z);
    if (distances.every((value) => value > epsilon) || distances.every((value) => value < -epsilon)) continue;
    const onPlane = distances.map((distance, index) => Math.abs(distance) <= epsilon ? index : -1).filter((index) => index >= 0);
    if (onPlane.length === 3) throw new ExactContourAmbiguityError('Exact contour intersects a coplanar triangle');
    if (onPlane.length === 2) {
      const offPlane = [0, 1, 2].find((index) => !onPlane.includes(index))!;
      const segment: Segment = [
        [vertices[onPlane[0]][0], vertices[onPlane[0]][1]],
        [vertices[onPlane[1]][0], vertices[onPlane[1]][1]],
      ];
      const key = segmentKey(segment), values = planeEdges.get(key) ?? [];
      values.push({ segment, side: distances[offPlane] > 0 ? 1 : -1 });
      planeEdges.set(key, values);
      continue;
    }
    if (onPlane.length === 1) {
      const vertexIndex = onPlane[0], others = [0, 1, 2].filter((index) => index !== vertexIndex);
      if (distances[others[0]] * distances[others[1]] >= 0) continue;
      const a = vertices[others[0]], b = vertices[others[1]], da = distances[others[0]], db = distances[others[1]];
      const t = da / (da - db);
      segments.push([
        [vertices[vertexIndex][0], vertices[vertexIndex][1]],
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      ]);
      continue;
    }
    const intersections: Point2[] = [];
    for (let edge = 0; edge < 3; edge += 1) {
      const a = vertices[edge], b = vertices[(edge + 1) % 3], da = distances[edge], db = distances[(edge + 1) % 3];
      if ((da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon)) {
        const t = da / (da - db);
        intersections.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if (intersections.length !== 2
      || Math.hypot(intersections[0][0] - intersections[1][0], intersections[0][1] - intersections[1][1]) <= epsilon) {
      throw new ExactContourAmbiguityError('Exact contour triangle intersection is ambiguous');
    }
    segments.push([intersections[0], intersections[1]]);
  }
  let edgeGroupIndex = 0;
  for (const values of planeEdges.values()) {
    if ((edgeGroupIndex++ & 255) === 0) checkDeadline(deadline);
    if (values.length !== 2 || values[0].side === values[1].side) {
      throw new ExactContourAmbiguityError('Exact contour shared plane edge is ambiguous');
    }
    segments.push(values[0].segment);
  }
  return segments;
}

function exactLoops(segments: readonly Segment[], diameter: number, deadline: number): readonly (readonly Point2[])[] {
  checkDeadline(deadline);
  if (segments.length === 0) throw new ExactContourAmbiguityError('Exact contour has an empty segment graph');
  const quantum = Math.max(1e-9, diameter * 1e-9);
  const key = ([x, y]: Point2) => `${Math.round(x / quantum)},${Math.round(y / quantum)}`;
  const points = new Map<string, Point2>(), adjacency = new Map<string, string[]>();
  const retainCanonicalPoint = (pointKey: string, candidate: Point2) => {
    const current = points.get(pointKey);
    if (!current || candidate[0] < current[0] || (candidate[0] === current[0] && candidate[1] < current[1])) {
      points.set(pointKey, candidate);
    }
  };
  const uniqueEdges = new Set<string>();
  for (let index = 0; index < segments.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const [a, b] = segments[index];
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (uniqueEdges.has(edgeKey)) throw new ExactContourAmbiguityError('Exact contour segment graph overlaps');
    uniqueEdges.add(edgeKey);
    retainCanonicalPoint(ka, a); retainCanonicalPoint(kb, b);
    const aNeighbors = adjacency.get(ka), bNeighbors = adjacency.get(kb);
    if (aNeighbors) aNeighbors.push(kb); else adjacency.set(ka, [kb]);
    if (bNeighbors) bNeighbors.push(ka); else adjacency.set(kb, [ka]);
  }
  if (adjacency.size === 0) throw new ExactContourAmbiguityError('Exact contour segment graph is open or non-manifold');
  for (const neighbors of adjacency.values()) {
    checkDeadline(deadline);
    if (neighbors.length !== 2 || neighbors[0] === neighbors[1]) {
      throw new ExactContourAmbiguityError('Exact contour segment graph is open or non-manifold');
    }
    neighbors.sort((left, right) => { checkDeadline(deadline); return left.localeCompare(right); });
  }
  const visited = new Set<string>(), loops: Point2[][] = [];
  const starts = [...adjacency.keys()];
  starts.sort((left, right) => { checkDeadline(deadline); return left.localeCompare(right); });
  for (let startIndex = 0; startIndex < starts.length; startIndex += 1) {
    if ((startIndex & 255) === 0) checkDeadline(deadline);
    const start = starts[startIndex];
    if (visited.has(start)) continue;
    const loop: Point2[] = []; let previous: string | undefined, current = start;
    for (let guard = 0; guard <= adjacency.size; guard += 1) {
      if ((guard & 255) === 0) checkDeadline(deadline);
      if (visited.has(current) && current !== start) {
        throw new ExactContourAmbiguityError('Exact contour segment graph overlaps');
      }
      if (current === start && loop.length > 0) break;
      visited.add(current); loop.push(points.get(current)!);
      const neighbors = adjacency.get(current)!;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      previous = current; current = next;
    }
    if (current !== start || loop.length < 3) {
      throw new ExactContourAmbiguityError('Exact contour segment graph is open');
    }
    loops.push(loop);
  }
  return loops;
}

function minimumCoordinates(points: readonly Point2[], deadline: number): readonly [number, number] {
  let minX = Infinity, minY = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    minX = Math.min(minX, points[index][0]); minY = Math.min(minY, points[index][1]);
  }
  return [minX, minY];
}

export function extractExactContours(
  mesh: TriangleMesh,
  selection: OutlineAxisSelection,
  specs: readonly OutlineLayerSpec[],
  budgets: OutlineBudgets,
  deadline = Date.now() + budgets.maxRuntimeMs,
): OutlineExtraction {
  validateBudgets(budgets);
  const projected = projectMesh(mesh, selection, deadline);
  validateRequest(projected, specs, budgets, deadline);
  const tolerance = Math.max(rasterCellSize(projected) * 1.5, projected.planarDiameter * 0.001);
  const layers: OutlineLayer[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    checkDeadline(deadline);
    const spec = specs[index];
    const loops = exactLoops(sliceSegments(projected, spec.zMid, deadline), projected.planarDiameter, deadline);
    if (loops.length !== 1) {
      throw new ExactContourAmbiguityError('Exact contour has multiple closed loops');
    }
    const candidates = loops.map((points) => ({
      points,
      area: Math.abs(signedArea(points, deadline)),
      minimum: minimumCoordinates(points, deadline),
    }));
    candidates.sort((left, right) => { checkDeadline(deadline); return right.area - left.area
      || left.minimum[0] - right.minimum[0] || left.minimum[1] - right.minimum[1]; });
    layers.push(makeLayer(spec, candidates[0].points, tolerance, budgets, deadline, 0));
  }
  return { layers, removedComponentCount: 0 };
}
