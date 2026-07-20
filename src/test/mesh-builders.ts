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

export function separatedClosedCylinders(segments = 32): TriangleMesh {
  const positions: number[] = [], indices: number[] = [];
  for (const centerX of [-8, 8]) {
    const offset = positions.length / 3;
    positions.push(centerX, 0, -1, centerX, 0, 1);
    for (let index = 0; index < segments; index += 1) {
      const angle = index / segments * Math.PI * 2;
      positions.push(centerX + 5 * Math.cos(angle), 5 * Math.sin(angle), -1);
      positions.push(centerX + 5 * Math.cos(angle), 5 * Math.sin(angle), 1);
    }
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      const bottom = offset + 2 + index * 2, top = bottom + 1;
      const nextBottom = offset + 2 + next * 2, nextTop = nextBottom + 1;
      indices.push(offset, bottom, nextBottom, offset + 1, nextTop, top);
      indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}
