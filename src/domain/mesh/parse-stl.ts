import type { TriangleMesh } from './types';

export class STLParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'STLParseError';
  }
}

export function parseSTL(input: ArrayBuffer | string): TriangleMesh {
  if (typeof input === 'string') return parseASCII(input);
  if (input.byteLength === 0) throw new STLParseError('STL input is empty');

  const prefix = new TextDecoder().decode(input.slice(0, Math.min(input.byteLength, 256))).trimStart();
  if (prefix.startsWith('solid') && /\b(facet|vertex)\b/i.test(prefix)) {
    return parseASCII(new TextDecoder().decode(input));
  }
  return parseBinary(input);
}

function parseASCII(source: string): TriangleMesh {
  if (source.trim().length === 0) throw new STLParseError('STL input is empty');
  const vertices: number[][] = [];
  const vertexPattern = /\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  for (let match = vertexPattern.exec(source); match; match = vertexPattern.exec(source)) {
    const vertex = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!vertex.every(Number.isFinite)) throw new STLParseError('STL contains a non-finite coordinate');
    vertices.push(vertex);
  }
  if (vertices.length === 0) throw new STLParseError('ASCII STL contains no triangles');
  if (vertices.length % 3 !== 0) throw new STLParseError('ASCII STL has an incomplete triangle');
  return indexVertices(vertices);
}

function parseBinary(input: ArrayBuffer): TriangleMesh {
  if (input.byteLength < 84) throw new STLParseError('Binary STL is truncated: missing header or triangle count');
  const view = new DataView(input);
  const triangleCount = view.getUint32(80, true);
  const expectedLength = 84 + triangleCount * 50;
  if (!Number.isSafeInteger(expectedLength) || input.byteLength < expectedLength) {
    throw new STLParseError(`Binary STL is truncated: expected ${expectedLength} bytes, received ${input.byteLength}`);
  }
  if (triangleCount === 0) throw new STLParseError('Binary STL contains no triangles');
  const vertices: number[][] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const triangleOffset = 84 + triangle * 50;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = triangleOffset + 12 + corner * 12;
      const vertex = [
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ];
      if (!vertex.every(Number.isFinite)) throw new STLParseError('STL contains a non-finite coordinate');
      vertices.push(vertex);
    }
  }
  return indexVertices(vertices);
}

function indexVertices(vertices: readonly number[][]): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const indexByPosition = new Map<string, number>();
  for (const vertex of vertices) {
    const key = `${canonical(vertex[0])},${canonical(vertex[1])},${canonical(vertex[2])}`;
    let index = indexByPosition.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      indexByPosition.set(key, index);
      positions.push(vertex[0], vertex[1], vertex[2]);
    }
    indices.push(index);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function canonical(value: number): string {
  return Object.is(value, -0) ? '0' : value.toString();
}
