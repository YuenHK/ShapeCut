import { describe, expect, it, vi } from 'vitest';
import { writeBinarySTL } from '../mesh/write-stl';
import type { TriangleMesh } from '../mesh/types';
import {
  openTetrahedron,
  separatedClosedCylinders,
} from '../../test/mesh-builders';
import {
  AutomaticOutlineError,
  convertAutomatically as convertAutomaticOutline,
  type AutomaticOutlineProgressEvent,
  type AutomaticOutlineProgressStage,
} from './automatic-outline-pipeline';
import * as extraction from '../outline-2.5d/extract';
import { createOutlineAxisBasis } from '../outline-2.5d/raster';
import * as simplification from '../outline-2.5d/simplify';
import { MAX_STL_BYTES } from '../mesh/parse-stl';
import type { FeatureContour, OutlinePreviewPayload } from '../outline-features/types';
import { featureEvidenceFingerprint, validateAutomaticColoredResult } from '../outline-features/types';
import { validateDepthFeatureContours } from '../outline-features/validate';
import { createOutlinePackage } from '../../export/outline-package';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../outline-assembly/launcher-template';
import { planFixedLauncherClearance } from '../outline-assembly/launcher';
import { expandLauncherExterior } from '../outline-assembly/launcher-exterior-expansion';
import { PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING } from '../outline-features/depth-field';

const testMaterial = { id: 'test-material', name: 'Test material', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
function convertAutomatically(request: { readonly bytes: ArrayBuffer }, onProgress?: Parameters<typeof convertAutomaticOutline>[1]) {
  return convertAutomaticOutline({ ...request, material: testMaterial, launcherFitOffsetMm: 0 }, onProgress);
}

function cylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -1, 0, 0, 1];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), -1);
    positions.push(30 * Math.cos(angle), 30 * Math.sin(angle), 1);
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
    { radius: 40, z: -3 },
    { radius: 40, z: 0.5 },
    { radius: 30, z: 0.5 },
    { radius: 30, z: 3 },
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

function squareTube(outerSize = 60, innerSize = 4, depth = 2): TriangleMesh {
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

function openCylinder(): TriangleMesh {
  const base = cylinder();
  return { positions: base.positions, indices: base.indices.slice(0, -3) };
}

function nonManifoldCylinder(): TriangleMesh {
  const base = cylinder();
  const extraVertex = base.positions.length / 3;
  return {
    positions: new Float64Array([...base.positions, 0, 0, 0]),
    indices: new Uint32Array([...base.indices, 2, 3, extraVertex]),
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

function openSquarePlate(): TriangleMesh {
  const plate = rectangularPrism(60, 60);
  return { positions: plate.positions, indices: plate.indices.slice(0, -3) };
}

describe('automatic outline pipeline', () => {
  it('publishes one reconciled assembly decision before engraving and preview evidence', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });

    expect(() => validateAutomaticColoredResult(result, Infinity, () => undefined, result.material)).not.toThrow();

    expect(result.assembly.material).toEqual(testMaterial);
    expect(result.assembly.launcher).toEqual({
      status: 'fixed',
      cutCount: 3,
      templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      rotationRad: expect.any(Number),
      fitOffsetMm: 0,
      finishedAllowanceMm: 0.2,
      exteriorExpansion: {
        mode: 'shared-uniform',
        offsetMm: 0,
        maxOffsetMm: 6,
        affectedLayerIds: [
          result.coloredLayers.at(-2)!.id,
          result.coloredLayers.at(-1)!.id,
        ],
      },
    });
    const topTwo = result.coloredLayers.slice(-2);
    const lower = result.coloredLayers.slice(0, -2);
    expect(topTwo.every((layer) => layer.launcherCuts.length === 3)).toBe(true);
    expect(topTwo[1].launcherCuts.map(({ outer }) => outer)).toEqual(topTwo[0].launcherCuts.map(({ outer }) => outer));
    expect(lower.every((layer) => layer.launcherCuts.length === 0)).toBe(true);

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
      launcherOverlap: {
        clipped: { red: 0, blue: 0 },
        removed: { red: 0, blue: 0 },
      },
    });
    expect(result.preview.layers).toEqual(result.coloredLayers);
    const alternateLauncher = {
      ...result,
      assembly: {
        ...result.assembly,
        launcher: {
          ...result.assembly.launcher,
          rotationRad: (result.assembly.launcher.rotationRad + 0.01) % (Math.PI * 2),
        },
      },
    };
    expect(featureEvidenceFingerprint(alternateLauncher, undefined, undefined, result.material))
      .not.toBe(result.featureEvidenceFingerprint);
  });

  it('carries only the required shared top-two exterior expansion into canonical geometry', async () => {
    const result = await convertAutomatically({
      bytes: writeBinarySTL(rectangularPrism(45, 45), 'safe'),
    });
    const originalColoredLayers = extraction.colorizeExteriorLayers(
      result.layers, 0, Infinity, () => undefined,
    );

    expect(result.assembly.launcher.exteriorExpansion.offsetMm).toBeGreaterThan(0);
    expect(result.assembly.launcher.exteriorExpansion.maxOffsetMm).toBe(6);
    expect(result.coloredLayers.slice(0, -2).map((layer) => layer.exterior.outer))
      .toEqual(originalColoredLayers.slice(0, -2).map((layer) => layer.exterior.outer));
    expect(result.coloredLayers.at(-1)!.exterior.outer)
      .not.toEqual(result.layers.at(-1)!.contour.outer);
    expect(result.coloredLayers.at(-2)!.exterior.outer)
      .not.toEqual(result.layers.at(-2)!.contour.outer);

    const sourceExterior = (index: number): FeatureContour => ({
      id: `${result.layers[index].id}-exterior`,
      role: 'CUT_BLACK',
      outer: result.layers[index].contour.outer,
      boundsMm: simplification.contourBounds(result.layers[index].contour.outer),
      areaMm2: Math.abs(simplification.signedArea(result.layers[index].contour.outer)),
    });
    const topIndex = result.layers.length - 1;
    const secondIndex = result.layers.length - 2;
    const sourceTop = sourceExterior(topIndex);
    const sourceSecond = sourceExterior(secondIndex);
    const top = result.coloredLayers[topIndex];
    const second = result.coloredLayers[secondIndex];
    const centralHole = (id: string): FeatureContour => ({
      id,
      role: 'CUT_BLACK',
      outer: [[-1, -1], [-1, 1], [1, 1], [1, -1]],
      boundsMm: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
      areaMm2: 4,
    });
    const decoration: FeatureContour = {
      id: 'retained-decoration',
      role: 'DEEP_RED',
      outer: [[15, 15], [15, 16], [16, 16], [16, 15]],
      boundsMm: { minX: 15, minY: 15, maxX: 16, maxY: 16 },
      areaMm2: 1,
    };
    const sharedRequest = {
      axisPoint: [0, 0] as const,
      topCentralHole: centralHole('top-central'),
      secondCentralHole: centralHole('second-central'),
      material: testMaterial,
      fitOffsetMm: 0,
      decorationContours: [decoration],
    };
    const requiredPlan = planFixedLauncherClearance({
      ...sharedRequest,
      topExterior: sourceTop,
      secondExterior: sourceSecond,
    });
    const originalSafePlan = planFixedLauncherClearance({
      ...sharedRequest,
      topExterior: expandLauncherExterior(sourceTop, requiredPlan.exteriorExpansion.offsetMm),
      secondExterior: expandLauncherExterior(sourceSecond, requiredPlan.exteriorExpansion.offsetMm),
    });

    expect(originalSafePlan.exteriorExpansion.offsetMm).toBe(0);
    expect(requiredPlan.cuts.map(({ outer }) => outer))
      .toEqual(originalSafePlan.cuts.map(({ outer }) => outer));
    expect(top.launcherCuts.map(({ outer }) => outer))
      .toEqual(requiredPlan.cuts.map(({ outer }) => outer));

    const holeSelections = result.layers.map((_, index) => {
      const hole = index === topIndex
        ? sharedRequest.topCentralHole
        : sharedRequest.secondCentralHole;
      return {
        hole: {
          outer: hole.outer,
          boundsMm: hole.boundsMm,
          areaMm2: hole.areaMm2,
          equivalentDiameterMm: Math.sqrt(4 * hole.areaMm2 / Math.PI),
          axisDistanceMm: 0,
        },
      };
    });
    const depthFeatures = result.layers.map((_, index) => ({
      red: index === topIndex ? sharedRequest.decorationContours : [],
      blue: [],
      diagnostics: {
        cellSizeMm: 0,
        contrastMm: 1,
        redThresholdMm: 0.5,
        blueThresholdMm: 0.25,
        retained: { red: index === topIndex ? 1 : 0, blue: 0 },
        omitted: { red: 0, blue: 0 },
      },
      evidence: { red: [], blue: [] },
    }));
    const requiredBlackCuts = result.layers.map((_, index) => ({
      launcherCuts: index >= secondIndex ? requiredPlan.cuts : [],
      fastenerHoles: [],
      ...(index === topIndex
        ? { exteriorOverride: requiredPlan.expandedTopExterior }
        : index === secondIndex
          ? { exteriorOverride: requiredPlan.expandedSecondExterior }
          : {}),
    }));
    const requiredCanonical = extraction.colorizeExteriorLayers(
      result.layers, 0, Infinity, () => undefined,
      holeSelections, depthFeatures, requiredBlackCuts,
    );
    const originalSafeLayers = result.layers.map((layer, index) => {
      const expanded = index === topIndex
        ? requiredPlan.expandedTopExterior
        : index === secondIndex
          ? requiredPlan.expandedSecondExterior
          : undefined;
      return expanded ? {
        ...layer,
        contour: { outer: expanded.outer, holes: [] as const },
        sourceAreaMm2: expanded.areaMm2,
        simplifiedAreaMm2: expanded.areaMm2,
        sourceBoundsMm: expanded.boundsMm,
      } : layer;
    });
    const originalSafeBlackCuts = result.layers.map((_, index) => ({
      launcherCuts: index >= secondIndex ? originalSafePlan.cuts : [],
      fastenerHoles: [],
    }));
    const originalSafeCanonical = extraction.colorizeExteriorLayers(
      originalSafeLayers, 0, Infinity, () => undefined,
      holeSelections, depthFeatures, originalSafeBlackCuts,
    );

    expect(requiredCanonical.slice(-2).map((layer) => layer.centralHole?.outer))
      .toEqual(originalSafeCanonical.slice(-2).map((layer) => layer.centralHole?.outer));
    expect(requiredCanonical.slice(-2).flatMap((layer) => layer.launcherCuts.map(({ outer }) => outer)))
      .toEqual(originalSafeCanonical.slice(-2).flatMap((layer) => layer.launcherCuts.map(({ outer }) => outer)));
    expect(requiredCanonical.slice(-2).flatMap((layer) => [
      ...layer.deepFeatures.map(({ outer }) => outer),
      ...layer.lightFeatures.map(({ outer }) => outer),
    ])).toEqual(originalSafeCanonical.slice(-2).flatMap((layer) => [
      ...layer.deepFeatures.map(({ outer }) => outer),
      ...layer.lightFeatures.map(({ outer }) => outer),
    ]));
  }, 20_000);

  it('reports a typed error when the required shared expansion exceeds 6.00 mm', async () => {
    await expect(convertAutomatically({
      bytes: writeBinarySTL(rectangularPrism(34, 34), 'safe'),
    })).rejects.toMatchObject({
      code: 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
      message: expect.stringMatching(/required|requires|6\.00 mm/i),
    } satisfies Partial<AutomaticOutlineError>);
  }, 20_000);

  it('rejects recomputed-fingerprint fastener metadata and geometry forgeries from a genuine result', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });
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

  it('uses the fixed launcher when per-model launcher evidence is empty', async () => {
    const emptyEvidence = await convertAutomatically({
      bytes: writeBinarySTL(cylinder(), 'safe'),
    });

    expect(emptyEvidence.coloredLayers.slice(-2).every((layer) => layer.launcherCuts.length === 3)).toBe(true);
    expect(emptyEvidence.coloredLayers.slice(0, -2).every((layer) => layer.launcherCuts.length === 0)).toBe(true);
    const packaged = await createOutlinePackage(emptyEvidence);
    expect(packaged.cutSvg.match(/-launcher-clearance-/g)).toHaveLength(6);
  }, 20_000);

  it('produces three shared fastener holes through compatible actual extraction', async () => {
    const result = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });
    expect(result.assembly.fastener.count).toBe(3);
    expect(result.coloredLayers.every((layer) => layer.fastenerHoles.length === 3)).toBe(true);
    const packaged = await createOutlinePackage(result);
    expect(packaged.cutSvg.match(/-fastener-hole-/g) ?? []).toHaveLength(3 * result.coloredLayers.length);
  }, 20_000);

  it.each([
    ['narrow', rectangularPrism(20, 6)],
    ['small', rectangularPrism(4, 4)],
  ] as const)('reports an expansion-limit error for the %s outline', async (_label, mesh) => {
    await expect(convertAutomatically({ bytes: writeBinarySTL(mesh, 'safe') }))
      .rejects.toMatchObject({
        code: 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
      } satisfies Partial<AutomaticOutlineError>);
  }, 20_000);

  it('gives exact-mode fastener removal envelopes priority over colliding layer-local engraving', async () => {
    const result = await convertAutomaticOutline({
      bytes: writeBinarySTL(scaled(layerLocalSteppedPrism(), 6, 6, 1), 'safe'),
      material: testMaterial,
      launcherFitOffsetMm: 0,
    });
    expect(result.mode).toBe('exact');
    expect(result.assembly.fastener.count).toBe(3);
    const top = result.coloredLayers.at(-1)!;
    expect(top.deepFeatures).toEqual([]);
    expect(top.lightFeatures).toEqual([]);
    expect(result.assembly.topFeatures.launcherOverlap).toEqual({
      clipped: { red: 0, blue: 0 },
      removed: { red: 0, blue: 0 },
    });
    expect(top.diagnostics.depth.omissionCode).toBe('INSUFFICIENT_CONTRAST');
    expect(result.featureWarnings).toContain('表面深度差不足，已省略雕刻特徵');
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

  it('rejects extracted launcher overlap counters that cannot be recomputed from internal evidence', async () => {
    const originalExactExtraction = extraction.extractExactContours;
    const exact = vi.spyOn(extraction, 'extractExactContours').mockImplementationOnce((...args) => {
      const extracted = originalExactExtraction(...args);
      const topIndex = extracted.layers.length - 1;
      const layer = extracted.layers[topIndex];
      const hole = extracted.holeSelections[topIndex].hole?.outer;
      const protection = extracted.blackCuts[topIndex].engravingProtection;
      if (!protection) throw new Error('expected physical cut protection');
      let retained: FeatureContour | undefined;
      for (let y = -24; y <= 24 && !retained; y += 4) {
        for (let x = -24; x <= 24 && !retained; x += 4) {
          const outer = [
            [x - 1, y - 1], [x - 1, y + 1], [x + 1, y + 1], [x + 1, y - 1],
          ] as const;
          const candidate: FeatureContour = {
            id: 'pipeline-launcher-priority-deep',
            role: 'DEEP_RED',
            outer,
            boundsMm: { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 },
            areaMm2: 4,
          };
          const exteriorSafe = validateDepthFeatureContours({
            exterior: layer.contour.outer,
            centralHole: hole,
            red: candidate,
            clearanceMm: protection.exteriorClearanceMm,
          }).ok;
          const cutsSafe = protection.removalEnvelopes.every((envelope) => (
            validateDepthFeatureContours({
              exterior: layer.contour.outer,
              centralHole: envelope,
              red: candidate,
              clearanceMm: protection.requiredClearanceMm,
            }).ok
          ));
          if (exteriorSafe && cutsSafe) retained = candidate;
        }
      }
      if (!retained) throw new Error('expected one safe retained priority feature');
      const topDepth = extracted.depthFeatures[topIndex];
      const depthFeatures = extracted.depthFeatures.map((feature, index) => index === topIndex ? {
        ...feature,
        red: [retained!],
        blue: [],
        warning: undefined,
        omissionCode: undefined,
        diagnostics: {
          ...feature.diagnostics,
          retained: { red: 1, blue: 0 },
          omitted: { red: 0, blue: 0 },
          omissionCode: undefined,
        },
      } : feature);
      return {
        ...extracted,
        depthFeatures,
        launcherDecorationOverlap: {
          clipped: { red: 1, blue: 0 },
          removed: { red: 0, blue: 1 },
        },
      };
    });
    try {
      await expect(convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') }))
        .rejects.toMatchObject({ code: 'NO_OUTLINE' } satisfies Partial<AutomaticOutlineError>);
    } finally {
      exact.mockRestore();
    }
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

  it('derives ordered per-layer protected-work omission evidence without changing black geometry', async () => {
    const originalExactExtraction = extraction.extractExactContours;
    let affectedIndex = -1;
    let expectedBlack: extraction.OutlineExtraction['blackCuts'][number] | undefined;
    let expectedCentralHole: FeatureContour | undefined;
    const exact = vi.spyOn(extraction, 'extractExactContours').mockImplementationOnce((...args) => {
      const extracted = originalExactExtraction(...args);
      affectedIndex = extracted.layers.length - 1;
      expectedBlack = extracted.blackCuts[affectedIndex];
      const selectedHole = extracted.holeSelections[affectedIndex].hole;
      expectedCentralHole = selectedHole ? {
        id: `${extracted.layers[affectedIndex].id}-central-hole`,
        role: 'CUT_BLACK',
        outer: selectedHole.outer,
        boundsMm: selectedHole.boundsMm,
        areaMm2: selectedHole.areaMm2,
      } : undefined;
      const retained: FeatureContour = {
        id: `${extracted.layers[2].id}-deep-retained`,
        role: 'DEEP_RED',
        outer: [[-20, 14], [-20, 15], [-19, 15], [-19, 14]],
        boundsMm: { minX: -20, minY: 14, maxX: -19, maxY: 15 },
        areaMm2: 1,
      };
      const depthFeatures = extracted.depthFeatures.map((feature, index) => {
        if (index === affectedIndex) return {
          ...feature,
          red: [],
          blue: [],
          warning: PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING,
          omissionCode: 'PROTECTED_CUT_WORK_BUDGET' as const,
          diagnostics: {
            cellSizeMm: feature.diagnostics.cellSizeMm,
            contrastMm: 0,
            redThresholdMm: 0,
            blueThresholdMm: 0,
            retained: { red: 0, blue: 0 },
            omitted: { red: 0, blue: 0 },
            omissionCode: 'PROTECTED_CUT_WORK_BUDGET' as const,
          },
          evidence: { red: [], blue: [] },
        };
        if (index === 2) return {
          ...feature,
          red: [retained],
          blue: [],
          warning: undefined,
          omissionCode: undefined,
          diagnostics: {
            ...feature.diagnostics,
            contrastMm: 1,
            redThresholdMm: 1,
            blueThresholdMm: 0,
            retained: { red: 1, blue: 0 },
            omitted: { red: 0, blue: 0 },
            omissionCode: undefined,
          },
        };
        return feature;
      });
      return {
        ...extracted,
        depthFeatures,
        featureWarnings: [...new Set([
          ...extracted.featureWarnings,
          PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING,
        ])],
      };
    });
    try {
      const result = await convertAutomatically({
        bytes: writeBinarySTL(squareTube(), 'safe'),
      });
      const affected = result.coloredLayers[affectedIndex];

      expect(result.decorationOmissionSourceEvidence).toEqual([{
        layerId: affected.id,
        omissionCode: 'PROTECTED_CUT_WORK_BUDGET',
        diagnostics: {
          contrastMm: 0,
          redThresholdMm: 0,
          blueThresholdMm: 0,
          retained: { red: 0, blue: 0 },
          omitted: { red: 0, blue: 0 },
        },
      }]);
      expect(result.assembly.decorationOmissions).toEqual([{
        layerId: affected.id,
        reason: 'protected-cut-work-budget',
        roles: ['DEEP_RED', 'LIGHT_BLUE'],
      }]);
      expect(result.status).toBe('warning');
      expect(result.featureWarnings).toContain(PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING);
      expect(affected.deepFeatures).toEqual([]);
      expect(affected.lightFeatures).toEqual([]);
      expect(affected.diagnostics.depth.omissionCode).toBe('PROTECTED_CUT_WORK_BUDGET');
      expect(expectedBlack?.exteriorOverride).toBeDefined();
      expect(expectedCentralHole).toBeDefined();
      expect(expectedBlack?.launcherCuts.length).toBeGreaterThan(0);
      expect(expectedBlack?.fastenerHoles.length).toBeGreaterThan(0);
      expect(affected.exterior).toEqual(expectedBlack!.exteriorOverride);
      expect(affected.centralHole).toEqual(expectedCentralHole);
      expect(affected.launcherCuts).toEqual(expectedBlack!.launcherCuts);
      expect(affected.fastenerHoles).toEqual(expectedBlack!.fastenerHoles);
      expect(result.coloredLayers.some((layer, index) => (
        index !== affectedIndex && layer.deepFeatures.length + layer.lightFeatures.length > 0
      ))).toBe(true);
      expect(result.featureEvidenceFingerprint).toBe(featureEvidenceFingerprint(result));
    } finally {
      exact.mockRestore();
    }
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
    ['open', openCylinder()],
    ['non-manifold', nonManifoldCylinder()],
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

  it('reports expansion-limit failure for disconnected closed slices whose retained outline is too small', async () => {
    await expect(convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(), 'safe') }))
      .rejects.toMatchObject({
        code: 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
      } satisfies Partial<AutomaticOutlineError>);
  });

  it('uses a deterministic shortest-bounds axis with a warning when no candidate is trusted', async () => {
    const input = writeBinarySTL(openSquarePlate(), 'safe');
    const first = await convertAutomatically({ bytes: input });
    const second = await convertAutomatically({ bytes: input.slice(0) });

    expect(first.axis).toEqual(second.axis);
    expect(first.axis.source).toBe('shortest-bounds');
    expect(first.warnings).toContain('未找到可信旋轉軸，已使用模型最短包圍盒軸');
  }, 20_000);

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

  it('maps deadline expiry during provisional launcher-decoration planning to a typed time limit', async () => {
    const originalNow = Date.now;
    Date.now = () => new Error().stack?.includes('provisionalDepthFeatures') ? 30_001 : 0;
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

    await convertAutomatically({ bytes: writeBinarySTL(openCylinder(), 'safe') }, onProgress);

    const stages = events.map(({ stage }) => stage);
    expect(stages).toEqual(['reading', 'analyzing', 'simplifying', 'slicing', 'slicing', 'packaging']);
    const stageOrder: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
    expect(stages.every((stage, index) => index === 0
      || stageOrder.indexOf(stage) >= stageOrder.indexOf(stages[index - 1]))).toBe(true);
    expect(events.filter((event) => 'preview' in event).map(({ stage }) => stage)).toEqual(['analyzing', 'slicing']);
  });
});
