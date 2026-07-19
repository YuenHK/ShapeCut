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

export function tetrahedronWithOneReversedFace(): TriangleMesh {
  const mesh = tetrahedron();
  const indices = mesh.indices.slice();
  [indices[1], indices[2]] = [indices[2], indices[1]];
  return { positions: mesh.positions, indices };
}

export function interpenetratingTetrahedra(): TriangleMesh {
  const first = tetrahedron();
  const translation = [0.2, 0.2, 0.2] as const;
  const positions = new Float64Array([
    ...first.positions,
    ...Array.from(first.positions, (value, index) => value + translation[index % 3]),
  ]);
  return {
    positions,
    indices: new Uint32Array([
      ...first.indices,
      ...Array.from(first.indices, (index) => index + 4),
    ]),
  };
}
