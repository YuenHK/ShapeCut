import { describe, expect, it } from 'vitest';
import {
  partitionSliceWork,
  resolveSliceWorkerCount,
} from './slice-partitioner';

function layeredMesh(): { readonly positions: Float32Array; readonly indices: Uint32Array } {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 4,
      2, 0, 0, 3, 0, 0, 2, 1, 1,
      4, 0, 3, 5, 0, 3, 4, 1, 4,
    ]),
    indices: new Uint32Array([
      0, 1, 2,
      3, 4, 5,
      6, 7, 8,
    ]),
  };
}

describe('slice worker device policy', () => {
  it.each([
    [0, 1], [1, 1], [2, 1],
    [3, 2], [4, 2], [5, 2],
    [6, 4], [8, 4], [64, 4],
  ])('maps hardwareConcurrency %s to %s workers', (hardwareConcurrency, expected) => {
    expect(resolveSliceWorkerCount(hardwareConcurrency)).toBe(expected);
  });
});

describe('partitionSliceWork', () => {
  it('assigns every plane exactly once in stable canonical order', () => {
    const planes = new Float64Array([0.5, 1.5, 2.5, 3.5]);

    const first = partitionSliceWork(layeredMesh(), planes, 2);
    const second = partitionSliceWork(layeredMesh(), planes, 2);

    expect(first.map((partition) => [...partition.planeIndices])).toEqual(
      second.map((partition) => [...partition.planeIndices]),
    );
    expect(first.flatMap((partition) => [...partition.planeIndices]).sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3]);
    for (const partition of first) {
      expect([...partition.planeIndices]).toEqual([...partition.planeIndices].sort((a, b) => a - b));
      expect([...partition.planes]).toEqual(
        [...partition.planeIndices].map((planeIndex) => planes[planeIndex]),
      );
    }
  });

  it('separates the two highest-overlap planes instead of averaging only layer count', () => {
    const partitions = partitionSliceWork(
      layeredMesh(),
      new Float64Array([0.5, 1.5, 2.5, 3.5]),
      2,
    );
    const ownerOf = (planeIndex: number): number => partitions.findIndex(
      (partition) => [...partition.planeIndices].includes(planeIndex),
    );

    // Planes 0.5 and 3.5 each overlap two triangles; deterministic LPT must
    // seed separate workers before assigning the cheaper zero-overlap plane.
    expect(ownerOf(0)).not.toBe(ownerOf(3));
    expect(partitions.every((partition) => partition.estimatedByteCost > 0)).toBe(true);
  });

  it('copies only triangles overlapping a partition plane and preserves triangle order', () => {
    const partitions = partitionSliceWork(
      layeredMesh(),
      new Float64Array([0.5, 3.5]),
      2,
    );

    expect(partitions).toHaveLength(2);
    expect(partitions.map((partition) => partition.indices.length / 3)).toEqual([2, 2]);
    expect(partitions.every((partition) => partition.positions.length < layeredMesh().positions.length))
      .toBe(true);
  });

  it('does not create empty excess partitions', () => {
    const partitions = partitionSliceWork(layeredMesh(), new Float64Array([0.5]), 4);
    expect(partitions).toHaveLength(1);
    expect([...partitions[0].planeIndices]).toEqual([0]);
  });

  it('rejects equal planes before they can be split across workers', () => {
    expect(() => partitionSliceWork(layeredMesh(), new Float64Array([1, 1]), 2))
      .toThrow(/strictly increasing/i);
  });

  it('retains triangles inside the Rust axial tolerance', () => {
    const mesh = {
      positions: new Float32Array([
        0, 0, 5e-10,
        1, 0, 5e-10,
        0, 1, 5e-10,
      ]),
      indices: new Uint32Array([0, 1, 2]),
    };

    const partitions = partitionSliceWork(mesh, new Float64Array([0]), 1);

    expect(partitions[0].indices.length).toBe(3);
  });

  it('assigns remote degenerate evidence to partition zero exactly once', () => {
    const mesh = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 2,
        0, 0, 100, 1, 0, 100, 2, 0, 100,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    };

    const partitions = partitionSliceWork(mesh, new Float64Array([0.5, 1.5]), 2);
    const owners = partitions.filter((partition) => [...partition.positions].includes(100));

    expect(owners).toHaveLength(1);
    expect(owners[0].partitionIndex).toBe(0);
  });

  it('creates a zero-plane evidence batch containing only degenerate triangles', () => {
    const mesh = {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 2,
        0, 0, 100, 1, 0, 100, 2, 0, 100,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    };

    const partitions = partitionSliceWork(mesh, new Float64Array(), 4);

    expect(partitions).toHaveLength(1);
    expect(partitions[0].planes).toHaveLength(0);
    expect(partitions[0].indices).toHaveLength(3);
    expect([...partitions[0].positions]).toContain(100);
  });
});
