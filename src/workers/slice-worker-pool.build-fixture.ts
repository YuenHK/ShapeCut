import { SliceWorkerPool } from './slice-worker-pool';
import craftedWorkerUrl from './crafted-production-worker.test-fixture.ts?worker&url';

(globalThis as typeof globalThis & { __sliceWorkerPoolBuildFixture?: unknown })
  .__sliceWorkerPoolBuildFixture = Object.freeze({ SliceWorkerPool, craftedWorkerUrl });
