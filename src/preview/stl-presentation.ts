import { parseSTL } from '../domain/mesh/parse-stl';
import type { OutlinePreviewPayload } from '../domain/outline-features/types';

/**
 * Adapts the uploaded STL into presentation-only wireframe data.
 * The caller-owned bytes are parsed without copying or mutation, and no mesh
 * repair, manufacturing-axis selection, slicing, or output decision occurs.
 */
export function createStlPresentationPayload(bytes: ArrayBuffer): OutlinePreviewPayload {
  const mesh = parseSTL(bytes);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index];
    const y = mesh.positions[index + 1];
    const z = mesh.positions[index + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    mesh: {
      positions: Float32Array.from(mesh.positions),
      indices: mesh.indices,
    },
    axis: {
      origin: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      direction: [0, 0, 1],
      planeX: [1, 0, 0],
      planeY: [0, 1, 0],
    },
    layers: [],
  };
}
