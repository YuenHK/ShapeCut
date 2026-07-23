import { describe, expect, it } from 'vitest';
import { createStlPresentationPayload } from './stl-presentation';

const VALID_ASCII_STL = `solid preview
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 6 2
  endloop
endfacet
endsolid preview`;

describe('createStlPresentationPayload', () => {
  it('adapts bounded STL bytes into an empty-layer presentation payload', () => {
    const bytes = new TextEncoder().encode(VALID_ASCII_STL).buffer;
    const payload = createStlPresentationPayload(bytes);

    expect(payload.mesh.positions).toBeInstanceOf(Float32Array);
    expect(payload.mesh.indices).toEqual(Uint32Array.from([0, 1, 2]));
    expect(payload.layers).toEqual([]);
    expect(payload.axis).toEqual({
      origin: [5, 3, 1],
      direction: [0, 0, 1],
      planeX: [1, 0, 0],
      planeY: [0, 1, 0],
    });
  });

  it('uniformly bounds a large presentation mesh while retaining both ends of its real triangle range', () => {
    const triangleCount = 3_000;
    const bytes = new ArrayBuffer(84 + triangleCount * 50);
    const view = new DataView(bytes);
    view.setUint32(80, triangleCount, true);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const offset = 84 + triangle * 50 + 12;
      for (let corner = 0; corner < 3; corner += 1) {
        view.setFloat32(offset + corner * 12, triangle, true);
        view.setFloat32(offset + corner * 12 + 4, corner, true);
        view.setFloat32(offset + corner * 12 + 8, 0, true);
      }
    }

    const payload = createStlPresentationPayload(bytes);

    expect(payload.mesh.indices.length).toBeLessThanOrEqual(2_000 * 3);
    expect(payload.mesh.positions.length).toBeLessThanOrEqual(2_000 * 3 * 3);
    const xs = Array.from(payload.mesh.positions).filter((_value, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(triangleCount - 1);
  });
});
