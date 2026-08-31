import { SliceWorkerPool } from './slice-worker-pool';

(globalThis as typeof globalThis & { __sliceWorkerPoolBuildFixture?: unknown })
  .__sliceWorkerPoolBuildFixture = SliceWorkerPool;
