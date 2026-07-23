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
});
