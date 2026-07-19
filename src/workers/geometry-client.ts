import { releaseProxy, transfer, wrap } from 'comlink';
import type { AxisCandidate } from '../domain/axis/find-axis';
import type { SpinnerKit } from '../domain/decomposition/types';
import type { EngravingMap } from '../domain/engraving/height-field';
import type { MeshRepairResult } from '../domain/mesh/types';
import type { STLRepairMode } from '../domain/mesh/write-stl';
import type {
  DecompositionRequest,
  EngravingRequest,
  GeometryApi,
  ImportAnalysis,
  ImportRepairAnalysis,
  MeshAnalysis,
  SerializedMesh,
} from './geometry-api';

export class SupersededError extends Error {
  readonly name = 'SupersededError';
  readonly code = 'SUPERSEDED';

  constructor(readonly jobId: number) {
    super(`Geometry job ${jobId} was superseded`);
  }
}

type ActiveJob = {
  readonly id: number;
  readonly reject: (error: SupersededError) => void;
};

export type GeometryClientOptions = {
  readonly transferInput?: (input: ArrayBuffer) => ArrayBuffer;
  readonly transferMesh?: (mesh: SerializedMesh) => SerializedMesh;
  readonly release?: () => void;
};

export type GeometryClient = {
  readonly latestJobId: number;
  analyze(input: ArrayBuffer): Promise<MeshAnalysis>;
  analyzeForImport(input: ArrayBuffer): Promise<ImportAnalysis>;
  analyzeAndRepairForImport(input: ArrayBuffer): Promise<ImportRepairAnalysis>;
  repairAdvanced(original: SerializedMesh, safeMesh: SerializedMesh): Promise<MeshRepairResult>;
  serializeSTL(mesh: SerializedMesh, mode: STLRepairMode): Promise<ArrayBuffer>;
  findAxes(mesh: SerializedMesh): Promise<AxisCandidate[]>;
  decompose(request: DecompositionRequest): Promise<SpinnerKit>;
  engrave(request: EngravingRequest): Promise<EngravingMap>;
  cancelActive(): void;
  dispose(): void;
};

export function makeGeometryClient(api: GeometryApi, options: GeometryClientOptions = {}): GeometryClient {
  let latestJobId = 0;
  let active: ActiveJob | undefined;
  let disposed = false;

  const cancelActive = (): void => {
    const current = active;
    if (!current) return;
    active = undefined;
    current.reject(new SupersededError(current.id));
  };

  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Geometry client is disposed'));
    cancelActive();
    const id = ++latestJobId;
    return new Promise<T>((resolve, reject) => {
      const job: ActiveJob = { id, reject };
      active = job;
      Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (active !== job) return;
            active = undefined;
            resolve(value);
          },
          (error: unknown) => {
            if (active !== job) return;
            active = undefined;
            reject(error);
          },
        );
    });
  };

  return {
    get latestJobId() { return latestJobId; },
    analyze: (input) => run(() => api.inspect(options.transferInput?.(input) ?? input)),
    analyzeForImport: (input) => run(() => api.inspectAndFindAxes(options.transferInput?.(input) ?? input)),
    analyzeAndRepairForImport: (input) => run(() => (
      api.analyzeAndRepairForImport(options.transferInput?.(input) ?? input)
    )),
    repairAdvanced: (original, safeMesh) => run(() => {
      const originalCopy = cloneMesh(original);
      const safeCopy = cloneMesh(safeMesh);
      return api.repairAdvanced(
        options.transferMesh?.(originalCopy) ?? originalCopy,
        options.transferMesh?.(safeCopy) ?? safeCopy,
      );
    }),
    serializeSTL: (mesh, mode) => run(() => {
      const meshCopy = cloneMesh(mesh);
      return api.serializeSTL(options.transferMesh?.(meshCopy) ?? meshCopy, mode);
    }),
    findAxes: (mesh) => run(() => api.findAxes(options.transferMesh?.(mesh) ?? mesh)),
    decompose: (request) => run(() => api.decompose(request)),
    engrave: (request) => run(() => api.engrave(request)),
    cancelActive,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelActive();
      options.release?.();
    },
  };
}

function cloneMesh(mesh: SerializedMesh): SerializedMesh {
  return { positions: mesh.positions.slice(), indices: mesh.indices.slice() };
}

export function createGeometryClient(worker: Worker): GeometryClient {
  const api = wrap<GeometryApi>(worker);
  return makeGeometryClient(api, {
    transferInput: (input) => transfer(input, [input]),
    transferMesh: (mesh) => transfer(mesh, [mesh.positions.buffer, mesh.indices.buffer]),
    release: () => {
      api[releaseProxy]();
      worker.terminate();
    },
  });
}

export function createGeometryWorkerClient(): GeometryClient {
  return createGeometryClient(new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' }));
}
