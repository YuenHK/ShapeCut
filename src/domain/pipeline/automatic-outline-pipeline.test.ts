import { describe, expect, it, vi } from 'vitest';
import { writeBinarySTL } from '../mesh/write-stl';
import type { TriangleMesh } from '../mesh/types';
import {
  interpenetratingTetrahedra,
  openTetrahedron,
  separatedClosedCylinders,
  tetrahedron,
} from '../../test/mesh-builders';
import {
  AutomaticOutlineError,
  convertAutomatically as convertAutomaticOutline,
  removalEvidenceFingerprint,
  type AutomaticOutlineProgressEvent,
  type AutomaticOutlineProgressStage,
} from './automatic-outline-pipeline';
import * as extraction from '../outline-2.5d/extract';
import { createOutlineAxisBasis } from '../outline-2.5d/raster';
import * as simplification from '../outline-2.5d/simplify';
import { MAX_STL_BYTES } from '../mesh/parse-stl';
import type { OutlinePreviewPayload } from '../outline-features/types';
import { featureEvidenceFingerprint, validateAutomaticColoredResult } from '../outline-features/types';
import { createOutlinePackage } from '../../export/outline-package';

const testMaterial = { id: 'test-material', name: 'Test material', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
function convertAutomatically(request: { readonly bytes: ArrayBuffer }, onProgress?: Parameters<typeof convertAutomaticOutline>[1]) {
  return convertAutomaticOutline({ ...request, material: testMaterial }, onProgress);
}

function cylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -1, 0, 0, 1];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(5 * Math.cos(angle), 5 * Math.sin(angle), -1);
    positions.push(5 * Math.cos(angle), 5 * Math.sin(angle), 1);
  }
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = 2 + index * 2, top = bottom + 1;
    const nextBottom = 2 + next * 2, nextTop = nextBottom + 1;
    indices.push(0, bottom, nextBottom, 1, nextTop, top);
    indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function steppedCylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -3, 0, 0, 3];
  const rings = [
    { radius: 5, z: -3 },
    { radius: 5, z: 0.5 },
    { radius: 3, z: 0.5 },
    { radius: 3, z: 3 },
  ];
  for (const ring of rings) for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(ring.radius * Math.cos(angle), ring.radius * Math.sin(angle), ring.z);
  }
  const ringIndex = (ring: number, index: number) => 2 + ring * segments + index;
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = ringIndex(0, index), nextBottom = ringIndex(0, next);
    const outer = ringIndex(1, index), nextOuter = ringIndex(1, next);
    const inner = ringIndex(2, index), nextInner = ringIndex(2, next);
    const top = ringIndex(3, index), nextTop = ringIndex(3, next);
    indices.push(0, bottom, nextBottom);
    indices.push(bottom, outer, nextOuter, bottom, nextOuter, nextBottom);
    indices.push(outer, inner, nextOuter, nextOuter, inner, nextInner);
    indices.push(inner, top, nextTop, inner, nextTop, nextInner);
    indices.push(1, nextTop, top);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function layerLocalSteppedPrism(): TriangleMesh {
  const profile = [
    [-5, -3], [5, -3], [5, 0.55], [0, 0.55], [0, 0.8], [-5, 0.8],
  ] as const;
  const positions: number[] = [];
  for (const y of [-5, 5]) for (const [x, z] of profile) positions.push(x, y, z);
  const indices: number[] = [];
  const frontFaces = [[0, 1, 2], [0, 2, 3], [0, 3, 5], [3, 4, 5]] as const;
  for (const [a, b, c] of frontFaces) {
    indices.push(a, b, c);
    indices.push(6 + a, 6 + c, 6 + b);
  }
  for (let edge = 0; edge < profile.length; edge += 1) {
    const next = (edge + 1) % profile.length;
    indices.push(edge, 6 + edge, 6 + next, edge, 6 + next, next);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function squareTube(outerSize = 20, innerSize = 4, depth = 2): TriangleMesh {
  const positions: number[] = [];
  for (const [size, z] of [[outerSize, -depth / 2], [outerSize, depth / 2], [innerSize, -depth / 2], [innerSize, depth / 2]]) {
    const half = size / 2;
    positions.push(-half, -half, z, half, -half, z, half, half, z, -half, half, z);
  }
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
  for (let edge = 0; edge < 4; edge += 1) {
    const next = (edge + 1) % 4;
    quad(edge, next, 4 + next, 4 + edge);
    quad(8 + next, 8 + edge, 12 + edge, 12 + next);
    quad(4 + edge, 4 + next, 12 + next, 12 + edge);
    quad(8 + edge, 8 + next, next, edge);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function nonManifoldTetrahedron(): TriangleMesh {
  const base = tetrahedron();
  return {
    positions: new Float64Array([...base.positions, 0.5, 0, 0.5]),
    indices: new Uint32Array([...base.indices, 0, 1, 4]),
  };
}

function scaled(mesh: TriangleMesh, x: number, y: number, z: number): TriangleMesh {
  return {
    positions: new Float64Array(Array.from(mesh.positions, (value, index) => (
      value * (index % 3 === 0 ? x : index % 3 === 1 ? y : z)
    ))),
    indices: mesh.indices.slice(),
  };
}

function translated(mesh: TriangleMesh, x: number, y: number, z: number): TriangleMesh {
  return {
    positions: new Float64Array(Array.from(mesh.positions, (value, index) => (
      value + (index % 3 === 0 ? x : index % 3 === 1 ? y : z)
    ))),
    indices: mesh.indices.slice(),
  };
}

function perforatedLauncherPlate(): TriangleMesh {
  const holes = [0, 120, 240].map((degrees) => {
    const angle = degrees * Math.PI / 180;
    const centerX = Math.cos(angle) * 10, centerY = Math.sin(angle) * 10;
    return { minX: centerX - 1, maxX: centerX + 1, minY: centerY - 0.5, maxY: centerY + 0.5 };
  });
  const xs = [...new Set([-30, 30, ...holes.flatMap(({ minX, maxX }) => [minX, maxX])])].sort((a, b) => a - b);
  const ys = [...new Set([-30, 30, ...holes.flatMap(({ minY, maxY }) => [minY, maxY])])].sort((a, b) => a - b);
  const positions: number[] = [], indices: number[] = [];
  const addBox = (minX: number, minY: number, maxX: number, maxY: number) => {
    const offset = positions.length / 3;
    positions.push(
      minX, minY, -1, maxX, minY, -1, maxX, maxY, -1, minX, maxY, -1,
      minX, minY, 1, maxX, minY, 1, maxX, maxY, 1, minX, maxY, 1,
    );
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    for (const face of faces) indices.push(...face.map((index) => offset + index));
  };
  for (let xIndex = 0; xIndex + 1 < xs.length; xIndex += 1) {
    for (let yIndex = 0; yIndex + 1 < ys.length; yIndex += 1) {
      const minX = xs[xIndex], maxX = xs[xIndex + 1], minY = ys[yIndex], maxY = ys[yIndex + 1];
      const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
      if (holes.some((hole) => centerX > hole.minX && centerX < hole.maxX
        && centerY > hole.minY && centerY < hole.maxY)) continue;
      addBox(minX, minY, maxX, maxY);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function rectangularPrism(width: number, height: number): TriangleMesh {
  const minX = -width / 2, maxX = width / 2, minY = -height / 2, maxY = height / 2;
  const positions = new Float64Array([
    minX, minY, -1, maxX, minY, -1, maxX, maxY, -1, minX, maxY, -1,
    minX, minY, 1, maxX, minY, 1, maxX, maxY, 1, minX, maxY, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

function asymmetricFastenerPlate(): TriangleMesh {
  const cells = [
    { minX: -10, minY: -1, maxX: 2, maxY: 1 },
    { minX: 2, minY: -5, maxX: 10, maxY: 5 },
  ];
  const positions: number[] = [], indices: number[] = [];
  for (const { minX, minY, maxX, maxY } of cells) {
    const offset = positions.length / 3;
    const cell = rectangularPrism(maxX - minX, maxY - minY);
    for (let index = 0; index < cell.positions.length; index += 3) {
      positions.push(
        cell.positions[index] + (minX + maxX) / 2,
        cell.positions[index + 1] + (minY + maxY) / 2,
        cell.positions[index + 2],
      );
    }
    indices.push(...Array.from(cell.indices, (index) => index + offset));
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

describe('automatic outline pipeline', () => {
  it('publishes one reconciled assembly decision before engraving and preview evidence', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(scaled(cylinder(), 8, 8, 1), 'safe') });

    expect(() => validateAutomaticColoredResult(result, Infinity, () => undefined, result.material)).not.toThrow();

    expect(result.assembly.material).toEqual(testMaterial);
    expect(result.assembly.launcher.status).toBe('fallback');
    const topTwo = result.coloredLayers.slice(-2);
    const lower = result.coloredLayers.slice(0, -2);
    if (result.assembly.launcher.status === 'omitted') {
      expect(result.featureWarnings).toContain('無法安全保留原裝發射器相容性，已省略三個發射器開孔');
      expect(result.coloredLayers.every((layer) => layer.launcherCuts.length === 0)).toBe(true);
    } else {
      expect(topTwo.every((layer) => layer.launcherCuts.length === 3)).toBe(true);
      expect(topTwo[1].launcherCuts.map(({ outer }) => outer)).toEqual(topTwo[0].launcherCuts.map(({ outer }) => outer));
      expect(lower.every((layer) => layer.launcherCuts.length === 0)).toBe(true);
    }

    expect(result.assembly.fastener.count).toBeGreaterThanOrEqual(0);
    expect(result.assembly.fastener.count).toBeLessThanOrEqual(3);
    expect(result.coloredLayers.every((layer) => layer.fastenerHoles.length === result.assembly.fastener.count)).toBe(true);
    const firstFasteners = result.coloredLayers[0].fastenerHoles.map(({ outer }) => outer);
    for (const layer of result.coloredLayers.slice(1)) {
      expect(layer.fastenerHoles.map(({ outer }) => outer)).toEqual(firstFasteners);
    }
    const publicIds = result.coloredLayers.flatMap((layer) => [
      layer.id, layer.exterior.id, layer.centralHole?.id,
      ...layer.launcherCuts.map(({ id }) => id), ...layer.fastenerHoles.map(({ id }) => id),
      ...layer.deepFeatures.map(({ id }) => id), ...layer.lightFeatures.map(({ id }) => id),
    ].filter((id): id is string => id !== undefined));
    expect(new Set(publicIds).size).toBe(publicIds.length);

    const top = result.coloredLayers.at(-1)!;
    expect(result.assembly.topFeatures).toEqual({
      retained: { red: top.deepFeatures.length, blue: top.lightFeatures.length },
      omitted: top.diagnostics.depth.omitted ?? { red: 0, blue: 0 },
    });
    expect(result.preview.layers).toEqual(result.coloredLayers);
    const alternateLauncher = {
      ...result,
      assembly: {
        ...result.assembly,
        launcher: result.assembly.launcher.status === 'fallback'
          ? { ...result.assembly.launcher, status: 'detected' as const }
          : result.assembly.launcher,
      },
    };
    if (alternateLauncher.assembly.launcher.status !== result.assembly.launcher.status) {
      expect(featureEvidenceFingerprint(alternateLauncher, undefined, undefined, result.material))
        .not.toBe(result.featureEvidenceFingerprint);
    }
  });

  it('rejects recomputed-fingerprint fastener metadata and geometry forgeries from a genuine result', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(scaled(cylinder(), 8, 8, 1), 'safe') });
    expect(result.assembly.fastener.count).toBe(3);

    const metadataEvidence = {
      ...structuredClone(result),
      assembly: {
        ...result.assembly,
        fastener: {
          ...result.assembly.fastener,
          pathDiameterMm: result.assembly.fastener.pathDiameterMm + 0.01,
        },
      },
    };
    const metadata = { ...metadataEvidence, featureEvidenceFingerprint: featureEvidenceFingerprint(metadataEvidence) };
    expect(() => validateAutomaticColoredResult(metadata, Infinity, () => undefined, result.material))
      .toThrow(/fastener.*path diameter|kerf|material/i);

    const forgedLayers = structuredClone(result).coloredLayers.map((layer) => {
      const holes = layer.fastenerHoles.map((hole, holeIndex) => {
        if (holeIndex !== 0) return hole;
        const outer = hole.outer.map(([x, y], pointIndex) => pointIndex === 0 ? [x + 0.1, y] as const : [x, y] as const);
        const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
        const areaMm2 = Math.abs(outer.reduce((sum, point, index) => {
          const next = outer[(index + 1) % outer.length];
          return sum + point[0] * next[1] - next[0] * point[1];
        }, 0) / 2);
        return {
          ...hole,
          outer,
          boundsMm: {
            minX: Math.min(...xs), minY: Math.min(...ys),
            maxX: Math.max(...xs), maxY: Math.max(...ys),
          },
          areaMm2,
        };
      });
      return { ...layer, fastenerHoles: holes };
    });
    const firstForged = forgedLayers[0].fastenerHoles[0].outer;
    const firstCenter: readonly [number, number] = [
      firstForged.reduce((sum, [x]) => sum + x, 0) / firstForged.length,
      firstForged.reduce((sum, [, y]) => sum + y, 0) / firstForged.length,
    ];
    const geometryEvidence = {
      ...structuredClone(result),
      coloredLayers: forgedLayers,
      preview: { ...result.preview, layers: forgedLayers },
      assembly: {
        ...result.assembly,
        fastener: {
          ...result.assembly.fastener,
          centers: [firstCenter, ...result.assembly.fastener.centers.slice(1)],
        },
      },
    };
    const geometry = { ...geometryEvidence, featureEvidenceFingerprint: featureEvidenceFingerprint(geometryEvidence) };
    expect(() => validateAutomaticColoredResult(geometry, Infinity, () => undefined, result.material))
      .toThrow(/fastener.*(?:48-point|circle|geometry|diameter)/i);
  });

  it('publishes launcher holes detected by actual extraction through the full result contract', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(perforatedLauncherPlate(), 'safe') });
    expect(result.assembly.launcher.status).toBe('detected');
    expect(result.coloredLayers.slice(-2).every((layer) => layer.launcherCuts.length === 3)).toBe(true);
    expect(result.coloredLayers.slice(0, -2).every((layer) => layer.launcherCuts.length === 0)).toBe(true);
    const packaged = await createOutlinePackage(result);
    expect(packaged.cutSvg.match(/-launcher-clearance-/g)).toHaveLength(6);
  }, 20_000);

  it.each([
    ['three', scaled(cylinder(), 8, 8, 1), 3],
    ['two', rectangularPrism(20, 6), 2],
    ['one', asymmetricFastenerPlate(), 1],
    ['zero', rectangularPrism(4, 4), 0],
  ] as const)('produces exactly %s shared fastener holes through actual extraction', async (_label, mesh, count) => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') });
    expect(result.assembly.fastener.count).toBe(count);
    expect(result.coloredLayers.every((layer) => layer.fastenerHoles.length === count)).toBe(true);
    const packaged = await createOutlinePackage(result);
    expect(packaged.cutSvg.match(/-fastener-hole-/g) ?? []).toHaveLength(count * result.coloredLayers.length);
  }, 20_000);

  it('publishes both layer-local depth roles through preview and fingerprint evidence', async () => {
    const result = await convertAutomaticOutline({
      bytes: writeBinarySTL(layerLocalSteppedPrism(), 'safe'),
      material: { ...testMaterial, minWebMm: 100 },
    });
    expect(result.assembly.launcher.status).toBe('omitted');
    expect(result.assembly.fastener.count).toBe(0);
    expect(result.featureWarnings).toEqual(expect.arrayContaining([
      '無法安全保留原裝發射器相容性，已省略三個發射器開孔',
      '無法安全配置 3 mm 固定螺絲孔，已省略螺絲孔',
    ]));
    const featured = result.coloredLayers.filter((layer) => layer.deepFeatures.length > 0 && layer.lightFeatures.length > 0);

    expect(featured.length).toBeGreaterThan(0);
    expect(featured.every((layer) => layer.deepFeatures.every((feature) => feature.role === 'DEEP_RED'))).toBe(true);
    expect(featured.every((layer) => layer.lightFeatures.every((feature) => feature.role === 'LIGHT_BLUE'))).toBe(true);
    expect(featured.every((layer) => (
      layer.diagnostics.depth.redThresholdMm > layer.diagnostics.depth.blueThresholdMm
      && layer.diagnostics.depth.redThresholdMm <= layer.zEnd - layer.zStart + 1e-9
    ))).toBe(true);
    expect(result.preview.layers).toEqual(result.coloredLayers);
    const expectedBasis = createOutlineAxisBasis(result.axis.axis);
    expect(result.preview.axis).toEqual({
      origin: result.axis.axis.origin,
      direction: result.axis.axis.direction,
      planeX: expectedBasis.planeX,
      planeY: expectedBasis.planeY,
    });
    expect(result.featureEvidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('bounds every stepped-mesh depth sample to its own layer slab', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(steppedCylinder(), 'safe') });

    expect(result.coloredLayers.every((layer) => (
      layer.diagnostics.depth.redThresholdMm <= layer.zEnd - layer.zStart + 1e-9
      && layer.diagnostics.depth.blueThresholdMm <= layer.zEnd - layer.zStart + 1e-9
    ))).toBe(true);
    expect(result.coloredLayers.every((layer) => (
      layer.deepFeatures.every((feature) => feature.role === 'DEEP_RED')
    ))).toBe(true);
    expect(result.coloredLayers.every((layer) => (
      layer.lightFeatures.every((feature) => feature.role === 'LIGHT_BLUE')
    ))).toBe(true);
    expect(result.featureEvidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('locally omits flat depth bands with a sanitized contrast warning and fingerprinted omission code', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });

    expect(result.coloredLayers.every((layer) => layer.deepFeatures.length === 0 && layer.lightFeatures.length === 0)).toBe(true);
    expect(result.coloredLayers.every((layer) => (
      layer.diagnostics.depth.omissionCode === 'INSUFFICIENT_CONTRAST'
    ))).toBe(true);
    expect(result.featureWarnings).toContain('表面深度差不足，已省略雕刻特徵');
    expect(result.featureWarnings.join('\n')).not.toMatch(/[\\/@]|[\w.+-]+@[\w.-]+/);
  });

  it('publishes a retained exact hole through colored layers, preview, diagnostics, and fingerprint evidence', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(squareTube(), 'safe') });

    expect(result.mode).toBe('exact');
    expect(result.featureWarnings).toContain('表面深度差不足，已省略雕刻特徵');
    expect(result.coloredLayers).toHaveLength(result.layers.length);
    expect(result.coloredLayers.every((layer) => layer.centralHole?.role === 'CUT_BLACK')).toBe(true);
    expect(result.coloredLayers.every((layer) => layer.diagnostics.hole.status === 'retained')).toBe(true);
    const holes = result.coloredLayers.map((layer) => layer.centralHole?.outer);
    expect(holes.every((hole) => hole !== undefined)).toBe(true);
    for (const hole of holes.slice(1)) expect(hole).toEqual(holes[0]);
    expect(result.preview.layers).toEqual(result.coloredLayers);
    expect(result.featureEvidenceFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('publishes one sanitized feature warning when otherwise-valid layers have no reliable hole', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });

    expect(result.status).toBe('warning');
    expect(result.coloredLayers.every((layer) => layer.centralHole === undefined)).toBe(true);
    expect(result.featureWarnings).toContain('No reliable central axle hole was found; the hole was omitted.');
    expect(result.featureWarnings).toContain('表面深度差不足，已省略雕刻特徵');
    expect(result.featureWarnings[0]).not.toMatch(/[\\/@]|[\w.+-]+@[\w.-]+/);
  });

  it('returns an exact outline for a safe symmetric mesh and preserves complete layer metadata', async () => {
    const progress: AutomaticOutlineProgressEvent[] = [];

    const result = await convertAutomatically(
      { bytes: writeBinarySTL(cylinder(), 'safe') },
      (event) => { progress.push(event); },
    );

    expect(result).toMatchObject({
      mode: 'exact',
      status: 'warning',
      repairAccepted: true,
      axis: { source: 'candidate' },
      warnings: [],
    });
    expect(result.layers).toHaveLength(6);
    expect(result.removedComponentCount).toBe(0);
    expect(result.layers.every((layer) => layer.removedComponentCount === 0)).toBe(true);
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.diagnostics).toMatchObject({ repairDecision: 'accepted', rasterCellSizeMm: null, topology: { triangleCount: 128 } });
    expect(result.diagnostics.layers).toHaveLength(result.layers.length);
    expect(progress.map(({ stage }) => stage)).toEqual([
      'reading', 'analyzing', 'simplifying', 'slicing', 'slicing', 'packaging',
    ]);
    const analyzing = progress.find((event) => event.stage === 'analyzing' && 'preview' in event);
    const slicing = progress.find((event) => event.stage === 'slicing' && 'preview' in event);
    expect(analyzing).toMatchObject({ stage: 'analyzing', preview: { layers: [] } });
    expect(slicing).toMatchObject({ stage: 'slicing', preview: { layers: result.coloredLayers } });
    if (analyzing && 'preview' in analyzing) {
      expect(analyzing.preview.mesh.indices.length).toBeLessThanOrEqual(6_000);
      expect(analyzing.preview.mesh.positions.buffer).not.toBe(result.preview.mesh.positions.buffer);
    }
    if (slicing && 'preview' in slicing) {
      expect(slicing.preview.mesh.positions.buffer).not.toBe(result.preview.mesh.positions.buffer);
      expect(slicing.preview.mesh.indices.buffer).not.toBe(result.preview.mesh.indices.buffer);
    }
  });

  it('samples a bounded analyzing preview across the whole mesh and centers its provisional axis', async () => {
    const stop = new Error('preview captured');
    let analyzing: OutlinePreviewPayload | undefined;
    const mesh = translated(cylinder(2_001), 10_000, -20_000, 30_000);

    await expect(convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') }, (event) => {
      if (event.stage === 'analyzing' && 'preview' in event) {
        analyzing = event.preview;
        throw stop;
      }
    })).rejects.toBe(stop);

    expect(analyzing).toBeDefined();
    if (!analyzing) return;
    const xs = Array.from(analyzing.mesh.positions).filter((_, index) => index % 3 === 0);
    expect(analyzing.mesh.indices).toHaveLength(6_000);
    expect(Math.min(...xs)).toBeLessThan(9_996);
    expect(Math.max(...xs)).toBeGreaterThan(10_004);
    expect(analyzing.axis.origin[0]).toBeCloseTo(10_000, 2);
    expect(analyzing.axis.origin[1]).toBeCloseTo(-20_000, 2);
    expect(analyzing.axis.origin[2]).toBeCloseTo(30_000, 2);
  });

  it.each([
    ['open', scaled(openTetrahedron(), 20, 20, 20)],
    ['non-manifold', scaled(nonManifoldTetrahedron(), 20, 20, 20)],
    ['self-intersecting', scaled(interpenetratingTetrahedra(), 20, 20, 20)],
  ])('returns a warning 2.5D outline for a parseable %s mesh', async (_label, mesh) => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') });

    expect(result.mode).toBe('outline-2.5d');
    expect(result.status).toBe('warning');
    expect(result.repairAccepted).toBe(false);
    expect(result.layers.length).toBeGreaterThan(0);
    expect(result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(result.removedComponentCount);
    expect(result.warnings).toContain('已簡化模型');
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
  });

  it('falls back to projection when a safe mesh has an ambiguous exact slice', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(steppedCylinder(), 'safe') });

    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
    expect(result.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
    expect(result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(result.removedComponentCount);
    expect(result.layers.every((layer) => layer.sourceBoundsMm !== undefined)).toBe(true);
  });

  it('falls back to projection with authentic removal evidence for disconnected closed slices', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(), 'safe') });

    expect(result).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
    expect(result.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
    expect(result.removedComponentCount).toBeGreaterThan(0);
    expect(result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(result.removedComponentCount);
    expect(result.removalEvidenceFingerprint).toBe(removalEvidenceFingerprint(result));
    expect(result.diagnostics.rasterCellSizeMm).toBeGreaterThan(0);
    expect(result.diagnostics.layers.every((item) => item.boundsDriftRatio <= 0.03 && item.areaDriftRatio <= 0.03)).toBe(true);
  });

  it('uses a deterministic shortest-bounds axis with a warning when no candidate is trusted', async () => {
    const input = writeBinarySTL(scaled(openTetrahedron(), 20, 20, 20), 'safe');
    const first = await convertAutomatically({ bytes: input });
    const second = await convertAutomatically({ bytes: input.slice(0) });

    expect(first.axis).toEqual(second.axis);
    expect(first.axis.source).toBe('shortest-bounds');
    expect(first.warnings).toContain('未找到可信旋轉軸，已使用模型最短包圍盒軸');
  });

  it('fails closed with a typed error when no valid projected outline exists', async () => {
    const emptyProjection: TriangleMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 1, 2, 0, 2]),
      indices: new Uint32Array([0, 1, 2]),
    };

    await expect(convertAutomatically({ bytes: writeBinarySTL(emptyProjection, 'safe') }))
      .rejects.toMatchObject({ code: 'NO_OUTLINE' } satisfies Partial<AutomaticOutlineError>);
  });

  it('maps unreadable bytes to a typed invalid STL error', async () => {
    await expect(convertAutomatically({ bytes: new ArrayBuffer(1) }))
      .rejects.toMatchObject({ code: 'INVALID_STL' } satisfies Partial<AutomaticOutlineError>);
  });

  it('fails closed before publishing a preview when finite ASCII coordinates overflow Float32', async () => {
    const source = `solid overflow
facet normal 0 0 1
outer loop
vertex 1e39 0 0
vertex 1e39 1 0
vertex 1e39 0 1
endloop
endfacet
endsolid overflow`;
    const events: AutomaticOutlineProgressEvent[] = [];

    await expect(convertAutomatically(
      { bytes: new TextEncoder().encode(source).buffer as ArrayBuffer },
      (event) => { events.push(event); },
    )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);

    expect(events).toEqual([{ stage: 'reading' }]);
    expect(events.some((event) => 'preview' in event)).toBe(false);
  });

  it('rejects oversized bytes before progress, hashing, or parsing work', async () => {
    const onProgress = vi.fn();
    const forged = { byteLength: MAX_STL_BYTES + 1 } as ArrayBuffer;
    await expect(convertAutomatically({ bytes: forged }, onProgress))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('maps raster budget exhaustion to a typed resource limit error', async () => {
    const oversized = scaled(openTetrahedron(), 2_000, 40, 2);

    await expect(convertAutomatically({ bytes: writeBinarySTL(oversized, 'safe') }))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);
  });

  it('does not reset the overall deadline when exact extraction times out', async () => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => calls++ === 0 ? 0 : 30_001;
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'TIME_LIMIT' } satisfies Partial<AutomaticOutlineError>);
    } finally {
      Date.now = originalNow;
    }
  });

  it('maps deadline expiry during the first bounded preview copy to a typed time limit', async () => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => calls++ < 2 ? 0 : 30_001;
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'TIME_LIMIT' } satisfies Partial<AutomaticOutlineError>);
    } finally {
      Date.now = originalNow;
    }
  });

  it('rejects when the shared deadline expires before preview preparation', async () => {
    const originalNow = Date.now;
    const contourBounds = vi.spyOn(simplification, 'contourBounds');
    let now = 0;
    let callsAtPackaging = -1;
    Date.now = () => now;
    try {
      await expect(convertAutomatically(
        { bytes: writeBinarySTL(cylinder(), 'safe') },
        (event) => {
          if (event.stage === 'packaging') {
            callsAtPackaging = contourBounds.mock.calls.length;
            now = 30_001;
          }
        },
      )).rejects.toMatchObject({ code: 'TIME_LIMIT' } satisfies Partial<AutomaticOutlineError>);
      expect(callsAtPackaging).toBeGreaterThanOrEqual(0);
      expect(contourBounds).toHaveBeenCalledTimes(callsAtPackaging);
    } finally {
      Date.now = originalNow;
      contourBounds.mockRestore();
    }
  });

  it('does not project after exact extraction exhausts a resource limit', async () => {
    const exact = vi.spyOn(extraction, 'extractExactContours')
      .mockImplementationOnce(() => { throw new RangeError('Exact contour exceeds the triangle-layer test budget'); });
    const projected = vi.spyOn(extraction, 'extractProjectedContours');
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' } satisfies Partial<AutomaticOutlineError>);
      expect(projected).not.toHaveBeenCalled();
    } finally {
      exact.mockRestore();
      projected.mockRestore();
    }
  });

  it('awaits packaging progress before resolving', async () => {
    let releasePackaging!: () => void;
    let markPackagingStarted!: () => void;
    const packagingDelivered = new Promise<void>((resolve) => { releasePackaging = resolve; });
    const packagingStarted = new Promise<void>((resolve) => { markPackagingStarted = resolve; });
    let settled = false;
    const conversion = convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }, async (event) => {
      if (event.stage === 'packaging') {
        markPackagingStarted();
        await packagingDelivered;
      }
    });
    const completion = Promise.resolve(conversion);
    void completion.finally(() => { settled = true; });

    await packagingStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releasePackaging();
    await expect(completion).resolves.toMatchObject({ mode: 'exact' });
  });

  it('fails closed when progress delivery rejects', async () => {
    const callbackError = new Error('progress receiver closed');

    await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }, async (event) => {
      if (event.stage === 'packaging') throw callbackError;
    })).rejects.toBe(callbackError);
  });

  it('keeps progress monotonic and emits one bounded preview per supported stage during fallback', async () => {
    const events: AutomaticOutlineProgressEvent[] = [];
    const onProgress = vi.fn((event: AutomaticOutlineProgressEvent) => { events.push(event); });

    await convertAutomatically({ bytes: writeBinarySTL(scaled(openTetrahedron(), 20, 20, 20), 'safe') }, onProgress);

    const stages = events.map(({ stage }) => stage);
    expect(stages).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'slicing', 'packaging']);
    const stageOrder: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
    expect(stages.every((stage, index) => index === 0
      || stageOrder.indexOf(stage) >= stageOrder.indexOf(stages[index - 1]))).toBe(true);
    expect(events.filter((event) => 'preview' in event).map(({ stage }) => stage)).toEqual(['analyzing', 'slicing']);
  });
});
