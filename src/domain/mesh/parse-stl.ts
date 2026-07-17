import type { TriangleMesh } from './types';

export type ParseLimits = {
  readonly maxBytes: number;
  readonly maxTriangles: number;
  readonly maxUniqueVertices: number;
};

export const DEFAULT_PARSE_LIMITS: ParseLimits = Object.freeze({
  maxBytes: 128 * 1024 * 1024,
  maxTriangles: 500_000,
  maxUniqueVertices: 300_000,
});

export const MAX_STL_BYTES = DEFAULT_PARSE_LIMITS.maxBytes;
export const MAX_TRIANGLES = DEFAULT_PARSE_LIMITS.maxTriangles;

export class STLParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'STLParseError';
  }
}

export function parseSTL(input: ArrayBuffer | string, limits: ParseLimits = DEFAULT_PARSE_LIMITS): TriangleMesh {
  assertValidLimits(limits);
  if (typeof input === 'string') {
    assertStringByteLimit(input, limits);
    return parseASCII(input, limits);
  }
  if (input.byteLength === 0) throw new STLParseError('STL input is empty');
  if (input.byteLength > limits.maxBytes) {
    throw new STLParseError(`STL exceeds byte limit of ${limits.maxBytes}`);
  }

  let triangleCount: number | undefined;
  let declaredBinaryLength: number | undefined;
  if (input.byteLength >= 84) {
    triangleCount = new DataView(input).getUint32(80, true);
    declaredBinaryLength = 84 + triangleCount * 50;
    if (declaredBinaryLength === input.byteLength) {
      assertTriangleLimit(triangleCount, limits);
      return parseBinary(input, triangleCount, limits);
    }
  }

  try {
    return parseASCII(new TextDecoder().decode(input), limits);
  } catch (asciiError) {
    if (triangleCount !== undefined && triangleCount > limits.maxTriangles) assertTriangleLimit(triangleCount, limits);
    if (declaredBinaryLength !== undefined && declaredBinaryLength > input.byteLength) {
      throw new STLParseError(
        `Binary STL is truncated: expected ${declaredBinaryLength} bytes, received ${input.byteLength}`,
      );
    }
    throw asciiError;
  }
}

function parseASCII(source: string, limits: ParseLimits): TriangleMesh {
  if (source.trim().length === 0) throw new STLParseError('STL input is empty');
  const builder = new MeshBuilder(limits);
  let facetCount = 0;
  let vertexCount = 0;
  const tokenPattern = /\bfacet\s+normal\b|\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  for (let match = tokenPattern.exec(source); match; match = tokenPattern.exec(source)) {
    if (match[0].toLowerCase().startsWith('facet')) {
      facetCount += 1;
      if (facetCount > limits.maxTriangles) {
        throw new STLParseError(`ASCII STL exceeds triangle limit of ${limits.maxTriangles}`);
      }
      continue;
    }
    vertexCount += 1;
    if (vertexCount > limits.maxTriangles * 3) {
      throw new STLParseError(`ASCII STL exceeds triangle limit of ${limits.maxTriangles}`);
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

function parseBinary(input: ArrayBuffer, triangleCount: number, limits: ParseLimits): TriangleMesh {
  assertTriangleLimit(triangleCount, limits);
  const expectedLength = 84 + triangleCount * 50;
  if (input.byteLength !== expectedLength) {
    throw new STLParseError(`Binary STL length mismatch: expected ${expectedLength} bytes, received ${input.byteLength}`);
  }
  if (triangleCount === 0) throw new STLParseError('Binary STL contains no triangles');
  const view = new DataView(input);
  const builder = new MeshBuilder(limits);
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

  constructor(private readonly limits: ParseLimits) {}

  addVertex(x: number, y: number, z: number): void {
    const key = `${canonical(x)},${canonical(y)},${canonical(z)}`;
    let index = this.indexByPosition.get(key);
    if (index === undefined) {
      if (this.indexByPosition.size >= this.limits.maxUniqueVertices) {
        throw new STLParseError(
          `STL unique vertex count exceeds limit of ${this.limits.maxUniqueVertices}; simplify or split the mesh`,
        );
      }
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

function assertTriangleLimit(triangleCount: number, limits: ParseLimits): void {
  if (triangleCount > limits.maxTriangles) {
    throw new STLParseError(`STL triangle count ${triangleCount} exceeds limit of ${limits.maxTriangles}`);
  }
}

function assertStringByteLimit(source: string, limits: ParseLimits): void {
  if (source.length > limits.maxBytes || utf8ByteLength(source, limits.maxBytes) > limits.maxBytes) {
    throw new STLParseError(`STL exceeds byte limit of ${limits.maxBytes}`);
  }
}

function utf8ByteLength(source: string, maxBytes: number): number {
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
    if (bytes > maxBytes) return bytes;
  }
  return bytes;
}

function assertValidLimits(limits: ParseLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new STLParseError(`Invalid parse limit ${name}: expected a non-negative safe integer`);
    }
  }
}

function canonical(value: number): string {
  return Object.is(value, -0) ? '0' : value.toString();
}
