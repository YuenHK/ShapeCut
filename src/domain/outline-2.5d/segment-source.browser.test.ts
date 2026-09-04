import { describe, expect, it } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import { projectMesh } from './raster';
import { TypeScriptExactSegmentSource, WasmExactSegmentSource } from './segment-source';
import type { OutlineAxisSelection, OutlineLayerSpec } from './types';

const selection: OutlineAxisSelection = {
  source: 'candidate',
  axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
};
const specs: readonly OutlineLayerSpec[] = [
  { index: 0, zStart: -0.5, zMid: 0, zEnd: 0.5 },
];

function cylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -1, 0, 0, 1];
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), -1);
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), 1);
  }
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = 2 + index * 2, top = bottom + 1;
    const nextBottom = 2 + next * 2, nextTop = nextBottom + 1;
    indices.push(0, bottom, nextBottom, 1, nextTop, top);
    indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function combine(...meshes: readonly TriangleMesh[]): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    indices.push(...Array.from(mesh.indices, (index) => index + offset));
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function translated(value: TriangleMesh, x: number, y: number, z = 0): TriangleMesh {
  const positions = value.positions.slice();
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] += x; positions[index + 1] += y; positions[index + 2] += z;
  }
  return { positions, indices: value.indices.slice() };
}
function scaled(value: TriangleMesh, factor: number): TriangleMesh {
  return { positions: Float64Array.from(value.positions, (coordinate) => coordinate * factor), indices: value.indices.slice() };
}

function openCylinder(): TriangleMesh {
  const value = cylinder(16);
  return { positions: value.positions, indices: value.indices.slice(0, -6) };
}

function coplanarSheet(): TriangleMesh {
  return {
    positions: new Float64Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function foldedTangency(): TriangleMesh {
  return {
    positions: new Float64Array([-1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1]),
    indices: new Uint32Array([0, 1, 2, 1, 0, 3]),
  };
}

function withRemoteDegenerate(): TriangleMesh {
  return combine(cylinder(16), {
    positions: new Float64Array([100, 0, 100, 101, 0, 100, 102, 0, 100]),
    indices: new Uint32Array([0, 1, 2]),
  });
}

async function expectEquivalentSegments(
  mesh: TriangleMesh,
  layerSpecs = specs,
  axisSelection: OutlineAxisSelection = selection,
  expectedDifferentialOrigin: 'typescript' | 'wasm' = 'typescript',
): Promise<void> {
  const projected = projectMesh(mesh, axisSelection, Infinity);
  const wasm = await new WasmExactSegmentSource({ compareWithTypeScript: false, minimumWasmWork: 0 })
    .collect(projected, layerSpecs, Date.now() + 10_000, () => undefined);
  const differential = await new WasmExactSegmentSource({ compareWithTypeScript: true, minimumWasmWork: 0 })
    .collect(projected, layerSpecs, Date.now() + 10_000, () => undefined);
  const typescript = await new TypeScriptExactSegmentSource()
    .collect(projected, layerSpecs, Infinity, () => undefined);
  expect(wasm.origin).toBe('wasm');
  expect(differential.origin).toBe(expectedDifferentialOrigin);
  expect(wasm.layers.map(({ segments }) => segments.length))
    .toEqual(typescript.layers.map(({ segments }) => segments.length));
  wasm.layers.forEach((layer, layerIndex) => {
    const canonicalDirection = ([first, second]: typeof layer.segments[number]) => (
      first[0] < second[0] || (first[0] === second[0] && first[1] <= second[1])
        ? [first, second]
        : [second, first]
    );
    const unmatched = typescript.layers[layerIndex].segments.map(([first, second]) => (
      first[0] < second[0] || (first[0] === second[0] && first[1] <= second[1])
        ? [first, second]
        : [second, first]
    ));
    for (const rawSegment of layer.segments) {
      const segment = canonicalDirection(rawSegment);
      const index = unmatched.findIndex((candidate) => segment.flat().every(
        (coordinate, coordinateIndex) => Math.abs(coordinate - candidate.flat()[coordinateIndex]) <= 1e-5,
      ));
      expect(index).toBeGreaterThanOrEqual(0);
      unmatched.splice(index, 1);
    }
    expect(unmatched).toEqual([]);
  });
}

describe('real Chromium exact segment differential', () => {
  it('matches the TypeScript oracle for a closed launcher-compatible cylinder', async () => {
    await expectEquivalentSegments(cylinder());
  });

  it.each([
    ['open', openCylinder()],
    ['duplicate', combine(cylinder(12), cylinder(12))],
    ['stepped', combine(cylinder(12), translated(cylinder(12), 0, 0, 0.25))],
    ['disconnected', combine(cylinder(12), translated(cylinder(12), 100, 0))],
    ['mixed scale', combine(cylinder(12), translated(scaled(cylinder(12), 0.001), 100, 0))],
  ] as const)('matches canonical segment topology for %s geometry', async (_label, value) => {
    await expectEquivalentSegments(value);
  });

  it('matches the original projected TypeScript mesh on a non-Z axis', async () => {
    await expectEquivalentSegments(cylinder(16), specs, {
      source: 'candidate',
      axis: { origin: [0, 0, 0], direction: [1, 0, 0], confidence: 1, confirmed: true },
    }, 'wasm');
  });

  it('uses the shared TS/Rust plane tolerance for a near-plane vertex', async () => {
    const nearPlane = 2 ** -30;
    await expectEquivalentSegments({
      positions: new Float64Array([0, 0, nearPlane, 1, 0, -1, 0, 1, 1]),
      indices: new Uint32Array([0, 1, 2]),
    }, specs, selection, 'wasm');
  });

  it('keeps exact Float32 edge coordinates on the WASM route', async () => {
    await expectEquivalentSegments({
      positions: new Float64Array([
        16_777_216, 0, -1,
        16_777_218, 0, 1,
        16_777_216, 1, 1,
      ]),
      indices: new Uint32Array([0, 1, 2]),
    }, specs, selection, 'wasm');
  });

  it('preselects TypeScript without a worker error when mixed-scale precision is unsafe', async () => {
    const projected = projectMesh(
      combine(cylinder(12), translated(scaled(cylinder(12), 0.001), 10_000, 0)),
      selection,
      Infinity,
    );
    await expect(new WasmExactSegmentSource({ compareWithTypeScript: true, minimumWasmWork: 0 })
      .collect(projected, specs, Date.now() + 10_000, () => undefined))
      .resolves.toMatchObject({ origin: 'typescript' });
  });

  it('matches degenerate diagnostics while retaining the ordinary closed slice', async () => {
    const projected = projectMesh(withRemoteDegenerate(), selection, Infinity);
    const wasm = await new WasmExactSegmentSource({ compareWithTypeScript: true, minimumWasmWork: 0 })
      .collect(projected, specs, Date.now() + 10_000, () => undefined);
    const typescript = await new TypeScriptExactSegmentSource()
      .collect(projected, specs, Infinity, () => undefined);

    expect(wasm.origin).toBe('typescript');
    expect(wasm.diagnostics.degenerateTriangleCount).toBe(1);
    expect(typescript.diagnostics.degenerateTriangleCount).toBe(1);
    expect(wasm.layers.map(({ segments }) => segments.length))
      .toEqual(typescript.layers.map(({ segments }) => segments.length));
  });

  it.each([
    ['coplanar', coplanarSheet(), /coplanar/i],
    ['one-sided non-manifold', foldedTangency(), /shared plane edge.*ambiguous/i],
  ] as const)('fails closed identically for %s evidence', async (_label, value, message) => {
    const projected = projectMesh(value, selection, Infinity);
    await expect(new TypeScriptExactSegmentSource().collect(projected, specs, Infinity, () => undefined))
      .rejects.toThrow(message);
    await expect(new WasmExactSegmentSource({ compareWithTypeScript: true, minimumWasmWork: 0 })
      .collect(projected, specs, Date.now() + 10_000, () => undefined))
      .rejects.toThrow(message);
  });
});
