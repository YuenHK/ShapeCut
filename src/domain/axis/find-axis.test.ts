import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import {
  findAxisCandidates,
  selectRadialSurfaceSamples,
  type AxisCandidate,
} from './find-axis';

type MutableVec3 = [number, number, number];

function lathedSpinner(
  transform: (point: MutableVec3) => MutableVec3 = (point) => point,
): TriangleMesh {
  const profile: ReadonlyArray<readonly [number, number]> = [
    [-2.4, 0.35], [-2, 1.2], [-1.1, 2.8], [0, 3.4], [1.1, 2.8], [2, 1.2], [2.4, 0.35],
  ];
  const segments = 64;
  const points: number[] = [];
  for (const [z, radius] of profile) {
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = 2 * Math.PI * segment / segments;
      points.push(...transform([radius * Math.cos(angle), radius * Math.sin(angle), z]));
    }
  }
  const bottomCenter = points.length / 3;
  points.push(...transform([0, 0, profile[0][0]]));
  const topCenter = points.length / 3;
  points.push(...transform([0, 0, profile.at(-1)![0]]));
  const triangles: number[] = [];
  for (let ring = 0; ring < profile.length - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const lower = ring * segments + segment;
      const lowerNext = ring * segments + next;
      const upper = (ring + 1) * segments + segment;
      const upperNext = (ring + 1) * segments + next;
      triangles.push(lower, lowerNext, upperNext, lower, upperNext, upper);
    }
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    triangles.push(bottomCenter, next, segment);
    const top = (profile.length - 1) * segments;
    triangles.push(topCenter, top + segment, top + next);
  }
  return { positions: new Float64Array(points), indices: new Uint32Array(triangles) };
}

function asymmetricBox(): TriangleMesh {
  const positions = new Float64Array([
    0, 0, 0, 5, 0, 0, 5, 1, 0, 0, 1, 0,
    0, 0, 2, 5, 0, 2, 5, 1, 2, 0, 1, 2,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

function centeredCube(): TriangleMesh {
  const positions = new Float64Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

const obliqueAxis: MutableVec3 = (() => {
  const length = Math.hypot(1, 2, 3);
  return [1 / length, 2 / length, 3 / length];
})();

function orientToObliqueAxis([x, y, z]: MutableVec3): MutableVec3 {
  const u: MutableVec3 = [2 / Math.sqrt(5), -1 / Math.sqrt(5), 0];
  const v: MutableVec3 = [
    obliqueAxis[1] * u[2] - obliqueAxis[2] * u[1],
    obliqueAxis[2] * u[0] - obliqueAxis[0] * u[2],
    obliqueAxis[0] * u[1] - obliqueAxis[1] * u[0],
  ];
  return [
    x * u[0] + y * v[0] + z * obliqueAxis[0],
    x * u[1] + y * v[1] + z * obliqueAxis[1],
    x * u[2] + y * v[2] + z * obliqueAxis[2],
  ];
}

function reverseVertexOrder(mesh: TriangleMesh): TriangleMesh {
  const count = mesh.positions.length / 3;
  const positions = new Float64Array(mesh.positions.length);
  for (let oldIndex = 0; oldIndex < count; oldIndex += 1) {
    positions.set(mesh.positions.slice(oldIndex * 3, oldIndex * 3 + 3), (count - 1 - oldIndex) * 3);
  }
  return {
    positions,
    indices: new Uint32Array(Array.from(mesh.indices, (index) => count - 1 - index)),
  };
}

function reverseTriangleOrder(mesh: TriangleMesh): TriangleMesh {
  const indices = new Uint32Array(mesh.indices.length);
  const triangleCount = mesh.indices.length / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const source = (triangleCount - 1 - triangle) * 3;
    indices.set(mesh.indices.slice(source, source + 3), triangle * 3);
  }
  return { positions: mesh.positions.slice(), indices };
}

function refineTriangles(mesh: TriangleMesh): TriangleMesh {
  const positions = Array.from(mesh.positions);
  const indices: number[] = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    const center = positions.length / 3;
    for (let component = 0; component < 3; component += 1) {
      positions.push((mesh.positions[a * 3 + component] + mesh.positions[b * 3 + component] + mesh.positions[c * 3 + component]) / 3);
    }
    indices.push(a, b, center, b, c, center, c, a, center);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function expectSimilarCandidates(left: AxisCandidate, right: AxisCandidate): void {
  const alignment = Math.abs(left.direction[0] * right.direction[0]
    + left.direction[1] * right.direction[1]
    + left.direction[2] * right.direction[2]);
  expect(alignment).toBeGreaterThan(0.999);
  expect(Math.abs(left.confidence - right.confidence)).toBeLessThan(0.03);
}

describe('findAxisCandidates', () => {
  it('ranks the rotation axis first for a lathed spinner', () => {
    const [best] = findAxisCandidates(lathedSpinner(), { sampleCount: 4096 });
    expect(Math.abs(best.direction[2])).toBeGreaterThan(0.999);
    expect(best.confidence).toBeGreaterThan(0.8);
    expect(best.source).toBe('inertia');
  });

  it.each([
    ['x', ([x, y, z]: MutableVec3): MutableVec3 => [z, y, -x], 0],
    ['y', ([x, y, z]: MutableVec3): MutableVec3 => [x, z, -y], 1],
  ] as const)('finds a spinner rotated onto the %s axis', (_label, rotate, component) => {
    const [best] = findAxisCandidates(lathedSpinner(rotate), { sampleCount: 1024 });
    expect(Math.abs(best.direction[component])).toBeGreaterThan(0.999);
    expect(best.confidence).toBeGreaterThan(0.8);
  });

  it('uses the mass centroid as origin after translation', () => {
    const translated = lathedSpinner(([x, y, z]) => [x + 120, y - 45, z + 8]);
    const [best] = findAxisCandidates(translated, { sampleCount: 1024 });
    expect(best.origin[0]).toBeCloseTo(120, 8);
    expect(best.origin[1]).toBeCloseTo(-45, 8);
    expect(best.origin[2]).toBeCloseTo(8, 8);
    expect(best.confidence).toBeGreaterThan(0.8);
  });

  it('gives an asymmetric mesh a confidence below the confirmation threshold', () => {
    const [best] = findAxisCandidates(asymmetricBox(), { sampleCount: 4096 });
    expect(best.confidence).toBeLessThan(0.8);
  });

  it('does not mistake an equal-extent cube for a rotationally symmetric body', () => {
    const [best] = findAxisCandidates(centeredCube(), { sampleCount: 4096 });
    expect(best.confidence).toBeLessThan(0.8);
  });

  it('is scale-aware across microscopic and very large translated spinners', () => {
    const results = [1e-6, 1, 1e6].map((scale) => findAxisCandidates(
      lathedSpinner(([x, y, z]) => [scale * x + 3 * scale, scale * y - 2 * scale, scale * z + 5 * scale]),
      { sampleCount: 4096 },
    )[0]);
    for (const candidate of results) expect(Math.abs(candidate.direction[2])).toBeGreaterThan(0.999);
    const confidences = results.map(({ confidence }) => confidence);
    expect(Math.max(...confidences) - Math.min(...confidences)).toBeLessThan(0.02);
  });

  it('uses a purely relative eigensolver tolerance across extreme scales', () => {
    const results = [1e-10, 1, 1e10].map((scale) => findAxisCandidates(
      lathedSpinner((point) => {
        const [x, y, z] = orientToObliqueAxis(point);
        return [scale * (x + 4), scale * (y - 7), scale * (z + 2)];
      }),
      { sampleCount: 4096 },
    )[0]);
    for (const candidate of results) {
      const alignment = Math.abs(candidate.direction[0] * obliqueAxis[0]
        + candidate.direction[1] * obliqueAxis[1]
        + candidate.direction[2] * obliqueAxis[2]);
      expect(alignment).toBeGreaterThan(0.999);
    }
    expect(Math.max(...results.map(({ confidence }) => confidence))
      - Math.min(...results.map(({ confidence }) => confidence))).toBeLessThan(0.02);
  });

  it('ignores unreferenced vertices when finding the surface axis', () => {
    const mesh = lathedSpinner();
    const baseline = findAxisCandidates(mesh, { sampleCount: 4096 })[0];
    const positions = new Float64Array(mesh.positions.length + 6);
    positions.set(mesh.positions);
    positions.set([1e100, -1e100, 1e100, -1e100, 1e100, -1e100], mesh.positions.length);
    const withUnreferenced = findAxisCandidates({ positions, indices: mesh.indices }, { sampleCount: 4096 })[0];
    expect(withUnreferenced.direction).toEqual(baseline.direction);
    expect(withUnreferenced.confidence).toBeCloseTo(baseline.confidence, 10);
  });

  it('is invariant to vertex and triangle storage order', () => {
    const mesh = lathedSpinner();
    const baseline = findAxisCandidates(mesh, { sampleCount: 4096 })[0];
    expectSimilarCandidates(baseline, findAxisCandidates(reverseVertexOrder(mesh), { sampleCount: 4096 })[0]);
    expectSimilarCandidates(baseline, findAxisCandidates(reverseTriangleOrder(mesh), { sampleCount: 4096 })[0]);
  });

  it('is stable when the same surface triangles are locally refined', () => {
    const mesh = lathedSpinner();
    const baseline = findAxisCandidates(mesh, { sampleCount: 4096 })[0];
    const refined = findAxisCandidates(refineTriangles(mesh), { sampleCount: 4096 })[0];
    expectSimilarCandidates(baseline, refined);
    expect(refined.confidence).toBeGreaterThan(0.8);
  });

  it('is invariant when the complete tessellation is duplicated', () => {
    const mesh = lathedSpinner();
    const indices = new Uint32Array(mesh.indices.length * 2);
    indices.set(mesh.indices);
    indices.set(mesh.indices, mesh.indices.length);
    expectSimilarCandidates(
      findAxisCandidates(mesh, { sampleCount: 4096 })[0],
      findAxisCandidates({ positions: mesh.positions, indices }, { sampleCount: 4096 })[0],
    );
  });

  it('keeps radial selection within the point budget on a large surface', () => {
    const mesh = lathedSpinner();
    const repeatedTriangleCount = 100_000;
    const indices = new Uint32Array(repeatedTriangleCount * 3);
    for (let triangle = 0; triangle < repeatedTriangleCount; triangle += 1) {
      indices.set(mesh.indices.slice(0, 3), triangle * 3);
    }
    const selection = selectRadialSurfaceSamples(
      { positions: mesh.positions, indices },
      30,
    );
    expect(selection.samples.length).toBeLessThanOrEqual(30);
    expect(selection.selectedTriangleCount).toBeLessThanOrEqual(Math.ceil(30 / 3));
  });

  it('uses collision-safe geometry identity when priority hashes collide', () => {
    const positions = new Float64Array([
      0, 0, 0, 2, 0, 0, 0, 2, 0,
      0, 0, 1, 1, 0, 1, 0, 1, 1,
    ]);
    const indices = new Uint32Array([
      0, 1, 2,
      3, 4, 5,
      2, 0, 1,
    ]);
    let hashCalls = 0;
    const selection = selectRadialSurfaceSamples(
      { positions, indices },
      6,
      { hashFn: () => { hashCalls += 1; return 7; } },
    );
    expect(hashCalls).toBe(3);
    expect(selection.selectedTriangleCount).toBe(2);
    expect(selection.samples).toHaveLength(6);
  });

  it('keeps a low-budget axis and score stable across order and local refinement', () => {
    const mesh = lathedSpinner();
    const baseline = findAxisCandidates(mesh, { sampleCount: 30 })[0];
    const reordered = findAxisCandidates(reverseTriangleOrder(mesh), { sampleCount: 30 })[0];
    const refined = findAxisCandidates(refineTriangles(mesh), { sampleCount: 30 })[0];
    expectSimilarCandidates(baseline, reordered);
    const refinementAlignment = Math.abs(baseline.direction[0] * refined.direction[0]
      + baseline.direction[1] * refined.direction[1]
      + baseline.direction[2] * refined.direction[2]);
    expect(refinementAlignment).toBeGreaterThan(0.999);
    expect(Math.abs(baseline.confidence - refined.confidence)).toBeLessThan(0.15);
  });

  it('does not let axial length hide a non-circular square cross-section', () => {
    const longSquarePrism = centeredCube();
    for (let offset = 2; offset < longSquarePrism.positions.length; offset += 3) {
      longSquarePrism.positions[offset] *= 100;
    }
    expect(findAxisCandidates(longSquarePrism, { sampleCount: 4096 })[0].confidence).toBeLessThan(0.8);
  });

  it('is deterministic and does not mutate the mesh', () => {
    const mesh = lathedSpinner();
    const before = mesh.positions.slice();
    const first = findAxisCandidates(mesh, { sampleCount: 137 });
    const second = findAxisCandidates(mesh, { sampleCount: 137 });
    expect(second).toEqual(first);
    expect(mesh.positions).toEqual(before);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid sampleCount %s',
    (sampleCount) => {
      expect(() => findAxisCandidates(lathedSpinner(), { sampleCount })).toThrow(/sampleCount/);
    },
  );

  it('rejects excessive sample counts', () => {
    expect(() => findAxisCandidates(lathedSpinner(), { sampleCount: 100_001 })).toThrow(/sampleCount/);
  });

  it('rejects non-finite and degenerate mesh input clearly', () => {
    const nonFinite = lathedSpinner();
    nonFinite.positions[0] = Number.NaN;
    expect(() => findAxisCandidates(nonFinite, { sampleCount: 10 })).toThrow(/finite/i);
    expect(() => findAxisCandidates({ positions: new Float64Array(), indices: new Uint32Array() }, { sampleCount: 10 })).toThrow(/volume|degenerate/i);
  });

  it('rejects triangle indices outside the vertex buffer', () => {
    const mesh = lathedSpinner();
    mesh.indices[0] = mesh.positions.length / 3;
    expect(() => findAxisCandidates(mesh, { sampleCount: 10 })).toThrow(/index/i);
  });

  it('rejects an incomplete triangle index buffer with a typed error', () => {
    const mesh = lathedSpinner();
    expect(() => findAxisCandidates(
      { positions: mesh.positions, indices: mesh.indices.slice(0, -1) },
      { sampleCount: 10 },
    )).toThrow(TypeError);
  });
});
