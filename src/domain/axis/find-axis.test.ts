import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import { findAxisCandidates } from './find-axis';

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
});
