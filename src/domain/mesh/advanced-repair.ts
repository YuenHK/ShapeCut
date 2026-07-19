import type { Vec3 } from '../types';
import { meshNumerics, signedTetrahedronVolume } from './numerics';
import { analyzeMeshProblems } from './problem-report';
import { compareMeshes, meshRepairBlockingReasons } from './repair-mesh';
import type { MeshProblemReport, MeshRepairChanges, MeshRepairResult, TriangleMesh } from './types';

const MAX_TRIANGLES = 500_000;
const MAX_TRIANGLE_GROWTH = 1.1;
const WELD_RELATIVE_TOLERANCE = 1e-7;
const MAX_HOLE_PERIMETER_RELATIVE = 0.02;
const MAX_HOLE_VERTICES = 12;

type EdgeUse = {
  readonly face: number;
  readonly from: number;
  readonly to: number;
};

type EdgeIncidence = {
  readonly a: number;
  readonly b: number;
  readonly uses: EdgeUse[];
};

type MeshData = {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
};

type SplitResult = MeshData & {
  readonly splitVertices: number;
  readonly blockingReason?: string;
};

export function repairMeshAdvanced(original: TriangleMesh, safeMesh: TriangleMesh): MeshRepairResult {
  const before = analyzeMeshProblems(safeMesh);
  const triangleLimit = Math.min(original.indices.length / 3 * MAX_TRIANGLE_GROWTH, MAX_TRIANGLES);
  assertTriangleLimit(safeMesh.indices.length / 3, triangleLimit);

  const filtered = removeExactCoincidentFaces(safeMesh);
  const split = splitIndependentSurfaceFans(safeMesh, filtered.indices);
  const baseChanges: MeshRepairChanges = {
    removedDegenerate: 0,
    removedDuplicate: filtered.removedDuplicate,
    weldedVertices: 0,
    splitVertices: split.splitVertices,
    filledHoles: 0,
  };

  if (split.blockingReason) {
    return buildResult(original, before, compactMesh(split), baseChanges, [split.blockingReason]);
  }

  const boundary = findBoundaryLoops(split.indices);
  if (boundary.blockingReason) {
    return buildResult(original, before, compactMesh(split), baseChanges, [boundary.blockingReason]);
  }

  let filledHoles = 0;
  let indices = [...split.indices];
  const holeReasons: string[] = [];
  if (boundary.loops.length > 1) {
    holeReasons.push('只能自動補合單一邊界環');
  } else if (boundary.loops.length === 1) {
    const loop = orientLoopForCap(boundary.loops[0], boundary.edges);
    if (!loop) {
      holeReasons.push('缺口邊界方向不一致，無法安全補合');
    } else {
      const validationReason = validateHole(original, safeMesh, split.positions, loop);
      if (validationReason) {
        holeReasons.push(validationReason);
      } else {
        const predictedTriangleCount = indices.length / 3 + loop.length - 2;
        assertTriangleLimit(predictedTriangleCount, triangleLimit);
        const cap = triangulatePlanarLoop(split.positions, loop);
        if (cap === undefined) holeReasons.push('缺口無法安全三角剖分');
        else {
          indices.push(...cap);
          filledHoles = 1;
        }
      }
    }
  }

  const mesh = compactMesh({ positions: split.positions, indices });
  orientClosedShells(mesh);
  return buildResult(
    original,
    before,
    mesh,
    { ...baseChanges, filledHoles },
    holeReasons,
  );
}

function removeExactCoincidentFaces(mesh: TriangleMesh): {
  readonly indices: readonly number[];
  readonly removedDuplicate: number;
} {
  const seen = new Set<string>();
  const indices: number[] = [];
  let removedDuplicate = 0;
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const face = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]] as const;
    const key = face.map((vertex) => positionKey(mesh.positions, vertex)).sort().join('|');
    if (seen.has(key)) {
      removedDuplicate += 1;
      continue;
    }
    seen.add(key);
    indices.push(...face);
  }
  return { indices, removedDuplicate };
}

function splitIndependentSurfaceFans(mesh: TriangleMesh, sourceIndices: readonly number[]): SplitResult {
  const edges = edgeIncidences(sourceIndices);
  const nonManifoldEdges = [...edges.values()].filter((edge) => edge.uses.length > 2);
  if (nonManifoldEdges.length === 0) {
    return { positions: Array.from(mesh.positions), indices: [...sourceIndices], splitVertices: 0 };
  }

  const componentByFace = faceComponents(sourceIndices.length / 3, edges);
  for (const edge of nonManifoldEdges) {
    const facesByComponent = new Map<number, number>();
    for (const use of edge.uses) {
      const component = componentByFace[use.face];
      facesByComponent.set(component, (facesByComponent.get(component) ?? 0) + 1);
    }
    if ([...facesByComponent.values()].some((count) => count > 2)) {
      return {
        positions: Array.from(mesh.positions),
        indices: [...sourceIndices],
        splitVertices: 0,
        blockingReason: '非流形面扇無法在限制內安全拆分',
      };
    }
  }

  const componentsBySplitVertex = new Map<number, Set<number>>();
  for (const edge of nonManifoldEdges) {
    for (const vertex of [edge.a, edge.b]) {
      let components = componentsBySplitVertex.get(vertex);
      if (!components) {
        components = new Set<number>();
        componentsBySplitVertex.set(vertex, components);
      }
      for (const use of edge.uses) components.add(componentByFace[use.face]);
    }
  }

  const primaryComponentByVertex = new Map<number, number>();
  for (const [vertex, components] of componentsBySplitVertex) {
    primaryComponentByVertex.set(vertex, Math.min(...components));
  }

  const positions = Array.from(mesh.positions);
  const duplicateByVertexComponent = new Map<string, number>();
  const indices = [...sourceIndices];
  let splitVertices = 0;
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const component = componentByFace[offset / 3];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[offset + corner];
      const primaryComponent = primaryComponentByVertex.get(vertex);
      if (primaryComponent === undefined || component === primaryComponent) continue;
      const key = `${vertex}:${component}`;
      let duplicate = duplicateByVertexComponent.get(key);
      if (duplicate === undefined) {
        duplicate = positions.length / 3;
        const sourceOffset = vertex * 3;
        positions.push(
          mesh.positions[sourceOffset],
          mesh.positions[sourceOffset + 1],
          mesh.positions[sourceOffset + 2],
        );
        duplicateByVertexComponent.set(key, duplicate);
        splitVertices += 1;
      }
      indices[offset + corner] = duplicate;
    }
  }

  if ([...edgeIncidences(indices).values()].some((edge) => edge.uses.length > 2)) {
    return {
      positions: Array.from(mesh.positions),
      indices: [...sourceIndices],
      splitVertices: 0,
      blockingReason: '非流形面扇無法在限制內安全拆分',
    };
  }
  return { positions, indices, splitVertices };
}

function faceComponents(faceCount: number, edges: ReadonlyMap<string, EdgeIncidence>): number[] {
  const adjacency = Array.from({ length: faceCount }, () => [] as number[]);
  for (const edge of edges.values()) {
    if (edge.uses.length !== 2) continue;
    const first = edge.uses[0].face;
    const second = edge.uses[1].face;
    adjacency[first].push(second);
    adjacency[second].push(first);
  }
  const componentByFace = new Array<number>(faceCount).fill(-1);
  let component = 0;
  for (let face = 0; face < faceCount; face += 1) {
    if (componentByFace[face] !== -1) continue;
    const pending = [face];
    componentByFace[face] = component;
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const neighbor of adjacency[current]) {
        if (componentByFace[neighbor] !== -1) continue;
        componentByFace[neighbor] = component;
        pending.push(neighbor);
      }
    }
    component += 1;
  }
  return componentByFace;
}

function findBoundaryLoops(indices: readonly number[]): {
  readonly loops: readonly (readonly number[])[];
  readonly edges: ReadonlyMap<string, EdgeIncidence>;
  readonly blockingReason?: string;
} {
  const edges = edgeIncidences(indices);
  const boundaryEdges = [...edges.values()].filter((edge) => edge.uses.length === 1);
  if (boundaryEdges.length === 0) return { loops: [], edges };

  const incidentEdges = new Map<number, EdgeIncidence[]>();
  for (const edge of boundaryEdges) {
    addIncidentBoundaryEdge(incidentEdges, edge.a, edge);
    addIncidentBoundaryEdge(incidentEdges, edge.b, edge);
  }
  if ([...incidentEdges.values()].some((incident) => incident.length !== 2)) {
    return { loops: [], edges, blockingReason: '邊界無法形成可安全補合的封閉環' };
  }

  const unused = new Set(boundaryEdges.map((edge) => edgeKey(edge.a, edge.b)));
  const loops: number[][] = [];
  while (unused.size > 0) {
    const seed = [...unused]
      .map((key) => edges.get(key)!)
      .sort((left, right) => left.a - right.a || left.b - right.b)[0];
    const start = seed.a;
    let previous = start;
    let current = seed.b;
    const loop = [start];
    unused.delete(edgeKey(previous, current));
    while (current !== start) {
      if (loop.includes(current)) {
        return { loops: [], edges, blockingReason: '邊界無法形成可安全補合的封閉環' };
      }
      loop.push(current);
      const nextEdges = incidentEdges.get(current)!;
      const nextEdge = nextEdges.find((edge) => {
        const next = edge.a === current ? edge.b : edge.a;
        return next !== previous && unused.has(edgeKey(current, next));
      });
      if (!nextEdge) {
        return { loops: [], edges, blockingReason: '邊界無法形成可安全補合的封閉環' };
      }
      const next = nextEdge.a === current ? nextEdge.b : nextEdge.a;
      unused.delete(edgeKey(current, next));
      previous = current;
      current = next;
    }
    loops.push(loop);
  }
  return { loops, edges };
}

function addIncidentBoundaryEdge(
  incidentEdges: Map<number, EdgeIncidence[]>,
  vertex: number,
  edge: EdgeIncidence,
): void {
  const incident = incidentEdges.get(vertex);
  if (incident) incident.push(edge);
  else incidentEdges.set(vertex, [edge]);
}

function orientLoopForCap(
  loop: readonly number[],
  edges: ReadonlyMap<string, EdgeIncidence>,
): readonly number[] | undefined {
  let sameDirection = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const from = loop[index];
    const to = loop[(index + 1) % loop.length];
    const boundaryUse = edges.get(edgeKey(from, to))!.uses[0];
    if (boundaryUse.from === from && boundaryUse.to === to) sameDirection += 1;
  }
  if (sameDirection !== 0 && sameDirection !== loop.length) return undefined;
  return sameDirection === loop.length ? [loop[0], ...loop.slice(1).reverse()] : loop;
}

function validateHole(
  original: TriangleMesh,
  safeMesh: TriangleMesh,
  positions: readonly number[],
  loop: readonly number[],
): string | undefined {
  if (loop.length > MAX_HOLE_VERTICES) return '缺口頂點超出自動補合上限';
  if (loop.length < 3) return '邊界無法形成可安全補合的封閉環';

  let perimeter = 0;
  for (let index = 0; index < loop.length; index += 1) {
    perimeter += pointDistance(positions, loop[index], loop[(index + 1) % loop.length]);
  }
  const maxPerimeter = longestReferencedBoundingEdge(original) * MAX_HOLE_PERIMETER_RELATIVE;
  if (perimeter > maxPerimeter + numericTolerance(perimeter, maxPerimeter)) {
    return '缺口超出自動補合上限';
  }

  const plane = loopPlane(positions, loop);
  if (!plane) return '缺口不是可安全補合的平面';
  const planarityTolerance = longestReferencedBoundingEdge(safeMesh) * WELD_RELATIVE_TOLERANCE;
  for (const vertex of loop) {
    const point = pointAt(positions, vertex);
    const distance = Math.abs(dot(subtract(point, plane.origin), plane.normal));
    if (distance > planarityTolerance + numericTolerance(distance, planarityTolerance)) {
      return '缺口不是可安全補合的平面';
    }
  }
  const dropAxis = dominantAxis(plane.normal);
  const projected = projectLoopLocally(positions, loop, dropAxis);
  if (polygonHasSelfIntersection(projected)) return '缺口邊界自相交，無法安全補合';
  return undefined;
}

function triangulatePlanarLoop(positions: readonly number[], loop: readonly number[]): number[] | undefined {
  const plane = loopPlane(positions, loop);
  if (!plane) return undefined;
  const dropAxis = dominantAxis(plane.normal);
  const projected = projectLoopLocally(positions, loop, dropAxis);
  const area = signedArea(projected);
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const epsilon = Math.max(Number.MIN_VALUE, 128 * Number.EPSILON * extent ** 2);
  if (Math.abs(area) <= epsilon) return undefined;
  const orientation = Math.sign(area);
  const remaining = loop.map((_, index) => index);
  const triangles: number[] = [];
  let attempts = 0;
  while (remaining.length > 3 && attempts <= loop.length ** 2) {
    let clipped = false;
    for (let currentIndex = 0; currentIndex < remaining.length; currentIndex += 1) {
      const previous = remaining[(currentIndex - 1 + remaining.length) % remaining.length];
      const current = remaining[currentIndex];
      const next = remaining[(currentIndex + 1) % remaining.length];
      if (cross2(projected[previous], projected[current], projected[next]) * orientation <= epsilon) continue;
      if (remaining.some((candidate) => (
        candidate !== previous
        && candidate !== current
        && candidate !== next
        && pointInTriangle(projected[candidate], projected[previous], projected[current], projected[next], orientation, epsilon)
      ))) continue;
      triangles.push(loop[previous], loop[current], loop[next]);
      remaining.splice(currentIndex, 1);
      clipped = true;
      break;
    }
    if (!clipped) return undefined;
    attempts += 1;
  }
  if (remaining.length !== 3) return undefined;
  triangles.push(loop[remaining[0]], loop[remaining[1]], loop[remaining[2]]);
  return triangles;
}

function orientClosedShells(mesh: TriangleMesh): void {
  const edges = edgeIncidences(mesh.indices);
  const components = faceComponents(mesh.indices.length / 3, edges);
  const facesByComponent = new Map<number, number[]>();
  components.forEach((component, face) => {
    const faces = facesByComponent.get(component);
    if (faces) faces.push(face);
    else facesByComponent.set(component, [face]);
  });
  const { reference, volumeTolerance } = meshNumerics(mesh);
  for (const faces of facesByComponent.values()) {
    const closed = faces.every((face) => {
      const offset = face * 3;
      const a = mesh.indices[offset];
      const b = mesh.indices[offset + 1];
      const c = mesh.indices[offset + 2];
      return [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]
        .every((key) => edges.get(key)?.uses.length === 2);
    });
    if (!closed) continue;
    let signedVolume = 0;
    for (const face of faces) {
      const offset = face * 3;
      const a = pointAt(mesh.positions, mesh.indices[offset]);
      const b = pointAt(mesh.positions, mesh.indices[offset + 1]);
      const c = pointAt(mesh.positions, mesh.indices[offset + 2]);
      signedVolume += signedTetrahedronVolume(
        a[0] - reference[0], a[1] - reference[1], a[2] - reference[2],
        b[0] - reference[0], b[1] - reference[1], b[2] - reference[2],
        c[0] - reference[0], c[1] - reference[1], c[2] - reference[2],
      );
    }
    if (signedVolume < -volumeTolerance) {
      for (const face of faces) {
        const offset = face * 3;
        const second = mesh.indices[offset + 1];
        mesh.indices[offset + 1] = mesh.indices[offset + 2];
        mesh.indices[offset + 2] = second;
      }
    }
  }
}

function buildResult(
  original: TriangleMesh,
  before: MeshProblemReport,
  mesh: TriangleMesh,
  changes: MeshRepairChanges,
  specificReasons: readonly string[],
): MeshRepairResult {
  const after = analyzeMeshProblems(mesh);
  const comparison = compareMeshes(original, mesh);
  const blockingReasons = [...new Set([
    ...specificReasons,
    ...meshRepairBlockingReasons(after, comparison),
  ])];
  return {
    mode: 'advanced',
    mesh,
    before,
    after,
    changes,
    comparison,
    accepted: blockingReasons.length === 0,
    blockingReasons,
  };
}

function compactMesh(data: MeshData): TriangleMesh {
  const compactBySource = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (const source of data.indices) {
    let compact = compactBySource.get(source);
    if (compact === undefined) {
      compact = compactBySource.size;
      compactBySource.set(source, compact);
      const offset = source * 3;
      positions.push(data.positions[offset], data.positions[offset + 1], data.positions[offset + 2]);
    }
    indices.push(compact);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function edgeIncidences(indices: ArrayLike<number>): Map<string, EdgeIncidence> {
  const edges = new Map<string, EdgeIncidence>();
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const face = offset / 3;
    addEdgeUse(edges, indices[offset], indices[offset + 1], face);
    addEdgeUse(edges, indices[offset + 1], indices[offset + 2], face);
    addEdgeUse(edges, indices[offset + 2], indices[offset], face);
  }
  return edges;
}

function addEdgeUse(edges: Map<string, EdgeIncidence>, from: number, to: number, face: number): void {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const key = edgeKey(a, b);
  const edge = edges.get(key);
  if (edge) edge.uses.push({ face, from, to });
  else edges.set(key, { a, b, uses: [{ face, from, to }] });
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function positionKey(positions: ArrayLike<number>, vertex: number): string {
  const offset = vertex * 3;
  return `${canonical(positions[offset])}:${canonical(positions[offset + 1])}:${canonical(positions[offset + 2])}`;
}

function canonical(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function longestReferencedBoundingEdge(mesh: TriangleMesh): number {
  const referenced = new Set(mesh.indices);
  if (referenced.size === 0) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of referenced) {
    const offset = vertex * 3;
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
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

function loopPlane(
  positions: readonly number[],
  loop: readonly number[],
): { readonly origin: Vec3; readonly normal: Vec3 } | undefined {
  const anchor = pointAt(positions, loop[0]);
  let originX = anchor[0];
  let originY = anchor[1];
  let originZ = anchor[2];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const current = subtract(pointAt(positions, loop[index]), anchor);
    const next = subtract(pointAt(positions, loop[(index + 1) % loop.length]), anchor);
    originX += current[0] / loop.length;
    originY += current[1] / loop.length;
    originZ += current[2] / loop.length;
    nx += current[1] * next[2] - current[2] * next[1];
    ny += current[2] * next[0] - current[0] * next[2];
    nz += current[0] * next[1] - current[1] * next[0];
  }
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0) || !Number.isFinite(length)) return undefined;
  return { origin: [originX, originY, originZ], normal: [nx / length, ny / length, nz / length] };
}

function pointDistance(positions: readonly number[], first: number, second: number): number {
  const a = pointAt(positions, first);
  const b = pointAt(positions, second);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function pointAt(positions: ArrayLike<number>, vertex: number): Vec3 {
  const offset = vertex * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function dominantAxis(normal: Vec3): 0 | 1 | 2 {
  const absolute: Vec3 = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  if (absolute[0] >= absolute[1] && absolute[0] >= absolute[2]) return 0;
  return absolute[1] >= absolute[2] ? 1 : 2;
}

function project(point: Vec3, dropAxis: 0 | 1 | 2): readonly [number, number] {
  if (dropAxis === 0) return [point[1], point[2]];
  if (dropAxis === 1) return [point[0], point[2]];
  return [point[0], point[1]];
}

function projectLoopLocally(
  positions: readonly number[],
  loop: readonly number[],
  dropAxis: 0 | 1 | 2,
): readonly (readonly [number, number])[] {
  const projected = loop.map((vertex) => project(pointAt(positions, vertex), dropAxis));
  const origin = projected[0];
  return projected.map((point) => [point[0] - origin[0], point[1] - origin[1]]);
}

function signedArea(points: readonly (readonly [number, number])[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
}

function cross2(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(
  point: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  orientation: number,
  epsilon: number,
): boolean {
  return cross2(a, b, point) * orientation >= -epsilon
    && cross2(b, c, point) * orientation >= -epsilon
    && cross2(c, a, point) * orientation >= -epsilon;
}

function polygonHasSelfIntersection(points: readonly (readonly [number, number])[]): boolean {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const coordinateEpsilon = Math.max(Number.MIN_VALUE, 128 * Number.EPSILON * extent);
  const areaEpsilon = Math.max(Number.MIN_VALUE, coordinateEpsilon * extent);
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(
        points[first],
        points[firstNext],
        points[second],
        points[secondNext],
        coordinateEpsilon,
        areaEpsilon,
      )) {
        return true;
      }
    }
  }
  return false;
}

function segmentsIntersect(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
  coordinateEpsilon: number,
  areaEpsilon: number,
): boolean {
  const abc = cross2(a, b, c);
  const abd = cross2(a, b, d);
  const cda = cross2(c, d, a);
  const cdb = cross2(c, d, b);
  if (((abc > areaEpsilon && abd < -areaEpsilon) || (abc < -areaEpsilon && abd > areaEpsilon))
    && ((cda > areaEpsilon && cdb < -areaEpsilon) || (cda < -areaEpsilon && cdb > areaEpsilon))) {
    return true;
  }
  return (Math.abs(abc) <= areaEpsilon && pointOnSegment(c, a, b, coordinateEpsilon))
    || (Math.abs(abd) <= areaEpsilon && pointOnSegment(d, a, b, coordinateEpsilon))
    || (Math.abs(cda) <= areaEpsilon && pointOnSegment(a, c, d, coordinateEpsilon))
    || (Math.abs(cdb) <= areaEpsilon && pointOnSegment(b, c, d, coordinateEpsilon));
}

function pointOnSegment(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
  epsilon: number,
): boolean {
  return point[0] >= Math.min(start[0], end[0]) - epsilon
    && point[0] <= Math.max(start[0], end[0]) + epsilon
    && point[1] >= Math.min(start[1], end[1]) - epsilon
    && point[1] <= Math.max(start[1], end[1]) + epsilon;
}

function numericTolerance(...values: number[]): number {
  return 64 * Number.EPSILON * Math.max(1, ...values.map(Math.abs));
}

function assertTriangleLimit(triangleCount: number, triangleLimit: number): void {
  if (triangleCount > triangleLimit + numericTolerance(triangleCount, triangleLimit)) {
    throw new RangeError('Advanced repair triangle limit exceeded.');
  }
}
