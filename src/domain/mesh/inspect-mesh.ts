import type { MeshInspection, TriangleMesh } from './types';

const AREA_TOLERANCE_SQUARED = 1e-24;
const VOLUME_TOLERANCE = 1e-12;

export function inspectMesh(mesh: TriangleMesh): MeshInspection {
  const edges = new Map<string, number>();
  let degenerateTriangleCount = 0;
  let signedVolume = 0;

  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    addEdge(edges, a, b);
    addEdge(edges, b, c);
    addEdge(edges, c, a);

    const ax = mesh.positions[a * 3];
    const ay = mesh.positions[a * 3 + 1];
    const az = mesh.positions[a * 3 + 2];
    const bx = mesh.positions[b * 3];
    const by = mesh.positions[b * 3 + 1];
    const bz = mesh.positions[b * 3 + 2];
    const cx = mesh.positions[c * 3];
    const cy = mesh.positions[c * 3 + 1];
    const cz = mesh.positions[c * 3 + 2];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (a === b || b === c || c === a || crossX ** 2 + crossY ** 2 + crossZ ** 2 <= AREA_TOLERANCE_SQUARED) {
      degenerateTriangleCount += 1;
    }
    signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const incidence of edges.values()) {
    if (incidence === 1) boundaryEdgeCount += 1;
    else if (incidence > 2) nonManifoldEdgeCount += 1;
  }
  return {
    triangleCount: Math.floor(mesh.indices.length / 3),
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
    invertedVolume: signedVolume < -VOLUME_TOLERANCE,
  };
}

function addEdge(edges: Map<string, number>, a: number, b: number): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  edges.set(key, (edges.get(key) ?? 0) + 1);
}
