import { describe, expect, test } from 'vitest';
import type { Axis, Vec3 } from '../types';
import type { TriangleMesh } from '../mesh/types';
import { sampleLathedProfile } from './profile-sampler';
import type { LathedProfile } from './types';

const direction: Vec3 = [1, 2, 3];
const directionLength = Math.hypot(...direction);
const unitDirection: Vec3 = direction.map((value) => value / directionLength) as unknown as Vec3;
const radialU: Vec3 = [2 / Math.sqrt(5), -1 / Math.sqrt(5), 0];
const radialV: Vec3 = [
  unitDirection[1] * radialU[2] - unitDirection[2] * radialU[1],
  unitDirection[2] * radialU[0] - unitDirection[0] * radialU[2],
  unitDirection[0] * radialU[1] - unitDirection[1] * radialU[0],
];
const obliqueAxis: Axis = { origin: [0, 0, 0], direction, confidence: 1, confirmed: true };

function obliqueLathedSurface(samples: LathedProfile['samples'], segments = 32): TriangleMesh {
  const positions: number[] = [];
  for (const { z, radius } of samples) {
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = segment * Math.PI * 2 / segments;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      positions.push(
        unitDirection[0] * z + radius * (radialU[0] * cosine + radialV[0] * sine),
        unitDirection[1] * z + radius * (radialU[1] * cosine + radialV[1] * sine),
        unitDirection[2] * z + radius * (radialU[2] * cosine + radialV[2] * sine),
      );
    }
  }
  const indices: number[] = [];
  for (let ring = 0; ring + 1 < samples.length; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const a = ring * segments + segment, b = ring * segments + next;
      const c = (ring + 1) * segments + segment, d = (ring + 1) * segments + next;
      indices.push(a, b, c, b, d, c);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

describe('sampleLathedProfile review regressions', () => {
  test('does not let a far repeated-index triangle change a normal frustum profile', () => {
    const base = obliqueLathedSurface([{ z: -10, radius: 2 }, { z: 10, radius: 12 }], 16);
    const positions = new Float64Array(base.positions.length + 3);
    positions.set(base.positions);
    positions.set([1e12, 0, 0], base.positions.length);
    const far = base.positions.length / 3;
    const indices = new Uint32Array(base.indices.length + 3);
    indices.set(base.indices);
    indices.set([far, far, 0], base.indices.length);

    expect(sampleLathedProfile({ positions, indices }, obliqueAxis, 64)).toEqual(sampleLathedProfile(base, obliqueAxis, 64));
  });

  test.each([1_000, 1_200])('clusters ULP-equivalent projections for %i oblique rings', (ringCount) => {
    const samples = Array.from({ length: ringCount }, (_, index) => ({
      z: -30 + 60 * index / (ringCount - 1),
      radius: 8 + Math.sin(index * 0.031) * 0.5,
    }));
    let sampleCount = -1;
    const sampled = sampleLathedProfile(obliqueLathedSurface(samples), obliqueAxis, 64, {
      onStats: (stats: { sampleCount: number }) => { sampleCount = stats.sampleCount; },
    } as never);
    expect(sampled.samples).toHaveLength(sampleCount);
    expect(sampleCount).toBeLessThanOrEqual(ringCount + 64);
  });

  test('keeps a 0.1 mm oblique inward notch while clustering equivalent planes', () => {
    const samples = [
      { z: -12, radius: 20 }, { z: 4.6, radius: 20 }, { z: 4.7, radius: 1 },
      { z: 4.8, radius: 20 }, { z: 12, radius: 20 },
    ];
    const sampled = sampleLathedProfile(obliqueLathedSurface(samples), obliqueAxis, 64);
    const notch = sampled.samples.reduce((closest, sample) => Math.abs(sample.z - 4.7) < Math.abs(closest.z - 4.7) ? sample : closest);
    expect(notch.z).toBeCloseTo(4.7, 10);
    expect(notch.radius).toBeCloseTo(1, 8);
  });

  test('does not cluster a 0.1 mm inward notch across a 1e12 mm axial span', () => {
    const samples = [
      { z: -5e11, radius: 20 }, { z: 0, radius: 20 }, { z: 0.02, radius: 20 },
      { z: 0.04, radius: 20 }, { z: 0.06, radius: 20 }, { z: 0.1, radius: 1 },
      { z: 0.2, radius: 20 }, { z: 5e11, radius: 20 },
    ];
    const sampled = sampleLathedProfile(obliqueLathedSurface(samples), obliqueAxis, 64);
    const centralMinimum = sampled.samples
      .filter(({ z }) => Math.abs(z) < 1)
      .reduce((minimum, { radius }) => Math.min(minimum, radius), Infinity);
    expect(centralMinimum).toBeLessThan(1.01);
  });

  test.each([1e14, 1e15, 1e16])('is stable for the same oblique line shifted by s=%g', (shift) => {
    const mesh = obliqueLathedSurface([
      { z: -12, radius: 3 }, { z: -2, radius: 7 }, { z: 4, radius: 4 }, { z: 12, radius: 6 },
    ], 32);
    const baseline = sampleLathedProfile(mesh, obliqueAxis, 33);
    const shifted = sampleLathedProfile(mesh, { ...obliqueAxis, origin: [shift, shift * 2, shift * 3] }, 33);
    expect(shifted.samples).toHaveLength(baseline.samples.length);
    const maximumError = shifted.samples.reduce((maximum, sample, index) => Math.max(
      maximum,
      Math.abs(sample.z - baseline.samples[index].z),
      Math.abs(sample.radius - baseline.samples[index].radius),
    ), 0);
    expect(maximumError).toBeLessThan(2.4e-7);
  });
});
