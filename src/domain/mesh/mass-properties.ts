import type { MassProperties, TriangleMesh } from './types';
import { meshNumerics, signedTetrahedronVolume } from './numerics';

export class MeshVolumeError extends Error {
  constructor(message = 'Mesh has near-zero signed volume') {
    super(message);
    this.name = 'MeshVolumeError';
  }
}

export function massProperties(mesh: TriangleMesh): MassProperties {
  const { reference, volumeTolerance } = meshNumerics(mesh);
  let signedVolume = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const ai = mesh.indices[offset] * 3;
    const bi = mesh.indices[offset + 1] * 3;
    const ci = mesh.indices[offset + 2] * 3;
    const ax = mesh.positions[ai] - reference[0];
    const ay = mesh.positions[ai + 1] - reference[1];
    const az = mesh.positions[ai + 2] - reference[2];
    const bx = mesh.positions[bi] - reference[0];
    const by = mesh.positions[bi + 1] - reference[1];
    const bz = mesh.positions[bi + 2] - reference[2];
    const cx = mesh.positions[ci] - reference[0];
    const cy = mesh.positions[ci + 1] - reference[1];
    const cz = mesh.positions[ci + 2] - reference[2];
    const tetraVolume = signedTetrahedronVolume(ax, ay, az, bx, by, bz, cx, cy, cz);
    signedVolume += tetraVolume;
    momentX += tetraVolume * (ax + bx + cx) / 4;
    momentY += tetraVolume * (ay + by + cy) / 4;
    momentZ += tetraVolume * (az + bz + cz) / 4;
  }
  if (Math.abs(signedVolume) <= volumeTolerance) throw new MeshVolumeError();
  return {
    volume: Math.abs(signedVolume),
    centroid: [
      reference[0] + momentX / signedVolume,
      reference[1] + momentY / signedVolume,
      reference[2] + momentZ / signedVolume,
    ],
  };
}
