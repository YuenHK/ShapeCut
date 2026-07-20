import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizer } from 'comlink';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import { removalEvidenceFingerprint } from '../domain/pipeline/automatic-outline-pipeline';
import type { TriangleMesh } from '../domain/mesh/types';
import {
  interpenetratingTetrahedra,
  openTetrahedron,
  separatedClosedCylinders,
  tetrahedron,
  tetrahedronWithOneReversedFace,
} from '../test/mesh-builders';
import type { GeometryClient } from './geometry-client';
import { createGeometryWorkerClient } from './geometry-client';

const clients: GeometryClient[] = [];
const scaledOpenTetrahedron = () => {
  const mesh = openTetrahedron();
  return { ...mesh, positions: new Float64Array(Array.from(mesh.positions, (value) => value * 20)) };
};

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

describe('geometry worker boundary', () => {
  it('proxies automatic progress monotonically across Comlink and transfers the STL bytes', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(scaledOpenTetrahedron(), 'safe');
    const progress: string[] = [];
    const released = vi.fn();
    const onProgress = Object.assign(
      (stage: string) => { progress.push(stage); },
      { [finalizer]: released },
    );

    const result = await client.convertAutomatically({ bytes: source }, onProgress);

    expect(source.byteLength).toBe(0);
    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(result.layers[0].sourceBoundsMm).toEqual(expect.objectContaining({
      minX: expect.any(Number), minY: expect.any(Number), maxX: expect.any(Number), maxY: expect.any(Number),
    }));
    expect(progress).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'packaging']);
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('observes progress callback rejection and releases its Comlink proxy', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const released = vi.fn();
    const onProgress = Object.assign(
      async (stage: string) => { if (stage === 'packaging') throw new Error('progress receiver closed'); },
      { [finalizer]: released },
    );

    await expect(client.convertAutomatically({ bytes: writeBinarySTL(tetrahedron(), 'safe') }, onProgress))
      .rejects.toThrow('progress receiver closed');
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('preserves typed automatic failure codes across Comlink', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);

    await expect(client.convertAutomatically({ bytes: new ArrayBuffer(1) })).rejects.toMatchObject({
      name: 'AutomaticOutlineError',
      code: 'INVALID_STL',
    });
  });

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

  it('returns independently backed original, preview, and safe repair meshes', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(tetrahedron(), 'safe');

    const result = await client.analyzeAndRepairForImport(source);

    expect(source.byteLength).toBe(0);
    expect(result.originalReport.inspection.triangleCount).toBe(4);
    expect(result.safeRepair.mode).toBe('safe');
    expect(result.safeRepair.accepted).toBe(true);
    expect(result.originalPreview.positions.length).toBeGreaterThan(0);
    expect(result.originalMesh.positions.buffer).not.toBe(result.originalPreview.positions.buffer);
    expect(result.originalMesh.positions.buffer).not.toBe(result.safeRepair.mesh.positions.buffer);
    expect(result.originalPreview.positions.buffer).not.toBe(result.safeRepair.mesh.positions.buffer);
  });

  it('preserves original and safe meshes when advanced repair rejects', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const result = await client.analyzeAndRepairForImport(writeBinarySTL(openTetrahedron(), 'safe'));
    const oversizedSafeMesh = {
      positions: result.safeRepair.mesh.positions.slice(),
      indices: new Uint32Array([...result.safeRepair.mesh.indices, 0, 1, 2]),
    };
    const originalLength = result.originalMesh.positions.length;
    const safeLength = oversizedSafeMesh.positions.length;

    await expect(client.repairAdvanced(result.originalMesh, oversizedSafeMesh)).rejects.toThrow(/triangle.*limit/i);

    expect(result.originalMesh.positions.length).toBe(originalLength);
    expect(result.originalMesh.indices.length).toBe(9);
    expect(oversizedSafeMesh.positions.length).toBe(safeLength);
    expect(oversizedSafeMesh.indices.length).toBe(12);
  });

  it('caps each problem marker collection at 2,000 while retaining complete counts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const source = writeBinarySTL(disconnectedTriangles(2_001), 'safe');

    const result = await client.analyzeAndRepairForImport(source);

    expect(result.originalReport.inspection.boundaryEdgeCount).toBe(6_003);
    expect(result.originalReport.boundaryEdges).toHaveLength(2_000);
    expect(result.originalReport.markersTruncated.boundaryEdges).toBe(true);
  });

  it('serializes repaired meshes and reparses the exact binary STL before transfer', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const mesh = tetrahedron();

    const bytes = await client.serializeSTL(mesh, 'advanced');

    expect(mesh.positions.length).toBe(12);
    expect(mesh.indices.length).toBe(12);
    expect(bytes.byteLength).toBe(84 + 4 * 50);
    expect(new TextDecoder().decode(bytes.slice(0, 80))).toContain('advanced');
    expect(new DataView(bytes).getUint32(80, true)).toBe(4);
  });

  it.each([
    ['inconsistent winding', tetrahedronWithOneReversedFace(), 'inconsistentWindingEdgeCount'],
    ['3D self-intersection', interpenetratingTetrahedra(), 'selfIntersectionCount'],
  ] as const)('keeps %s counterexamples locked across the real worker boundary', async (_label, mesh, countKey) => {
    const client = createGeometryWorkerClient();
    clients.push(client);

    const result = await client.analyzeAndRepairForImport(writeBinarySTL(mesh, 'safe'));

    expect(result.safeRepair.after[countKey]).toBeGreaterThan(0);
    expect(result.safeRepair.accepted).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('terminates an automatic conversion on supersede and completes the replacement on a fresh worker', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const client = createGeometryWorkerClient();
    clients.push(client);
    const released = vi.fn();
    const onProgress = Object.assign(
      () => undefined,
      { [finalizer]: released },
    );
    const first = client.convertAutomatically(
      { bytes: writeBinarySTL(disconnectedTriangles(20_000), 'safe') },
      onProgress,
    )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ type: 'APPLY' }),
    ));

    const replacement = client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });

    await expect(first).resolves.toBeInstanceOf(Error);
    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED', jobId: 1 });
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(terminate).toHaveBeenCalled();
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });

  it('terminates in-flight outline packaging when a replacement conversion starts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(256), 'safe') });
    for (const layer of runtime.layers) {
      const clockwise = layer.contour.outer.reduce((sum, point, index) => {
        const next = layer.contour.outer[(index + 1) % layer.contour.outer.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) < 0;
      const points = Array.from({ length: 4096 }, (_, index) => {
        const angle = (clockwise ? -1 : 1) * index / 4096 * Math.PI * 2;
        return [5 * Math.cos(angle), 5 * Math.sin(angle)] as const;
      });
      const area = Math.abs(points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) / 2);
      Object.assign(layer, {
        contour: { outer: points, holes: [] }, sourceAreaMm2: area, simplifiedAreaMm2: area,
        sourceBoundsMm: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
      });
    }
    Object.assign(runtime, { removalEvidenceFingerprint: removalEvidenceFingerprint(runtime) });
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const priorApplyCount = postMessage.mock.calls.length;
    const first = client.packageOutline(runtime).catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.length).toBeGreaterThan(priorApplyCount));

    const replacement = client.convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(), 'safe') });

    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(terminate).toHaveBeenCalled();
  });

  it('returns a typed TIME_LIMIT when the shared packaging deadline is exhausted', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const runtime = await client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });

    await expect(client.packageOutline(runtime, 0)).rejects.toMatchObject({
      name: 'AutomaticOutlineError', code: 'TIME_LIMIT', message: '模型處理超出時間上限',
    });
  });

  it('still terminates and recreates when progress finalization throws during cancel', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    const client = createGeometryWorkerClient();
    clients.push(client);
    const released = vi.fn(() => { throw new Error('cleanup observer failed'); });
    const first = client.convertAutomatically(
      { bytes: writeBinarySTL(disconnectedTriangles(20_000), 'safe') },
      Object.assign(() => undefined, { [finalizer]: released }),
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ type: 'APPLY' }),
    ));

    let replacement!: ReturnType<GeometryClient['convertAutomatically']>;
    expect(() => {
      replacement = client.convertAutomatically({ bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') });
    }).not.toThrow();

    await expect(first).resolves.toMatchObject({ name: 'SupersededError', code: 'SUPERSEDED' });
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(released).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalled();
  });

  it('does not publish queued progress from an old worker after its replacement starts', async () => {
    const client = createGeometryWorkerClient();
    clients.push(client);
    const observed: string[] = [];
    const queuedMessages: Array<() => void> = [];
    const originalAddEventListener = MessagePort.prototype.addEventListener;
    let interceptNextMessageListener = true;
    const addEventListener = vi.spyOn(MessagePort.prototype, 'addEventListener').mockImplementation(function (
      this: MessagePort,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== 'message' || !interceptNextMessageListener) {
        return originalAddEventListener.call(this, type, listener, options);
      }
      interceptNextMessageListener = false;
      return originalAddEventListener.call(this, type, (event) => {
        queuedMessages.push(() => {
          if (typeof listener === 'function') listener.call(this, event);
          else listener.handleEvent(event);
        });
      }, options);
    } as typeof MessagePort.prototype.addEventListener);
    const first = client.convertAutomatically(
      { bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') },
      (stage) => { observed.push(`old:${stage}`); },
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(queuedMessages.length).toBeGreaterThan(0));
    const replacement = client.convertAutomatically(
      { bytes: writeBinarySTL(scaledOpenTetrahedron(), 'safe') },
      (stage) => { observed.push(`new:${stage}`); },
    );
    addEventListener.mockRestore();
    for (const deliver of queuedMessages) deliver();

    await first;
    await expect(replacement).resolves.toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expect(observed).toEqual([
      'new:reading',
      'new:analyzing',
      'new:simplifying',
      'new:slicing',
      'new:packaging',
    ]);
  });
});

function disconnectedTriangles(count: number): TriangleMesh {
  const positions = new Float64Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let triangle = 0; triangle < count; triangle += 1) {
    const positionOffset = triangle * 9;
    const indexOffset = triangle * 3;
    const x = triangle * 2;
    positions.set([x, 0, 0, x + 1, 0, 0, x, 1, 0], positionOffset);
    indices.set([indexOffset, indexOffset + 1, indexOffset + 2], indexOffset);
  }
  return { positions, indices };
}
