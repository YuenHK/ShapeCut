import { afterEach, describe, expect, it } from 'vitest';
import type { GeometryClient } from './geometry-client';
import { createGeometryWorkerClient } from './geometry-client';

const clients: GeometryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

describe('geometry worker boundary', () => {
  it('parses and inspects an STL through Comlink with transferred input ownership', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = new TextEncoder().encode(`solid triangle
      facet normal 0 0 1
        outer loop
          vertex 0 0 0
          vertex 1 0 0
          vertex 0 1 0
        endloop
      endfacet
    endsolid triangle`).buffer;

    const result = await client.analyze(source);

    expect(source.byteLength).toBe(0);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.inspection).toMatchObject({ triangleCount: 1, boundaryEdgeCount: 3 });
    expect(result.mesh.positions).toBeInstanceOf(Float64Array);
    expect(result.mesh.indices).toBeInstanceOf(Uint32Array);
  });
});
