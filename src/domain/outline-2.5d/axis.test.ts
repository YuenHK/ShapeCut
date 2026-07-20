import { describe, expect, it } from 'vitest';
import type { AxisCandidate } from '../axis/find-axis';
import type { TriangleMesh } from '../mesh/types';
import { selectOutlineAxis } from './axis';

function boxMesh(sizeX: number, sizeY: number, sizeZ: number): TriangleMesh {
  const [x, y, z] = [sizeX / 2, sizeY / 2, sizeZ / 2];
  return {
    positions: new Float64Array([
      -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z,
      -x, -y, z, x, -y, z, x, y, z, -x, y, z,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
  };
}

function candidate(overrides: Partial<AxisCandidate> = {}): AxisCandidate {
  return {
    origin: [0, 0, 0],
    direction: [0, 0, 4],
    confidence: 0.9,
    confirmed: false,
    radialRmsError: 0.01,
    centroidOffset: 0.01,
    source: 'inertia',
    ...overrides,
  };
}

describe('selectOutlineAxis', () => {
  it('confirms and normalizes a trusted candidate', () => {
    const selection = selectOutlineAxis(boxMesh(6, 4, 8), [candidate()]);

    expect(selection).toMatchObject({
      source: 'candidate',
      axis: { direction: [0, 0, 1], confidence: 0.9, confirmed: true },
    });
  });

  it('accepts a candidate exactly at the automatic confidence threshold', () => {
    expect(selectOutlineAxis(boxMesh(6, 4, 8), [candidate({ confidence: 0.8 })]).source)
      .toBe('candidate');
  });

  it('uses the shortest finite non-zero bounds axis when no candidate is trusted', () => {
    const selection = selectOutlineAxis(boxMesh(8, 2, 4), [candidate({ confidence: 0.799 })]);

    expect(selection).toEqual({
      source: 'shortest-bounds',
      axis: { origin: [0, 0, 0], direction: [0, 1, 0], confidence: 0, confirmed: true },
    });
  });

  it('rejects meshes without finite non-zero-volume bounds', () => {
    const empty: TriangleMesh = { positions: new Float64Array(), indices: new Uint32Array() };
    const nonFinite = boxMesh(4, 3, 2);
    nonFinite.positions[0] = Number.NaN;

    expect(() => selectOutlineAxis(empty, [])).toThrow(RangeError);
    expect(() => selectOutlineAxis(nonFinite, [])).toThrow(RangeError);
    expect(() => selectOutlineAxis(boxMesh(4, 3, 0), [])).toThrow(RangeError);
  });
});
