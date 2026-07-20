import { describe, expect, it } from 'vitest';
import type { Axis } from '../types';
import type { TriangleMesh } from '../mesh/types';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineBudgets } from './types';
import { scheduleOutlineLayers } from './layer-schedule';

function boxMesh(sizeX: number, sizeY: number, sizeZ: number): TriangleMesh {
  const [x, y, z] = [sizeX / 2, sizeY / 2, sizeZ / 2];
  return {
    positions: new Float64Array([
      -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z,
      -x, -y, z, x, -y, z, x, y, z, -x, y, z,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
  };
}

function boxMeshWithAxialRange(zStart: number, zEnd: number): TriangleMesh {
  return {
    positions: new Float64Array([
      -1, -1, zStart, 1, -1, zStart, 1, 1, zStart, -1, 1, zStart,
      -1, -1, zEnd, 1, -1, zEnd, 1, 1, zEnd, -1, 1, zEnd,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
  };
}

const zAxis: Axis = {
  origin: [0, 0, 0],
  direction: [0, 0, 1],
  confidence: 1,
  confirmed: true,
};

function reverseTriangleOrder(mesh: TriangleMesh): TriangleMesh {
  const indices = new Uint32Array(mesh.indices.length);
  const triangleCount = mesh.indices.length / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const source = (triangleCount - triangle - 1) * 3;
    indices.set(mesh.indices.slice(source, source + 3), triangle * 3);
  }
  return { positions: mesh.positions.slice(), indices };
}

describe('scheduleOutlineLayers', () => {
  it('covers the complete axial extent with bounded contiguous layers', () => {
    const layers = scheduleOutlineLayers(boxMesh(6, 8, 4), zAxis, DEFAULT_OUTLINE_BUDGETS);

    expect(layers.length).toBeGreaterThanOrEqual(6);
    expect(layers.length).toBeLessThanOrEqual(24);
    expect(layers[0].zStart).toBeCloseTo(-2);
    expect(layers.at(-1)?.zEnd).toBeCloseTo(2);
    for (let index = 0; index < layers.length; index += 1) {
      expect(layers[index].index).toBe(index);
      expect(layers[index].zMid).toBeCloseTo((layers[index].zStart + layers[index].zEnd) / 2);
      if (index > 0) expect(layers[index].zStart).toBe(layers[index - 1].zEnd);
    }
  });

  it('uses the specified clamped layer-count formula', () => {
    expect(scheduleOutlineLayers(boxMesh(10, 10, 1), zAxis, DEFAULT_OUTLINE_BUDGETS)).toHaveLength(6);
    expect(scheduleOutlineLayers(boxMesh(1, 1, 10), zAxis, DEFAULT_OUTLINE_BUDGETS)).toHaveLength(12);
  });

  it('is deterministic under triangle-order reversal', () => {
    const mesh = boxMesh(6, 8, 4);

    expect(scheduleOutlineLayers(reverseTriangleOrder(mesh), zAxis, DEFAULT_OUTLINE_BUDGETS))
      .toEqual(scheduleOutlineLayers(mesh, zAxis, DEFAULT_OUTLINE_BUDGETS));
  });

  it('keeps finite extreme axial coordinates finite while preserving exact extents', () => {
    const zStart = Number.MAX_VALUE / 2;
    const zEnd = Number.MAX_VALUE;
    const layers = scheduleOutlineLayers(
      boxMeshWithAxialRange(zStart, zEnd),
      zAxis,
      DEFAULT_OUTLINE_BUDGETS,
    );

    expect(layers.every((layer) => Number.isFinite(layer.zStart)
      && Number.isFinite(layer.zEnd)
      && Number.isFinite(layer.zMid))).toBe(true);
    expect(layers).toHaveLength(12);
    expect(layers[0].zStart).toBe(zStart);
    expect(layers.at(-1)?.zEnd).toBe(zEnd);
    for (let index = 0; index < layers.length; index += 1) {
      expect(layers[index].zMid).toBe(layers[index].zStart / 2 + layers[index].zEnd / 2);
      if (index > 0) expect(layers[index].zStart).toBe(layers[index - 1].zEnd);
    }
  });

  it('rejects invalid bounds and triangle-layer work above the budget', () => {
    const empty: TriangleMesh = { positions: new Float64Array(), indices: new Uint32Array() };
    const nonFinite = boxMesh(4, 3, 2);
    nonFinite.positions[0] = Number.POSITIVE_INFINITY;
    const tinyBudget = {
      ...DEFAULT_OUTLINE_BUDGETS,
      maxTriangleLayerTests: 71,
    } as unknown as OutlineBudgets;

    expect(() => scheduleOutlineLayers(empty, zAxis, DEFAULT_OUTLINE_BUDGETS)).toThrow(RangeError);
    expect(() => scheduleOutlineLayers(nonFinite, zAxis, DEFAULT_OUTLINE_BUDGETS)).toThrow(RangeError);
    expect(() => scheduleOutlineLayers(boxMesh(4, 3, 0), zAxis, DEFAULT_OUTLINE_BUDGETS)).toThrow(RangeError);
    expect(() => scheduleOutlineLayers(boxMesh(6, 8, 4), zAxis, tinyBudget)).toThrow(RangeError);
  });
});
