import { expose, transfer } from 'comlink';
import { findAxisCandidates } from '../domain/axis/find-axis';
import { generateParts } from '../domain/decomposition/generate-parts';
import { quantizeHeightField } from '../domain/engraving/quantize';
import { inspectMesh } from '../domain/mesh/inspect-mesh';
import { parseSTL } from '../domain/mesh/parse-stl';
import type { GeometryApi, MeshAnalysis } from './geometry-api';
import type { TriangleMesh } from '../domain/mesh/types';

function previewMesh(mesh: TriangleMesh, maximumTriangles = 2_000): TriangleMesh {
  const indexLimit = Math.min(mesh.indices.length, maximumTriangles * 3);
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(indexLimit);
  for (let offset = 0; offset < indexLimit; offset += 1) {
    const source = mesh.indices[offset];
    let target = remap.get(source);
    if (target === undefined) {
      target = remap.size;
      remap.set(source, target);
      positions.push(mesh.positions[source * 3], mesh.positions[source * 3 + 1], mesh.positions[source * 3 + 2]);
    }
    indices[offset] = target;
  }
  return { positions: new Float64Array(positions), indices };
}

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
    const preview = previewMesh(mesh);
    const result: MeshAnalysis = { sourceHash, mesh, previewMesh: preview, inspection: inspectMesh(mesh) };
    return transfer(result, [mesh.positions.buffer, mesh.indices.buffer, preview.positions.buffer, preview.indices.buffer]);
  },
  async inspectAndFindAxes(input) {
    const sourceHash = hashBuffer(input);
    const mesh = parseSTL(input);
    const inspection = inspectMesh(mesh);
    const preview = previewMesh(mesh);
    const invalidTopology = inspection.boundaryEdgeCount > 0 || inspection.nonManifoldEdgeCount > 0;
    const candidates = invalidTopology ? [] : findAxisCandidates(mesh, { sampleCount: 4096 });
    return transfer({ sourceHash, previewMesh: preview, inspection, candidates }, [preview.positions.buffer, preview.indices.buffer]);
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
