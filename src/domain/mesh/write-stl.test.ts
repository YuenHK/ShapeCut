import { describe, expect, it } from 'vitest';
import { tetrahedron } from '../../test/mesh-builders';
import { parseSTL } from './parse-stl';
import type { TriangleMesh } from './types';
import { writeBinarySTL } from './write-stl';

describe('binary STL writer', () => {
  it('writes an exact-length binary STL that reparses to the same triangle count', () => {
    const bytes = writeBinarySTL(tetrahedron(), 'safe');

    expect(bytes.byteLength).toBe(84 + 4 * 50);
    expect(parseSTL(bytes).indices.length).toBe(12);
    expect(new TextDecoder().decode(bytes.slice(0, 80))).toContain('safe');
  });

  it('writes advanced mode and finite unit normals without mutating the mesh', () => {
    const mesh = tetrahedron();
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();

    const bytes = writeBinarySTL(mesh, 'advanced');
    const view = new DataView(bytes);
    const normal = [view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)];

    expect(new TextDecoder().decode(bytes.slice(0, 80))).toContain('advanced');
    expect(normal.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...normal)).toBeCloseTo(1, 6);
    expect(mesh.positions).toEqual(positions);
    expect(mesh.indices).toEqual(indices);
  });

  it.each([
    {
      name: 'an incomplete triangle',
      mesh: { positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) },
      message: /complete triangles/i,
    },
    {
      name: 'an out-of-range index',
      mesh: { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 3]) },
      message: /outside the vertex buffer/i,
    },
    {
      name: 'a coordinate that overflows binary STL float32',
      mesh: { positions: new Float64Array([0, 0, 0, Number.MAX_VALUE, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      message: /finite float32/i,
    },
  ] satisfies ReadonlyArray<{ name: string; mesh: TriangleMesh; message: RegExp }>)('rejects $name', ({ mesh, message }) => {
    expect(() => writeBinarySTL(mesh, 'safe')).toThrow(message);
  });
});
