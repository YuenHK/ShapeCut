import { expose, transfer } from 'comlink';
import { findAxisCandidates } from '../domain/axis/find-axis';
import { generateParts } from '../domain/decomposition/generate-parts';
import { quantizeHeightField } from '../domain/engraving/quantize';
import { inspectMesh } from '../domain/mesh/inspect-mesh';
import { parseSTL } from '../domain/mesh/parse-stl';
import type { GeometryApi, MeshAnalysis } from './geometry-api';

function hashBuffer(input: ArrayBuffer): string {
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  const bytes = new Uint8Array(input);
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let hash = lanes[lane];
    for (const byte of bytes) hash = Math.imul(hash ^ (byte + lane * 131), 16777619 + lane * 2) >>> 0;
    lanes[lane] = hash;
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

const geometryApi: GeometryApi = {
  async inspect(input) {
    const sourceHash = hashBuffer(input);
    const mesh = parseSTL(input);
    const result: MeshAnalysis = { sourceHash, mesh, inspection: inspectMesh(mesh) };
    return transfer(result, [mesh.positions.buffer, mesh.indices.buffer]);
  },
  async findAxes(mesh) {
    return findAxisCandidates(mesh, { sampleCount: 4096 });
  },
  async decompose({ profile, material, options }) {
    return generateParts(profile, material, options);
  },
  async engrave({ field, levels, options }) {
    return quantizeHeightField(field, levels, options);
  },
};

expose(geometryApi);
