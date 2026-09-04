import type { Point2 } from '../decomposition/types';
import type { ProjectedMesh } from './raster';
import type { OutlineLayerSpec } from './types';
import {
  SLICE_STATUS_GEOMETRY_EVIDENCE,
  type SliceBatchResult,
} from '../../wasm/slice-kernel-contract';
import {
  isSliceWorkerPoolFallbackEligible,
  SliceWorkerPool,
  type SliceWorkerPoolRequest,
} from '../../workers/slice-worker-pool';

export type ExactSegment = readonly [Point2, Point2];
export type ExactSegmentDiagnostics = Readonly<{
  degenerateTriangleCount: number;
  coplanarTrianglePlaneCount: number;
  ambiguousIntersectionCount: number;
  onPlaneEdgeCount: number;
}>;
export type ExactSegmentLayer = Readonly<{
  planeIndex: number;
  z: number;
  segments: readonly ExactSegment[];
}>;
export type ExactSegmentCollection = Readonly<{
  origin: 'typescript' | 'typescript-fallback' | 'wasm';
  layers: readonly ExactSegmentLayer[];
  diagnostics: ExactSegmentDiagnostics;
}>;

export interface ExactSegmentSource {
  collect(
    mesh: ProjectedMesh,
    specs: readonly OutlineLayerSpec[],
    deadline: number,
    checkpoint: () => void,
  ): Promise<ExactSegmentCollection>;
}

export type ExactSegmentSourceErrorCode =
  | 'INVALID_REQUEST'
  | 'PROTOCOL_ERROR'
  | 'CANCELLED'
  | 'DEADLINE_EXCEEDED'
  | 'DIFFERENTIAL_MISMATCH';

export class ExactSegmentSourceError extends Error {
  readonly name = 'ExactSegmentSourceError';
  readonly fallbackEligible = false;

  constructor(readonly code: ExactSegmentSourceErrorCode, message: string) {
    super(message);
    Object.freeze(this);
  }
}

export class ExactContourAmbiguityError extends RangeError {}

export interface ExactSegmentBatchRunner {
  run(request: SliceWorkerPoolRequest): Promise<SliceBatchResult>;
  isFallbackEligible(error: unknown): boolean;
  readonly activeWorkerCount?: number;
  cancel?(): Promise<void>;
}

export interface WasmExactSegmentSourceOptions {
  readonly runner?: ExactSegmentBatchRunner;
  readonly compareWithTypeScript?: boolean;
  readonly minimumWasmWork?: number;
  readonly onPublication?: (collection: ExactSegmentCollection, generation: number) => void;
}

const DEFAULT_MINIMUM_WASM_WORK = 4_096;

type PlaneEdge = { readonly segment: ExactSegment; readonly side: -1 | 1 };

function checkRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) {
    throw new ExactSegmentSourceError('DEADLINE_EXCEEDED', 'Exact segment collection exceeded the runtime budget');
  }
}

function normalizePoint([x, y]: Point2): Point2 {
  return [Math.abs(x) <= 1e-12 ? 0 : x, Math.abs(y) <= 1e-12 ? 0 : y];
}

function canonicalSegment(segment: ExactSegment): ExactSegment {
  const first = normalizePoint(segment[0]), second = normalizePoint(segment[1]);
  return comparePoint(first, second) <= 0
    ? Object.freeze([Object.freeze([...first]) as Point2, Object.freeze([...second]) as Point2])
    : Object.freeze([Object.freeze([...second]) as Point2, Object.freeze([...first]) as Point2]);
}

function comparePoint(left: Point2, right: Point2): number {
  return left[0] - right[0] || left[1] - right[1];
}

function compareSegment(left: ExactSegment, right: ExactSegment): number {
  return comparePoint(left[0], right[0]) || comparePoint(left[1], right[1]);
}

function canonicalSegments(segments: readonly ExactSegment[]): readonly ExactSegment[] {
  return Object.freeze(segments.map(canonicalSegment).sort(compareSegment));
}

function immutableSegments(segments: readonly ExactSegment[]): readonly ExactSegment[] {
  return Object.freeze(segments.map(([first, second]) => Object.freeze([
    Object.freeze(normalizePoint(first)),
    Object.freeze(normalizePoint(second)),
  ]) as ExactSegment));
}

function typeScriptSegments(
  projected: ProjectedMesh,
  z: number,
  deadline: number,
  checkpoint: () => void,
): { readonly segments: readonly ExactSegment[]; readonly onPlaneEdgeCount: number } {
  const edgeKeyTolerance = Math.max(1e-9, projected.planarDiameter * 1e-10);
  const segments: ExactSegment[] = [];
  const planeEdges = new Map<string, PlaneEdge[]>();
  let onPlaneEdgeCount = 0;
  const pointKey = ([x, y]: Point2): string => (
    `${Math.round(x / edgeKeyTolerance)},${Math.round(y / edgeKeyTolerance)}`
  );
  const segmentKey = ([a, b]: ExactSegment): string => {
    const ka = pointKey(a), kb = pointKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (let triangleIndex = 0; triangleIndex < projected.triangles.length; triangleIndex += 1) {
    if ((triangleIndex & 255) === 0) checkRuntime(deadline, checkpoint);
    const triangle = projected.triangles[triangleIndex];
    const vertices = triangle.map((index) => projected.vertices[index]);
    const epsilon = planeTolerance(vertices, z);
    const distances = vertices.map((vertex) => vertex[2] - z);
    if (distances.every((value) => value > epsilon) || distances.every((value) => value < -epsilon)) continue;
    const onPlane = distances.map((distance, index) => Math.abs(distance) <= epsilon ? index : -1)
      .filter((index) => index >= 0);
    if (onPlane.length === 3) throw new ExactContourAmbiguityError('Exact contour intersects a coplanar triangle');
    if (onPlane.length === 2) {
      const offPlane = [0, 1, 2].find((index) => !onPlane.includes(index))!;
      const segment: ExactSegment = [
        [vertices[onPlane[0]][0], vertices[onPlane[0]][1]],
        [vertices[onPlane[1]][0], vertices[onPlane[1]][1]],
      ];
      const key = segmentKey(segment), values = planeEdges.get(key) ?? [];
      values.push({ segment, side: distances[offPlane] > 0 ? 1 : -1 });
      planeEdges.set(key, values);
      onPlaneEdgeCount += 1;
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
      || Math.hypot(intersections[0][0] - intersections[1][0], intersections[0][1] - intersections[1][1])
        <= planarTolerance(vertices)) {
      throw new ExactContourAmbiguityError('Exact contour triangle intersection is ambiguous');
    }
    segments.push([intersections[0], intersections[1]]);
  }
  let edgeGroupIndex = 0;
  for (const values of planeEdges.values()) {
    if ((edgeGroupIndex++ & 255) === 0) checkRuntime(deadline, checkpoint);
    if (values.length !== 2 || values[0].side === values[1].side) {
      throw new ExactContourAmbiguityError('Exact contour shared plane edge is ambiguous');
    }
    segments.push(values[0].segment);
  }
  return { segments: immutableSegments(segments), onPlaneEdgeCount };
}

function planeTolerance(vertices: readonly (readonly [number, number, number])[], plane: number): number {
  const axialMagnitude = vertices.reduce(
    (scale, vertex) => Math.max(scale, Math.abs(vertex[2])),
    Math.max(1, Math.abs(plane)),
  );
  return Math.max(1e-9, axialMagnitude * 64 * Number.EPSILON);
}

function planarTolerance(vertices: readonly (readonly [number, number, number])[]): number {
  const edgeLength = (first: typeof vertices[number], second: typeof vertices[number]) => Math.hypot(
    second[0] - first[0], second[1] - first[1],
  );
  const planarEdgeScale = Math.max(
    edgeLength(vertices[0], vertices[1]),
    edgeLength(vertices[1], vertices[2]),
    edgeLength(vertices[2], vertices[0]),
  );
  return Math.max(1e-9, planarEdgeScale * 64 * Number.EPSILON);
}

export function collectTypeScriptExactSegments(
  mesh: ProjectedMesh,
  specs: readonly OutlineLayerSpec[],
  deadline: number,
  checkpoint: () => void,
  origin: ExactSegmentCollection['origin'] = 'typescript',
): ExactSegmentCollection {
  let onPlaneEdgeCount = 0;
  const degenerateTriangleCount = countDegenerateTriangles(mesh, deadline, checkpoint);
  const layers = specs.map((spec, planeIndex): ExactSegmentLayer => {
    const collected = typeScriptSegments(mesh, spec.zMid, deadline, checkpoint);
    onPlaneEdgeCount += collected.onPlaneEdgeCount;
    return Object.freeze({ planeIndex, z: spec.zMid, segments: collected.segments });
  });
  return Object.freeze({
    origin,
    layers: Object.freeze(layers),
    diagnostics: Object.freeze({
      degenerateTriangleCount,
      coplanarTrianglePlaneCount: 0,
      ambiguousIntersectionCount: 0,
      onPlaneEdgeCount,
    }),
  });
}

function countDegenerateTriangles(
  mesh: ProjectedMesh,
  deadline: number,
  checkpoint: () => void,
): number {
  let count = 0;
  for (let index = 0; index < mesh.triangles.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    const [first, second, third] = mesh.triangles[index].map((vertex) => mesh.vertices[vertex]);
    const ab = [second[0] - first[0], second[1] - first[1], second[2] - first[2]] as const;
    const ac = [third[0] - first[0], third[1] - first[1], third[2] - first[2]] as const;
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ] as const;
    const edgeLength = (left: typeof first, right: typeof first) => Math.hypot(
      right[0] - left[0], right[1] - left[1], right[2] - left[2],
    );
    const localEdgeScale = Math.max(
      edgeLength(first, second), edgeLength(second, third), edgeLength(third, first),
    );
    const areaTolerance = Math.max(
      Number.MIN_VALUE,
      localEdgeScale * localEdgeScale * 64 * Number.EPSILON,
    );
    if (Math.hypot(...cross) <= areaTolerance) count += 1;
  }
  return count;
}

export class TypeScriptExactSegmentSource implements ExactSegmentSource {
  collect(
    mesh: ProjectedMesh,
    specs: readonly OutlineLayerSpec[],
    deadline: number,
    checkpoint: () => void,
  ): Promise<ExactSegmentCollection> {
    try {
      return Promise.resolve(collectTypeScriptExactSegments(mesh, specs, deadline, checkpoint));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

class WorkerPoolBatchRunner implements ExactSegmentBatchRunner {
  readonly #pool = new SliceWorkerPool();
  get activeWorkerCount(): number { return this.#pool.activeWorkerCount; }
  run(request: SliceWorkerPoolRequest): Promise<SliceBatchResult> { return this.#pool.run(request); }
  isFallbackEligible(error: unknown): boolean { return isSliceWorkerPoolFallbackEligible(error); }
  cancel(): Promise<void> { return this.#pool.cancel(); }
}

export class WasmExactSegmentSource implements ExactSegmentSource {
  readonly #runner: ExactSegmentBatchRunner;
  readonly #compareWithTypeScript: boolean;
  readonly #minimumWasmWork: number;
  readonly #onPublication: ((collection: ExactSegmentCollection, generation: number) => void) | undefined;
  #generation = 0;

  constructor(options: WasmExactSegmentSourceOptions = {}) {
    const minimumWasmWork = options.minimumWasmWork ?? DEFAULT_MINIMUM_WASM_WORK;
    if (!Number.isSafeInteger(minimumWasmWork) || minimumWasmWork < 0) {
      throw new TypeError('minimum WASM work must be a non-negative safe integer');
    }
    this.#runner = options.runner ?? new WorkerPoolBatchRunner();
    this.#compareWithTypeScript = options.compareWithTypeScript ?? false;
    this.#minimumWasmWork = minimumWasmWork;
    this.#onPublication = options.onPublication;
  }

  get activeWorkerCount(): number { return this.#runner.activeWorkerCount ?? 0; }
  get generation(): number { return this.#generation; }

  async cancel(): Promise<void> {
    this.#generation += 1;
    await this.#runner.cancel?.();
  }

  async collect(
    mesh: ProjectedMesh,
    specs: readonly OutlineLayerSpec[],
    deadline: number,
    checkpoint: () => void,
  ): Promise<ExactSegmentCollection> {
    checkRuntime(deadline, checkpoint);
    const generation = ++this.#generation;
    const work = mesh.triangles.length * specs.length;
    if (Number.isSafeInteger(work) && work < this.#minimumWasmWork) {
      await this.#runner.cancel?.();
      if (generation !== this.#generation) {
        throw new ExactSegmentSourceError('CANCELLED', 'Exact segment collection was cancelled');
      }
      return collectTypeScriptExactSegments(mesh, specs, deadline, checkpoint);
    }
    if (!hasSufficientFloat32Precision(mesh, deadline, checkpoint)) {
      await this.#runner.cancel?.();
      if (generation !== this.#generation) {
        throw new ExactSegmentSourceError('CANCELLED', 'Exact segment collection was cancelled');
      }
      return collectTypeScriptExactSegments(mesh, specs, deadline, checkpoint);
    }
    const wasmMesh = float32ProjectedMesh(mesh, deadline, checkpoint);
    let result: SliceBatchResult;
    try {
      const workerDeadline = deadline === Number.POSITIVE_INFINITY
        ? Number.MAX_SAFE_INTEGER
        : deadline;
      result = await this.#runner.run({
        positions: Float32Array.from(wasmMesh.vertices.flat()),
        indices: Uint32Array.from(wasmMesh.triangles.flat()),
        planes: Float64Array.from(specs, ({ zMid }) => zMid),
        deadlineCheckInterval: 4_096,
        deadlineAt: workerDeadline,
      });
    } catch (error) {
      if (generation !== this.#generation) {
        throw new ExactSegmentSourceError('CANCELLED', 'Exact segment collection was cancelled');
      }
      if (!this.#runner.isFallbackEligible(error)) throw error;
      const fallback = collectTypeScriptExactSegments(mesh, specs, deadline, checkpoint, 'typescript-fallback');
      if (generation !== this.#generation) {
        throw new ExactSegmentSourceError('CANCELLED', 'Exact segment collection was cancelled');
      }
      return fallback;
    }
    if (generation !== this.#generation) {
      throw new ExactSegmentSourceError('CANCELLED', 'Exact segment collection was cancelled');
    }

    // Publication starts only after the complete worker batch has passed this validation.
    const collection = decodeWasmCollection(result, specs, deadline, checkpoint);
    if (this.#compareWithTypeScript || result.statusCode === SLICE_STATUS_GEOMETRY_EVIDENCE) {
      const oracle = collectTypeScriptExactSegments(mesh, specs, deadline, checkpoint);
      try {
        compareCollections(canonicalizeCollection(oracle), collection, deadline, checkpoint);
      } catch (error) {
        if (error instanceof ExactSegmentSourceError && error.code === 'DIFFERENTIAL_MISMATCH') {
          return oracle;
        }
        throw error;
      }
    }
    if (generation !== this.#generation) {
      throw new ExactSegmentSourceError('CANCELLED', 'Exact segment collection was cancelled');
    }
    this.#onPublication?.(collection, generation);
    return collection;
  }
}

function canonicalizeCollection(collection: ExactSegmentCollection): ExactSegmentCollection {
  return Object.freeze({
    ...collection,
    layers: Object.freeze(collection.layers.map((layer) => Object.freeze({
      ...layer,
      segments: canonicalSegments(layer.segments),
    }))),
  });
}

function hasSufficientFloat32Precision(
  mesh: ProjectedMesh,
  deadline: number,
  checkpoint: () => void,
): boolean {
  const tolerance = Math.max(1e-5, mesh.planarDiameter * 1e-9);
  for (let index = 0; index < mesh.vertices.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    if (mesh.vertices[index].some((coordinate) => (
      Math.abs(coordinate - Math.fround(coordinate)) > tolerance
    ))) return false;
  }
  return true;
}

function float32ProjectedMesh(
  mesh: ProjectedMesh,
  deadline: number,
  checkpoint: () => void,
): ProjectedMesh {
  const vertices = mesh.vertices.map((vertex, index) => {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    return [Math.fround(vertex[0]), Math.fround(vertex[1]), Math.fround(vertex[2])] as const;
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < vertices.length; index += 1) {
    if ((index & 255) === 0) checkRuntime(deadline, checkpoint);
    const [x, y] = vertices[index];
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return Object.freeze({
    vertices: Object.freeze(vertices),
    triangles: mesh.triangles,
    minX,
    minY,
    maxX,
    maxY,
    planarDiameter: Math.hypot(maxX - minX, maxY - minY),
  });
}

function decodeWasmCollection(
  result: SliceBatchResult,
  specs: readonly OutlineLayerSpec[],
  deadline: number,
  checkpoint: () => void,
): ExactSegmentCollection {
  try {
    const offsets = [...result.planeOffsets];
    const endpoints = [...result.endpoints];
    const counters = [...result.diagnosticCounters];
    if (offsets.length !== specs.length + 1 || offsets[0] !== 0
      || offsets.at(-1)! * 4 !== endpoints.length || counters.length !== 9
      || counters.some((value) => !Number.isSafeInteger(value) || value < 0)
      || endpoints.some((value) => !Number.isFinite(value))) {
      throw new TypeError('invalid WASM segment batch');
    }
    const hasOnPlaneEvidence = counters[7] > 0;
    const layers = specs.map((spec, planeIndex): ExactSegmentLayer => {
      checkRuntime(deadline, checkpoint);
      const start = offsets[planeIndex], end = offsets[planeIndex + 1];
      if (start > end || end * 4 > endpoints.length) throw new TypeError('invalid WASM plane offsets');
      const segments: ExactSegment[] = [];
      for (let segmentIndex = start; segmentIndex < end; segmentIndex += 1) {
        if ((segmentIndex & 255) === 0) checkRuntime(deadline, checkpoint);
        const offset = segmentIndex * 4;
        segments.push([
          [endpoints[offset], endpoints[offset + 1]],
          [endpoints[offset + 2], endpoints[offset + 3]],
        ]);
      }
      const canonical = canonicalSegments(segments);
      return Object.freeze({
        planeIndex,
        z: spec.zMid,
        segments: hasOnPlaneEvidence ? collapsePairedPlaneEdges(canonical) : canonical,
      });
    });
    return Object.freeze({
      origin: 'wasm',
      layers: Object.freeze(layers),
      diagnostics: Object.freeze({
        degenerateTriangleCount: counters[0],
        coplanarTrianglePlaneCount: counters[1],
        ambiguousIntersectionCount: counters[6],
        onPlaneEdgeCount: counters[7],
      }),
    });
  } catch (error) {
    if (error instanceof ExactSegmentSourceError) throw error;
    throw new ExactSegmentSourceError('PROTOCOL_ERROR', 'WASM exact segment publication was rejected');
  }
}

function collapsePairedPlaneEdges(segments: readonly ExactSegment[]): readonly ExactSegment[] {
  const collapsed: ExactSegment[] = [];
  for (let index = 0; index < segments.length;) {
    let end = index + 1;
    while (end < segments.length && compareSegment(segments[index], segments[end]) === 0) end += 1;
    const count = end - index;
    if (count === 1) collapsed.push(segments[index]);
    else if (count === 2) collapsed.push(segments[index]);
    else throw new ExactSegmentSourceError('PROTOCOL_ERROR', 'WASM shared plane edge multiplicity was rejected');
    index = end;
  }
  return Object.freeze(collapsed);
}

function compareCollections(
  oracle: ExactSegmentCollection,
  candidate: ExactSegmentCollection,
  deadline: number,
  checkpoint: () => void,
): void {
  if (oracle.layers.length !== candidate.layers.length
    || oracle.diagnostics.degenerateTriangleCount !== candidate.diagnostics.degenerateTriangleCount
    || oracle.diagnostics.onPlaneEdgeCount !== candidate.diagnostics.onPlaneEdgeCount
    || oracle.diagnostics.coplanarTrianglePlaneCount !== candidate.diagnostics.coplanarTrianglePlaneCount
    || oracle.diagnostics.ambiguousIntersectionCount !== candidate.diagnostics.ambiguousIntersectionCount) {
    throw new ExactSegmentSourceError('DIFFERENTIAL_MISMATCH', 'WASM exact segment diagnostics differ from TypeScript');
  }
  for (let layerIndex = 0; layerIndex < oracle.layers.length; layerIndex += 1) {
    checkRuntime(deadline, checkpoint);
    const expected = oracle.layers[layerIndex], actual = candidate.layers[layerIndex];
    if (expected.planeIndex !== actual.planeIndex || expected.z !== actual.z
      || expected.segments.length !== actual.segments.length) {
      throw new ExactSegmentSourceError('DIFFERENTIAL_MISMATCH', 'WASM exact segment topology differs from TypeScript');
    }
    for (let segmentIndex = 0; segmentIndex < expected.segments.length; segmentIndex += 1) {
      if ((segmentIndex & 255) === 0) checkRuntime(deadline, checkpoint);
      const expectedValues = expected.segments[segmentIndex].flat();
      const actualValues = actual.segments[segmentIndex].flat();
      if (expectedValues.some((value, index) => !Object.is(value, actualValues[index]))) {
        throw new ExactSegmentSourceError('DIFFERENTIAL_MISMATCH', 'WASM exact segment coordinates differ from TypeScript');
      }
    }
  }
}
