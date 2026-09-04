import { createGeometryWorkerClient } from './geometry-client';

(globalThis as typeof globalThis & { __geometryClientBuildFixture?: unknown })
  .__geometryClientBuildFixture = createGeometryWorkerClient;
