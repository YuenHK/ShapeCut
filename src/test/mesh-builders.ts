import type { TriangleMesh } from '../domain/mesh/types';

const tetrahedronPositions = new Float64Array([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
]);

export function tetrahedron(): TriangleMesh {
  return {
    positions: tetrahedronPositions.slice(),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      0, 3, 2,
      1, 2, 3,
    ]),
  };
}

export function openTetrahedron(): TriangleMesh {
  const mesh = tetrahedron();
  return { positions: mesh.positions, indices: mesh.indices.slice(0, 9) };
}
