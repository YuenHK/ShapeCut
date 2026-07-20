import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, type AxisCandidate } from '../axis/find-axis';
import type { TriangleMesh } from '../mesh/types';
import type { Vec3 } from '../types';
import type { OutlineAxisSelection } from './types';

type Bounds3 = {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly extent: Vec3;
};

function finiteMeshBounds(mesh: TriangleMesh): Bounds3 {
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0
    || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) {
    throw new RangeError('Outline axis requires a non-empty triangle mesh');
  }
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const vertexCount = mesh.positions.length / 3;
  for (const vertex of mesh.indices) {
    if (vertex >= vertexCount) throw new RangeError('Outline axis requires valid triangle indices');
    for (let component = 0; component < 3; component += 1) {
      const value = mesh.positions[vertex * 3 + component];
      if (!Number.isFinite(value)) throw new RangeError('Outline axis requires finite mesh bounds');
      minimum[component] = Math.min(minimum[component], value);
      maximum[component] = Math.max(maximum[component], value);
    }
  }
  const extent: Vec3 = [
    maximum[0] - minimum[0],
    maximum[1] - minimum[1],
    maximum[2] - minimum[2],
  ];
  if (extent.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Outline axis requires non-zero-volume mesh bounds');
  }
  return {
    minimum,
    maximum,
    extent,
  };
}

function normalizedCandidate(candidate: AxisCandidate): OutlineAxisSelection | undefined {
  const { direction, origin } = candidate;
  const length = Math.hypot(...direction);
  if (candidate.confidence < AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD
    || !Number.isFinite(candidate.confidence)
    || !Number.isFinite(length) || length === 0
    || origin.some((value) => !Number.isFinite(value))) return undefined;
  return {
    source: 'candidate',
    axis: {
      origin,
      direction: [direction[0] / length, direction[1] / length, direction[2] / length],
      confidence: candidate.confidence,
      confirmed: true,
    },
  };
}

export function selectOutlineAxis(
  mesh: TriangleMesh,
  candidates: readonly AxisCandidate[],
): OutlineAxisSelection {
  const bounds = finiteMeshBounds(mesh);
  for (const candidate of candidates) {
    const selection = normalizedCandidate(candidate);
    if (selection) return selection;
  }

  let shortest = 0;
  for (let component = 1; component < 3; component += 1) {
    if (bounds.extent[component] < bounds.extent[shortest]) shortest = component;
  }
  const direction: Vec3 = shortest === 0 ? [1, 0, 0] : shortest === 1 ? [0, 1, 0] : [0, 0, 1];
  const origin: Vec3 = [
    bounds.minimum[0] + bounds.extent[0] / 2,
    bounds.minimum[1] + bounds.extent[1] / 2,
    bounds.minimum[2] + bounds.extent[2] / 2,
  ];
  return {
    source: 'shortest-bounds',
    axis: { origin, direction, confidence: 0, confirmed: true },
  };
}
