import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from './types';
import { meshNumerics } from './numerics';

describe('meshNumerics cancellation latency', () => {
  it('polls through a late vertex scan with a bounded access interval', () => {
    const raw = new Float64Array(12_000);
    for (let index = 0; index < raw.length; index += 3) {
      raw[index] = index / 3;
      raw[index + 1] = index % 17;
      raw[index + 2] = index % 29;
    }
    let reads = 0;
    const positions = new Proxy(raw, {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, target);
      },
    }) as unknown as Float64Array;
    const mesh: TriangleMesh = { positions, indices: new Uint32Array() };
    const cancellation = new Error('numeric vertex scan cancelled');
    let lastReads = 0;
    let caught: unknown;
    try {
      meshNumerics(mesh, Infinity, () => {
        const interval = reads - lastReads;
        if (interval > 768) throw new Error(`numeric checkpoint interval ${interval}`);
        lastReads = reads;
        if (reads >= 6_000) throw cancellation;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancellation);
  });
});
