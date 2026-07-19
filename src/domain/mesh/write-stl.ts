import type { TriangleMesh } from './types';

export type STLRepairMode = 'safe' | 'advanced';

const HEADER_LENGTH = 80;
const BINARY_PREFIX_LENGTH = 84;
const TRIANGLE_RECORD_LENGTH = 50;

/** Writes a standards-compatible binary STL without changing the source mesh. */
export function writeBinarySTL(mesh: TriangleMesh, mode: STLRepairMode): ArrayBuffer {
  validateMesh(mesh);
  if (mode !== 'safe' && mode !== 'advanced') throw new TypeError('STL repair mode must be safe or advanced');

  const triangleCount = mesh.indices.length / 3;
  if (triangleCount === 0) throw new RangeError('Binary STL must contain at least one triangle');
  if (triangleCount > 0xffff_ffff) throw new RangeError('Binary STL triangle count exceeds uint32 capacity');
  const byteLength = BINARY_PREFIX_LENGTH + triangleCount * TRIANGLE_RECORD_LENGTH;
  if (!Number.isSafeInteger(byteLength)) throw new RangeError('Binary STL byte length exceeds safe integer capacity');

  const output = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(output);
  const header = new TextEncoder().encode(`spinner-laser-kit repaired mesh (${mode})`);
  bytes.set(header.subarray(0, HEADER_LENGTH), 0);
  const view = new DataView(output);
  view.setUint32(HEADER_LENGTH, triangleCount, true);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const indexOffset = triangle * 3;
    const a = mesh.indices[indexOffset];
    const b = mesh.indices[indexOffset + 1];
    const c = mesh.indices[indexOffset + 2];
    const recordOffset = BINARY_PREFIX_LENGTH + triangle * TRIANGLE_RECORD_LENGTH;
    const normal = triangleNormal(mesh, a, b, c);
    view.setFloat32(recordOffset, normal[0], true);
    view.setFloat32(recordOffset + 4, normal[1], true);
    view.setFloat32(recordOffset + 8, normal[2], true);
    writeVertex(view, recordOffset + 12, mesh, a);
    writeVertex(view, recordOffset + 24, mesh, b);
    writeVertex(view, recordOffset + 36, mesh, c);
    view.setUint16(recordOffset + 48, 0, true);
  }
  return output;
}

function validateMesh(mesh: TriangleMesh): void {
  if (!(mesh.positions instanceof Float64Array) || mesh.positions.length % 3 !== 0) {
    throw new TypeError('Mesh positions must be a Float64Array of complete xyz coordinates');
  }
  if (!(mesh.indices instanceof Uint32Array) || mesh.indices.length % 3 !== 0) {
    throw new TypeError('Mesh indices must be a Uint32Array of complete triangles');
  }
  const vertexCount = mesh.positions.length / 3;
  for (const coordinate of mesh.positions) {
    if (!Number.isFinite(coordinate) || !Number.isFinite(Math.fround(coordinate))) {
      throw new RangeError('Mesh coordinates must be representable as finite float32 values');
    }
  }
  for (const index of mesh.indices) {
    if (index >= vertexCount) throw new RangeError('Mesh triangle index is outside the vertex buffer');
  }
}

function writeVertex(view: DataView, offset: number, mesh: TriangleMesh, index: number): void {
  const source = index * 3;
  view.setFloat32(offset, mesh.positions[source], true);
  view.setFloat32(offset + 4, mesh.positions[source + 1], true);
  view.setFloat32(offset + 8, mesh.positions[source + 2], true);
}

function triangleNormal(mesh: TriangleMesh, a: number, b: number, c: number): readonly [number, number, number] {
  const ai = a * 3;
  const bi = b * 3;
  const ci = c * 3;
  const abx = mesh.positions[bi] - mesh.positions[ai];
  const aby = mesh.positions[bi + 1] - mesh.positions[ai + 1];
  const abz = mesh.positions[bi + 2] - mesh.positions[ai + 2];
  const acx = mesh.positions[ci] - mesh.positions[ai];
  const acy = mesh.positions[ci + 1] - mesh.positions[ai + 1];
  const acz = mesh.positions[ci + 2] - mesh.positions[ai + 2];
  const x = aby * acz - abz * acy;
  const y = abz * acx - abx * acz;
  const z = abx * acy - aby * acx;
  const length = Math.hypot(x, y, z);
  return length > 0 && Number.isFinite(length) ? [x / length, y / length, z / length] : [0, 0, 0];
}
