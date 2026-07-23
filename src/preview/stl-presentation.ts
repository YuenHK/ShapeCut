import { parseSTL } from '../domain/mesh/parse-stl';
import type { OutlinePreviewPayload } from '../domain/outline-features/types';

const MAX_PRESENTATION_TRIANGLES = 2_000;

function createPresentationMesh(mesh: ReturnType<typeof parseSTL>): OutlinePreviewPayload['mesh'] {
  const triangleCount = Math.floor(mesh.indices.length / 3);
  const sampleCount = Math.min(triangleCount, MAX_PRESENTATION_TRIANGLES);
  const remappedVertices = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(sampleCount * 3);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const triangle = sampleCount <= 1
      ? 0
      : Math.round(sample * (triangleCount - 1) / (sampleCount - 1));
    for (let corner = 0; corner < 3; corner += 1) {
      const sourceVertex = mesh.indices[triangle * 3 + corner];
      let presentationVertex = remappedVertices.get(sourceVertex);
      if (presentationVertex === undefined) {
        presentationVertex = remappedVertices.size;
        remappedVertices.set(sourceVertex, presentationVertex);
        const offset = sourceVertex * 3;
        positions.push(mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]);
      }
      indices[sample * 3 + corner] = presentationVertex;
    }
  }

  return { positions: Float32Array.from(positions), indices };
}

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
    mesh: createPresentationMesh(mesh),
    axis: {
      origin: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      direction: [0, 0, 1],
      planeX: [1, 0, 0],
      planeY: [0, 1, 0],
    },
    layers: [],
  };
}
