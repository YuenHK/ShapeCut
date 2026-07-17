import type { TriangleMesh } from './types';

export const MAX_STL_BYTES = 128 * 1024 * 1024;
export const MAX_TRIANGLES = 1_000_000;

export class STLParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'STLParseError';
  }
}

export function parseSTL(input: ArrayBuffer | string): TriangleMesh {
  if (typeof input === 'string') {
    assertStringByteLimit(input);
    return parseASCII(input);
  }
  if (input.byteLength === 0) throw new STLParseError('STL input is empty');
  if (input.byteLength > MAX_STL_BYTES) {
    throw new STLParseError(`STL exceeds byte limit of ${MAX_STL_BYTES}`);
  }

  let triangleCount: number | undefined;
  let declaredBinaryLength: number | undefined;
  if (input.byteLength >= 84) {
    triangleCount = new DataView(input).getUint32(80, true);
    declaredBinaryLength = 84 + triangleCount * 50;
    if (declaredBinaryLength === input.byteLength) {
      assertTriangleLimit(triangleCount);
      return parseBinary(input, triangleCount);
    }
  }

  try {
    return parseASCII(new TextDecoder().decode(input));
  } catch (asciiError) {
    if (triangleCount !== undefined && triangleCount > MAX_TRIANGLES) assertTriangleLimit(triangleCount);
    if (declaredBinaryLength !== undefined && declaredBinaryLength > input.byteLength) {
      throw new STLParseError(
        `Binary STL is truncated: expected ${declaredBinaryLength} bytes, received ${input.byteLength}`,
      );
    }
    throw asciiError;
  }
}

function parseASCII(source: string): TriangleMesh {
  if (source.trim().length === 0) throw new STLParseError('STL input is empty');
  const builder = new MeshBuilder();
  let facetCount = 0;
  let vertexCount = 0;
  const tokenPattern = /\bfacet\s+normal\b|\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  for (let match = tokenPattern.exec(source); match; match = tokenPattern.exec(source)) {
    if (match[0].toLowerCase().startsWith('facet')) {
      facetCount += 1;
      if (facetCount > MAX_TRIANGLES) throw new STLParseError(`ASCII STL exceeds triangle limit of ${MAX_TRIANGLES}`);
      continue;
    }
    vertexCount += 1;
    if (vertexCount > MAX_TRIANGLES * 3) {
      throw new STLParseError(`ASCII STL exceeds triangle limit of ${MAX_TRIANGLES}`);
    }
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (![x, y, z].every(Number.isFinite)) throw new STLParseError('STL contains a non-finite coordinate');
    builder.addVertex(x, y, z);
  }
  if (vertexCount === 0) throw new STLParseError('ASCII STL contains no triangles');
  if (vertexCount % 3 !== 0) throw new STLParseError('ASCII STL has an incomplete triangle');
  return builder.finish();
}

function parseBinary(input: ArrayBuffer, triangleCount: number): TriangleMesh {
  assertTriangleLimit(triangleCount);
  const expectedLength = 84 + triangleCount * 50;
  if (input.byteLength !== expectedLength) {
    throw new STLParseError(`Binary STL length mismatch: expected ${expectedLength} bytes, received ${input.byteLength}`);
  }
  if (triangleCount === 0) throw new STLParseError('Binary STL contains no triangles');
  const view = new DataView(input);
  const builder = new MeshBuilder();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const triangleOffset = 84 + triangle * 50;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = triangleOffset + 12 + corner * 12;
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      if (![x, y, z].every(Number.isFinite)) throw new STLParseError('STL contains a non-finite coordinate');
      builder.addVertex(x, y, z);
    }
  }
  return builder.finish();
}

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];
  private readonly indexByPosition = new Map<string, number>();

  addVertex(x: number, y: number, z: number): void {
    const key = `${canonical(x)},${canonical(y)},${canonical(z)}`;
    let index = this.indexByPosition.get(key);
    if (index === undefined) {
      index = this.positions.length / 3;
      this.indexByPosition.set(key, index);
      this.positions.push(x, y, z);
    }
    this.indices.push(index);
  }

  finish(): TriangleMesh {
    return { positions: new Float64Array(this.positions), indices: new Uint32Array(this.indices) };
  }
}

function assertTriangleLimit(triangleCount: number): void {
  if (triangleCount > MAX_TRIANGLES) {
    throw new STLParseError(`STL triangle count ${triangleCount} exceeds limit of ${MAX_TRIANGLES}`);
  }
}

function assertStringByteLimit(source: string): void {
  if (source.length > MAX_STL_BYTES || utf8ByteLength(source) > MAX_STL_BYTES) {
    throw new STLParseError(`STL exceeds byte limit of ${MAX_STL_BYTES}`);
  }
}

function utf8ByteLength(source: string): number {
  let bytes = 0;
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < source.length) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > MAX_STL_BYTES) return bytes;
  }
  return bytes;
}

function canonical(value: number): string {
  return Object.is(value, -0) ? '0' : value.toString();
}
