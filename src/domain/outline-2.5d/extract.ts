import type { Point2 } from '../decomposition/types';
import type { TriangleMesh } from '../mesh/types';
import { projectMesh, rasterCellSize, rasterProjectLayer, type ProjectedMesh } from './raster';
import { contourBounds, signedArea, simplifyClosedLoop } from './simplify';
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
};
export type OutlineExtraction = {
  readonly layers: readonly OutlineLayer[];
  readonly cellSizeMm?: number;
  readonly removedComponentCount: number;
};

function validateRequest(projected: ProjectedMesh, specs: readonly OutlineLayerSpec[], budgets: OutlineBudgets): void {
  if (specs.length === 0 || specs.length > budgets.maxLayers) throw new RangeError('Contour extraction requires layers within budget');
  if (projected.triangles.length * specs.length > budgets.maxTriangleLayerTests) {
    throw new RangeError('Contour extraction exceeds the triangle-layer test budget');
  }
  if (!Number.isFinite(budgets.maxRuntimeMs) || budgets.maxRuntimeMs <= 0 || budgets.maxContourPointsPerLayer > 4096) {
    throw new RangeError('Contour extraction requires valid fail-closed budgets');
  }
}

function withinDrift(source: readonly Point2[], simplified: readonly Point2[]): boolean {
  const sourceBounds = contourBounds(source), simplifiedBounds = contourBounds(simplified);
  const sourceWidth = sourceBounds.maxX - sourceBounds.minX, sourceHeight = sourceBounds.maxY - sourceBounds.minY;
  const ratios = [
    Math.abs(simplifiedBounds.minX - sourceBounds.minX) / Math.max(sourceWidth, Number.EPSILON),
    Math.abs(simplifiedBounds.maxX - sourceBounds.maxX) / Math.max(sourceWidth, Number.EPSILON),
    Math.abs(simplifiedBounds.minY - sourceBounds.minY) / Math.max(sourceHeight, Number.EPSILON),
    Math.abs(simplifiedBounds.maxY - sourceBounds.maxY) / Math.max(sourceHeight, Number.EPSILON),
  ];
  return ratios.every((ratio) => ratio <= 0.03 + 1e-12);
}

function makeLayer(spec: OutlineLayerSpec, source: readonly Point2[], tolerance: number, budgets: OutlineBudgets): OutlineLayer {
  const sourceAreaMm2 = Math.abs(signedArea(source));
  let currentTolerance = tolerance;
  let simplified = simplifyClosedLoop(source, currentTolerance, budgets.maxContourPointsPerLayer);
  let simplifiedAreaMm2 = Math.abs(signedArea(simplified));
  for (let attempt = 0; attempt < 16 && (!withinDrift(source, simplified)
    || Math.abs(simplifiedAreaMm2 - sourceAreaMm2) / sourceAreaMm2 > 0.03); attempt += 1) {
    currentTolerance /= 2;
    simplified = simplifyClosedLoop(source, currentTolerance, budgets.maxContourPointsPerLayer);
    simplifiedAreaMm2 = Math.abs(signedArea(simplified));
  }
  if (!withinDrift(source, simplified)) throw new RangeError('Simplified contour bounds drift exceeds three percent');
  const layer: OutlineLayer = {
    id: `outline-layer-${spec.index}`,
    index: spec.index,
    zStart: spec.zStart,
    zEnd: spec.zEnd,
    contour: { outer: simplified, holes: [] },
    sourceAreaMm2,
    simplifiedAreaMm2,
  };
  const validation = validateOutlineLayer(layer);
  if (!validation.ok) throw new RangeError(`Invalid outline layer: ${validation.reasons.join('; ')}`);
  return layer;
}

export function extractProjectedContours(
  mesh: TriangleMesh,
  selection: OutlineAxisSelection,
  specs: readonly OutlineLayerSpec[],
  budgets: OutlineBudgets,
): OutlineExtraction {
  const started = Date.now(), deadline = started + budgets.maxRuntimeMs;
  const projected = projectMesh(mesh, selection); validateRequest(projected, specs, budgets);
  const cellSizeMm = rasterCellSize(projected);
  const width = Math.ceil((projected.maxX - projected.minX) / cellSizeMm) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / cellSizeMm) + 3;
  if (width * height * specs.length > budgets.maxRasterCellsTotal) throw new RangeError('Projected contour exceeds the total raster cell budget');
  let removedComponentCount = 0;
  const tolerance = Math.max(cellSizeMm * 1.5, projected.planarDiameter * 0.001);
  const layers = specs.map((spec) => {
    const raster = rasterProjectLayer(projected, spec, budgets, deadline);
    removedComponentCount += raster.componentCount - 1;
    return makeLayer(spec, raster.outer, tolerance, budgets);
  });
  return { layers, cellSizeMm, removedComponentCount };
}

type Segment = readonly [Point2, Point2];
function sliceSegments(projected: ProjectedMesh, z: number, deadline: number): readonly Segment[] {
  const epsilon = Math.max(1e-9, projected.planarDiameter * 1e-10), segments: Segment[] = [];
  for (let triangleIndex = 0; triangleIndex < projected.triangles.length; triangleIndex += 1) {
    if ((triangleIndex & 1023) === 0 && Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
    const triangle = projected.triangles[triangleIndex];
    const vertices = triangle.map((index) => projected.vertices[index]);
    const distances = vertices.map((vertex) => vertex[2] - z);
    if (distances.every((value) => value > epsilon) || distances.every((value) => value < -epsilon)) continue;
    if (distances.every((value) => Math.abs(value) <= epsilon)) throw new RangeError('Exact contour intersects a coplanar triangle');
    const intersections: Point2[] = [];
    for (let edge = 0; edge < 3; edge += 1) {
      const a = vertices[edge], b = vertices[(edge + 1) % 3], da = distances[edge], db = distances[(edge + 1) % 3];
      if (Math.abs(da) <= epsilon) intersections.push([a[0], a[1]]);
      if ((da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon)) {
        const t = da / (da - db); intersections.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    const unique = intersections.filter((point, index) => intersections.findIndex((other) => Math.hypot(point[0] - other[0], point[1] - other[1]) <= epsilon) === index);
    if (unique.length === 2 && Math.hypot(unique[0][0] - unique[1][0], unique[0][1] - unique[1][1]) > epsilon) segments.push([unique[0], unique[1]]);
    else if (unique.length !== 0) throw new RangeError('Exact contour triangle intersection is ambiguous');
  }
  return segments;
}

function exactLoops(segments: readonly Segment[], diameter: number): readonly (readonly Point2[])[] {
  if (segments.length === 0) throw new RangeError('Exact contour has an empty segment graph');
  const quantum = Math.max(1e-9, diameter * 1e-9);
  const key = ([x, y]: Point2) => `${Math.round(x / quantum)},${Math.round(y / quantum)}`;
  const points = new Map<string, Point2>(), adjacency = new Map<string, string[]>();
  const retainCanonicalPoint = (pointKey: string, candidate: Point2) => {
    const current = points.get(pointKey);
    if (!current || candidate[0] < current[0] || (candidate[0] === current[0] && candidate[1] < current[1])) {
      points.set(pointKey, candidate);
    }
  };
  for (const [a, b] of segments) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    retainCanonicalPoint(ka, a); retainCanonicalPoint(kb, b);
    adjacency.set(ka, [...(adjacency.get(ka) ?? []), kb]); adjacency.set(kb, [...(adjacency.get(kb) ?? []), ka]);
  }
  if (adjacency.size === 0 || [...adjacency.values()].some((neighbors) => neighbors.length !== 2 || neighbors[0] === neighbors[1])) {
    throw new RangeError('Exact contour segment graph is open or non-manifold');
  }
  for (const neighbors of adjacency.values()) neighbors.sort();
  const visited = new Set<string>(), loops: Point2[][] = [];
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const loop: Point2[] = []; let previous: string | undefined, current = start;
    for (let guard = 0; guard <= adjacency.size; guard += 1) {
      if (visited.has(current) && current !== start) throw new RangeError('Exact contour segment graph overlaps');
      if (current === start && loop.length > 0) break;
      visited.add(current); loop.push(points.get(current)!);
      const neighbors = adjacency.get(current)!;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      previous = current; current = next;
    }
    if (current !== start || loop.length < 3) throw new RangeError('Exact contour segment graph is open');
    loops.push(loop);
  }
  return loops;
}

function minimumCoordinates(points: readonly Point2[]): readonly [number, number] {
  return [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y))];
}

export function extractExactContours(
  mesh: TriangleMesh,
  selection: OutlineAxisSelection,
  specs: readonly OutlineLayerSpec[],
  budgets: OutlineBudgets,
): OutlineExtraction {
  const deadline = Date.now() + budgets.maxRuntimeMs, projected = projectMesh(mesh, selection);
  validateRequest(projected, specs, budgets);
  let removedComponentCount = 0;
  const tolerance = Math.max(rasterCellSize(projected) * 1.5, projected.planarDiameter * 0.001);
  const layers = specs.map((spec) => {
    if (Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
    const loops = [...exactLoops(sliceSegments(projected, spec.zMid, deadline), projected.planarDiameter)];
    loops.sort((left, right) => {
      const areaDifference = Math.abs(signedArea(right)) - Math.abs(signedArea(left));
      if (areaDifference !== 0) return areaDifference;
      const [leftX, leftY] = minimumCoordinates(left), [rightX, rightY] = minimumCoordinates(right);
      return leftX - rightX || leftY - rightY;
    });
    removedComponentCount += loops.length - 1;
    return makeLayer(spec, loops[0], tolerance, budgets);
  });
  return { layers, removedComponentCount };
}
