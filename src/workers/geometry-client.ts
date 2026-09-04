import { expose, finalizer, proxy, releaseProxy, transfer, wrap, type Remote } from 'comlink';
import type { AxisCandidate } from '../domain/axis/find-axis';
import type { SpinnerKit } from '../domain/decomposition/types';
import type { EngravingMap } from '../domain/engraving/height-field';
import { validateManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { validateLauncherFitOffsetMm } from '../domain/outline-assembly/launcher-fit';
import type { MeshRepairResult } from '../domain/mesh/types';
import type { STLRepairMode } from '../domain/mesh/write-stl';
import type { OutlinePreviewPayload } from '../domain/outline-features/types';
import {
  AutomaticOutlineError,
  type AutomaticOutlineProgress,
  type AutomaticOutlineRequest,
  type PublicAutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import type {
  DecompositionRequest,
  EngravingRequest,
  GeometryApi,
  ImportAnalysis,
  ImportRepairAnalysis,
  MeshAnalysis,
  OutlinePackageTransfer,
  SerializedMesh,
} from './geometry-api';
import {
  OUTLINE_ARTIFACT_IDS,
  OutlineArtifactError,
  outlineArtifactFailureMessage,
  type OutlineArtifactId,
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
  readonly transferAutomaticRequest?: (request: AutomaticOutlineRequest) => AutomaticOutlineRequest;
  readonly transferMesh?: (mesh: SerializedMesh) => SerializedMesh;
  /** Stops CPU work already executing behind the API boundary. Must be synchronous and idempotent. */
  readonly abortExecution?: () => void;
  readonly release?: () => void;
};

export type GeometryClient = {
  readonly latestJobId: number;
  createStlPresentation(input: ArrayBuffer): Promise<OutlinePreviewPayload>;
  analyze(input: ArrayBuffer): Promise<MeshAnalysis>;
  convertAutomatically(
    request: AutomaticOutlineRequest,
    onProgress?: AutomaticOutlineProgress,
  ): Promise<PublicAutomaticOutlineResult>;
  packageOutline(result: PublicAutomaticOutlineResult, deadline?: number): Promise<OutlinePackageTransfer>;
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
    options.abortExecution?.();
  };

  const run = <T>(operation: (job: ActiveJob) => Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Geometry client is disposed'));
    cancelActive();
    const id = ++latestJobId;
    return new Promise<T>((resolve, reject) => {
      const job: ActiveJob = { id, reject };
      active = job;
      Promise.resolve()
        .then(() => {
          if (active !== job || disposed) throw new SupersededError(job.id);
          return operation(job);
        })
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
    // Deliberately structured-clone without transfer: the caller retains the
    // only STL buffer needed if material selection starts a conversion later.
    createStlPresentation: (input) => run(() => api.createStlPresentation(input)),
    analyze: (input) => run(() => api.inspect(options.transferInput?.(input) ?? input)),
    convertAutomatically: (request, onProgress) => run((job) => {
      const validatedRequest: AutomaticOutlineRequest = {
        ...request,
        material: validateManufacturingGeometryProfile(request.material),
        launcherFitOffsetMm: validateLauncherFitOffsetMm(request.launcherFitOffsetMm),
      };
      let gatedProgress: AutomaticOutlineProgress | undefined;
      if (onProgress) {
        gatedProgress = async (stage) => {
          if (active !== job || disposed) return;
          await onProgress(stage);
        };
        const onFinalize = (onProgress as AutomaticOutlineProgress & { [finalizer]?: () => void })[finalizer];
        if (onFinalize) Object.assign(gatedProgress, { [finalizer]: onFinalize });
      }
      return api.convertAutomatically(
        options.transferAutomaticRequest?.(validatedRequest) ?? validatedRequest,
        gatedProgress,
      );
    }),
    packageOutline: (result, deadline) => run(() => api.packageOutline(result, deadline)),
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
  return createRestartableGeometryClient(worker, createGeometryWorker);
}

function createRestartableGeometryClient(initialWorker: Worker, workerFactory: () => Worker): GeometryClient {
  let worker: Worker | undefined = initialWorker;
  let remote: Remote<GeometryApi> | undefined = wrap<GeometryApi>(initialWorker);
  const progressCleanups = new Set<() => void>();

  const releaseCurrentWorker = (): void => {
    const currentRemote = remote;
    const currentWorker = worker;
    remote = undefined;
    worker = undefined;
    for (const cleanup of [...progressCleanups]) {
      try { cleanup(); } catch { /* Cleanup observers cannot block worker termination. */ }
    }
    try {
      currentRemote?.[releaseProxy]();
    } finally {
      currentWorker?.terminate();
    }
  };
  const api = dynamicApi(() => {
    if (!worker || !remote) {
      worker = workerFactory();
      remote = wrap<GeometryApi>(worker);
    }
    return remote;
  }, progressCleanups);
  return makeGeometryClient(api, {
    transferInput: (input) => transfer(input, [input]),
    transferAutomaticRequest: (request) => transfer(request, [request.bytes]),
    transferMesh: (mesh) => transfer(mesh, [mesh.positions.buffer, mesh.indices.buffer]),
    abortExecution: releaseCurrentWorker,
    release: releaseCurrentWorker,
  });
}

export function createGeometryWorkerClient(): GeometryClient {
  return createRestartableGeometryClient(createGeometryWorker(), createGeometryWorker);
}

function createGeometryWorker(): Worker {
  const workerUrl = new URL('./geometry.worker.ts', import.meta.url);
  const pageUrl = new URL(globalThis.location.href);
  if (pageUrl.searchParams.get('shapecut-wasm-rollout') === '1') {
    workerUrl.searchParams.set('shapecut-wasm-rollout', '1');
  }
  return new Worker(workerUrl, { type: 'module' });
}

function dynamicApi(
  getRemote: () => Remote<GeometryApi>,
  progressCleanups: Set<() => void>,
): GeometryApi {
  return {
    createStlPresentation: (input) => getRemote().createStlPresentation(input),
    inspect: (input) => getRemote().inspect(input),
    convertAutomatically: async (request, onProgress) => {
      let progressBridge: ReturnType<typeof createProgressBridge> | undefined;
      try {
        if (onProgress) {
          if (typeof onProgress !== 'function') throw new TypeError('Automatic progress must be a callback');
          progressBridge = createProgressBridge(onProgress, progressCleanups);
        }
        const conversion = getRemote().convertAutomatically(request, progressBridge?.workerPort);
        if (progressBridge) progressBridge.submitted = true;
        return await conversion;
      } catch (error) {
        if (progressBridge && !progressBridge.submitted) progressBridge.cleanup();
        if (isSerializedAutomaticOutlineError(error)) {
          throw new AutomaticOutlineError(error.code, error.message);
        }
        throw error;
      }
    },
    packageOutline: async (result, deadline) => {
      try { return await getRemote().packageOutline(result, deadline); }
      catch (error) {
        if (isSerializedAutomaticOutlineError(error)) throw new AutomaticOutlineError(error.code, error.message);
        if (isSerializedOutlineArtifactError(error)) throw new OutlineArtifactError(error.artifact);
        throw error;
      }
    },
    inspectAndFindAxes: (input) => getRemote().inspectAndFindAxes(input),
    analyzeAndRepairForImport: (input) => getRemote().analyzeAndRepairForImport(input),
    repairAdvanced: (original, safeMesh) => getRemote().repairAdvanced(original, safeMesh),
    serializeSTL: (mesh, mode) => getRemote().serializeSTL(mesh, mode),
    findAxes: (mesh) => getRemote().findAxes(mesh),
    decompose: (request) => getRemote().decompose(request),
    engrave: (request) => getRemote().engrave(request),
  };
}

function createProgressBridge(
  onProgress: AutomaticOutlineProgress,
  progressCleanups: Set<() => void>,
): { readonly workerPort: MessagePort; readonly cleanup: () => void; submitted: boolean } {
  const { port1, port2 } = new MessageChannel();
  const onFinalize = (onProgress as AutomaticOutlineProgress & { [finalizer]?: () => void })[finalizer];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    progressCleanups.delete(cleanup);
    port1.close();
    try { onFinalize?.(); } catch { /* Finalizers are observers; endpoint cleanup is already complete. */ }
  };
  const exposedProgress = Object.assign(proxy(onProgress), { [finalizer]: cleanup });
  progressCleanups.add(cleanup);
  expose(exposedProgress, port1);
  const workerPort = transfer(port2, [port2]);
  return { workerPort, cleanup, submitted: false };
}

const AUTOMATIC_OUTLINE_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_STL',
  'NO_OUTLINE',
  'RESOURCE_LIMIT',
  'TIME_LIMIT',
  'LAUNCHER_INCOMPATIBLE',
  'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
]);

export function isSerializedAutomaticOutlineError(
  error: unknown,
): error is { readonly name: 'AutomaticOutlineError'; readonly code: AutomaticOutlineError['code']; readonly message: string } {
  return typeof error === 'object' && error !== null
    && (error as { readonly name?: unknown }).name === 'AutomaticOutlineError'
    && typeof (error as { readonly code?: unknown }).code === 'string'
    && AUTOMATIC_OUTLINE_ERROR_CODES.has((error as { readonly code: string }).code)
    && typeof (error as { readonly message?: unknown }).message === 'string';
}

const OUTLINE_ARTIFACT_ID_SET: ReadonlySet<string> = new Set(OUTLINE_ARTIFACT_IDS);

export function isSerializedOutlineArtifactError(
  error: unknown,
): error is {
  readonly name: 'OutlineArtifactError';
  readonly code: 'ARTIFACT_FAILURE';
  readonly artifact: OutlineArtifactId;
  readonly message: string;
} {
  if (typeof error !== 'object' || error === null
    || (error as { readonly name?: unknown }).name !== 'OutlineArtifactError'
    || (error as { readonly code?: unknown }).code !== 'ARTIFACT_FAILURE'
    || typeof (error as { readonly artifact?: unknown }).artifact !== 'string'
    || !OUTLINE_ARTIFACT_ID_SET.has((error as { readonly artifact: string }).artifact)
    || typeof (error as { readonly message?: unknown }).message !== 'string') return false;
  const artifact = (error as { readonly artifact: OutlineArtifactId }).artifact;
  return (error as { readonly message: string }).message === outlineArtifactFailureMessage(artifact);
}
