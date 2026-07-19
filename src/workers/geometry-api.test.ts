import { describe, expect, it, vi } from 'vitest';
import type { GeometryApi, MeshAnalysis } from './geometry-api';
import { makeGeometryClient, SupersededError } from './geometry-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function analysis(sourceHash: string): MeshAnalysis {
  return {
    sourceHash,
    mesh: { positions: new Float64Array(), indices: new Uint32Array() },
    inspection: {
      triangleCount: 0,
      boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
      invertedVolume: false,
    },
  };
}

function inspectOnly(inspect: GeometryApi['inspect']): GeometryApi {
  return {
    inspect,
    findAxes: vi.fn(),
    decompose: vi.fn(),
    engrave: vi.fn(),
  };
}

describe('geometry worker client', () => {
  it('drops a stale result as soon as a newer job starts', async () => {
    const firstRemote = deferred<MeshAnalysis>();
    const secondRemote = deferred<MeshAnalysis>();
    const inspect = vi.fn()
      .mockReturnValueOnce(firstRemote.promise)
      .mockReturnValueOnce(secondRemote.promise);
    const client = makeGeometryClient(inspectOnly(inspect));

    const first = client.analyze(new ArrayBuffer(1));
    const second = client.analyze(new ArrayBuffer(2));

    await expect(first).rejects.toEqual(expect.objectContaining({ name: 'SupersededError', code: 'SUPERSEDED', jobId: 1 }));
    secondRemote.resolve(analysis('mesh-b'));
    await expect(second).resolves.toMatchObject({ sourceHash: 'mesh-b' });

    firstRemote.resolve(analysis('mesh-a'));
  });

  it('cancels the active logical job when the UI leaves the step', async () => {
    const remote = deferred<MeshAnalysis>();
    const client = makeGeometryClient(inspectOnly(() => remote.promise));

    const pending = client.analyze(new ArrayBuffer(8));
    client.cancelActive();

    await expect(pending).rejects.toBeInstanceOf(SupersededError);
    remote.resolve(analysis('ignored'));
  });

  it('uses monotonically increasing job IDs after cancellation', async () => {
    const pending = deferred<MeshAnalysis>();
    const inspect = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(analysis('mesh-c'));
    const client = makeGeometryClient(inspectOnly(inspect));

    const first = client.analyze(new ArrayBuffer(1));
    client.cancelActive();
    await expect(first).rejects.toMatchObject({ jobId: 1 });

    await expect(client.analyze(new ArrayBuffer(1))).resolves.toMatchObject({ sourceHash: 'mesh-c' });
    expect(client.latestJobId).toBe(2);
    pending.resolve(analysis('ignored'));
  });

  it('passes STL buffers through the supplied transferable adapter', async () => {
    const inspect = vi.fn().mockResolvedValue(analysis('mesh-a'));
    const transferred = new ArrayBuffer(4);
    const transferInput = vi.fn(() => transferred);
    const source = new ArrayBuffer(4);
    const client = makeGeometryClient(inspectOnly(inspect), { transferInput });

    await client.analyze(source);

    expect(transferInput).toHaveBeenCalledWith(source);
    expect(inspect).toHaveBeenCalledWith(transferred);
  });
});
