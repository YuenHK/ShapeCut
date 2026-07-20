import type { TriangleMesh } from '../mesh/types';
import type { Axis, Vec3 } from '../types';
import type { OutlineBudgets, OutlineLayerSpec } from './types';

function normalize(direction: Vec3): Vec3 {
  const length = Math.hypot(...direction);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('Outline layers require a finite non-zero axis');
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function projectionBasis(axisDirection: Vec3): readonly [Vec3, Vec3] {
  let leastAligned = 0;
  for (let component = 1; component < 3; component += 1) {
    if (Math.abs(axisDirection[component]) < Math.abs(axisDirection[leastAligned])) leastAligned = component;
  }
  const reference: Vec3 = leastAligned === 0 ? [1, 0, 0] : leastAligned === 1 ? [0, 1, 0] : [0, 0, 1];
  const first = normalize(cross(axisDirection, reference));
  return [first, cross(axisDirection, first)];
}

export function scheduleOutlineLayers(
  mesh: TriangleMesh,
  axis: Axis,
  budgets: OutlineBudgets,
): readonly OutlineLayerSpec[] {
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0
    || mesh.indices.length === 0 || mesh.indices.length % 3 !== 0
    || axis.origin.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Outline layers require a finite non-empty triangle mesh and axis');
  }
  const direction = normalize(axis.direction);
  const [planeU, planeV] = projectionBasis(direction);
  const minima = [Infinity, Infinity, Infinity];
  const maxima = [-Infinity, -Infinity, -Infinity];
  const vertexCount = mesh.positions.length / 3;
  for (const vertex of mesh.indices) {
    if (vertex >= vertexCount) throw new RangeError('Outline layers require valid triangle indices');
    const point: Vec3 = [
      mesh.positions[vertex * 3] - axis.origin[0],
      mesh.positions[vertex * 3 + 1] - axis.origin[1],
      mesh.positions[vertex * 3 + 2] - axis.origin[2],
    ];
    if (point.some((value) => !Number.isFinite(value))) {
      throw new RangeError('Outline layers require finite mesh bounds');
    }
    const projected = [dot(point, planeU), dot(point, planeV), dot(point, direction)];
    for (let component = 0; component < 3; component += 1) {
      minima[component] = Math.min(minima[component], projected[component]);
      maxima[component] = Math.max(maxima[component], projected[component]);
    }
  }
  const extents = minima.map((minimum, component) => maxima[component] - minimum);
  if (extents.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Outline layers require non-zero-volume mesh bounds');
  }

  const [planarWidth, planarHeight, axialHeight] = extents;
  const planarDiameter = Math.hypot(planarWidth, planarHeight);
  const requestedLayers = Math.ceil(12 * (axialHeight / Math.max(planarDiameter, axialHeight)));
  const layerCount = Math.min(budgets.maxLayers, Math.max(budgets.minLayers, requestedLayers));
  if (mesh.indices.length / 3 * layerCount > budgets.maxTriangleLayerTests) {
    throw new RangeError('Outline layer schedule exceeds the triangle-layer test budget');
  }

  const layers: OutlineLayerSpec[] = [];
  for (let index = 0; index < layerCount; index += 1) {
    const zStart = index === 0 ? minima[2] : layers[index - 1].zEnd;
    const zEnd = index === layerCount - 1
      ? maxima[2]
      : minima[2] + axialHeight * ((index + 1) / layerCount);
    const zMid = zStart / 2 + zEnd / 2;
    if (![zStart, zEnd, zMid].every(Number.isFinite)) {
      throw new RangeError('Outline layers require finite scheduled axial coordinates');
    }
    layers.push({ index, zStart, zEnd, zMid });
  }
  return layers;
}
