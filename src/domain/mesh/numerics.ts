import type { Vec3 } from '../types';
import type { TriangleMesh } from './types';

const AREA_RELATIVE_EPSILON = 64 * Number.EPSILON;
const VOLUME_RELATIVE_EPSILON = 256 * Number.EPSILON;

export type MeshNumerics = {
  readonly reference: Vec3;
  readonly areaToleranceSquared: number;
  readonly volumeTolerance: number;
};

export function meshNumerics(mesh: TriangleMesh): MeshNumerics {
  if (mesh.positions.length < 3) {
    return { reference: [0, 0, 0], areaToleranceSquared: Number.MIN_VALUE, volumeTolerance: Number.MIN_VALUE };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset + 2 < mesh.positions.length; offset += 3) {
    const x = mesh.positions[offset];
    const y = mesh.positions[offset + 1];
    const z = mesh.positions[offset + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const characteristicLength = Math.hypot(dx, dy, dz);
  return {
    reference: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    areaToleranceSquared: Math.max(
      Number.MIN_VALUE,
      characteristicLength ** 4 * AREA_RELATIVE_EPSILON ** 2,
    ),
    volumeTolerance: Math.max(Number.MIN_VALUE, characteristicLength ** 3 * VOLUME_RELATIVE_EPSILON),
  };
}

export function signedTetrahedronVolume(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  return (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
}
