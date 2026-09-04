import { parseSTL } from '../domain/mesh/parse-stl';
import type { OutlinePreviewPayload } from '../domain/outline-features/types';

const MAX_PRESENTATION_TRIANGLES = 2_000;

function createBinaryPresentation(bytes: ArrayBuffer): OutlinePreviewPayload | undefined {
  if (bytes.byteLength < 84) return undefined;
  const view = new DataView(bytes);
  const triangleCount = view.getUint32(80, true);
  if (triangleCount === 0 || 84 + triangleCount * 50 !== bytes.byteLength) return undefined;
  const sampleCount = Math.min(triangleCount, MAX_PRESENTATION_TRIANGLES);
  const positions = new Float32Array(sampleCount * 9);
  const indices = new Uint32Array(sampleCount * 3);
  const sampled = new Map<number, number>();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    sampled.set(sampleCount <= 1 ? 0 : Math.round(sample * (triangleCount - 1) / (sampleCount - 1)), sample);
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const sample = sampled.get(triangle);
    const triangleOffset = 84 + triangle * 50 + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = triangleOffset + corner * 12;
      const x = view.getFloat32(offset, true), y = view.getFloat32(offset + 4, true), z = view.getFloat32(offset + 8, true);
      if (![x, y, z].every(Number.isFinite)) throw new TypeError('STL contains non-finite coordinates');
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      if (sample !== undefined) {
        const vertex = sample * 3 + corner, target = vertex * 3;
        positions[target] = x; positions[target + 1] = y; positions[target + 2] = z;
        indices[vertex] = vertex;
      }
    }
  }
  return {
    mesh: { positions, indices },
    axis: {
      origin: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      direction: [0, 0, 1], planeX: [1, 0, 0], planeY: [0, 1, 0],
    },
    layers: [],
  };
}

export async function createStlPresentationPayloadAsync(
  bytes: ArrayBuffer,
  yieldControl: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<OutlinePreviewPayload> {
  if (bytes.byteLength < 84) return createStlPresentationPayload(bytes);
  const view = new DataView(bytes);
  const triangleCount = view.getUint32(80, true);
  if (triangleCount === 0 || 84 + triangleCount * 50 !== bytes.byteLength) {
    return createStlPresentationPayload(bytes);
  }
  const sampleCount = Math.min(triangleCount, MAX_PRESENTATION_TRIANGLES);
  const positions = new Float32Array(sampleCount * 9);
  const indices = new Uint32Array(sampleCount * 3);
  const sampled = new Map<number, number>();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    sampled.set(sampleCount <= 1 ? 0 : Math.round(sample * (triangleCount - 1) / (sampleCount - 1)), sample);
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if ((triangle & 4095) === 0) await yieldControl();
    const sample = sampled.get(triangle);
    const triangleOffset = 84 + triangle * 50 + 12;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = triangleOffset + corner * 12;
      const x = view.getFloat32(offset, true), y = view.getFloat32(offset + 4, true), z = view.getFloat32(offset + 8, true);
      if (![x, y, z].every(Number.isFinite)) throw new TypeError('STL contains non-finite coordinates');
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      if (sample !== undefined) {
        const vertex = sample * 3 + corner, target = vertex * 3;
        positions[target] = x; positions[target + 1] = y; positions[target + 2] = z;
        indices[vertex] = vertex;
      }
    }
  }
  return {
    mesh: { positions, indices },
    axis: {
      origin: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
      direction: [0, 0, 1], planeX: [1, 0, 0], planeY: [0, 1, 0],
    },
    layers: [],
  };
}

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
  const binary = createBinaryPresentation(bytes);
  if (binary) return binary;
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
