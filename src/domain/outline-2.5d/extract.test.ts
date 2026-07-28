import { describe, expect, test } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../outline-features/hole';
import { PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING } from '../outline-features/depth-field';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineAxisSelection, type OutlineLayerSpec } from './types';
import {
  colorizeExteriorLayers,
  ExactContourAmbiguityError,
  extractExactContours,
  extractProjectedContours,
  outlineBoundsDriftMetrics,
  protectLauncherFromDecorationForTesting,
  setHoleCandidateProbeForTesting,
  type HoleCandidateProbeEvidence,
} from './extract';
import { validateOutlineLayer } from './validate';

const selection: OutlineAxisSelection = {
  source: 'candidate',
  axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 1, confirmed: true },
};
const specs: readonly OutlineLayerSpec[] = [{ index: 0, zStart: -0.5, zEnd: 0.5, zMid: 0 }];

function mesh(positions: readonly number[], indices: readonly number[]): TriangleMesh {
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function box(cx: number, cy: number, width: number, height: number, depth = 2, omitFace = -1, zCenter = 0): TriangleMesh {
  const x0 = cx - width / 2, x1 = cx + width / 2;
  const y0 = cy - height / 2, y1 = cy + height / 2;
  const z0 = zCenter - depth / 2, z1 = zCenter + depth / 2;
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const faces = [
    [0, 2, 1, 0, 3, 2], [4, 5, 6, 4, 6, 7],
    [0, 1, 5, 0, 5, 4], [1, 2, 6, 1, 6, 5],
    [2, 3, 7, 2, 7, 6], [3, 0, 4, 3, 4, 7],
  ];
  return mesh(positions, faces.filter((_, index) => index !== omitFace).flat());
}

function combine(...meshes: readonly TriangleMesh[]): TriangleMesh {
  const positions: number[] = [], indices: number[] = [];
  for (const part of meshes) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    indices.push(...Array.from(part.indices, (index) => index + offset));
  }
  return mesh(positions, indices);
}

function sheet(cx: number, cy: number, width: number, height: number, z = 0): TriangleMesh {
  const x0 = cx - width / 2, x1 = cx + width / 2, y0 = cy - height / 2, y1 = cy + height / 2;
  return mesh([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], [0, 1, 2, 0, 2, 3]);
}

function reverseTriangleOrder(value: TriangleMesh): TriangleMesh {
  const triangles: number[][] = [];
  for (let index = 0; index < value.indices.length; index += 3) triangles.push(Array.from(value.indices.slice(index, index + 3)));
  return mesh(Array.from(value.positions), triangles.reverse().flat());
}

function squareTube(outerSize: number, innerSize: number, depth = 2, zCenter = 0): TriangleMesh {
  const positions: number[] = [];
  const rings = [
    { size: outerSize, z: zCenter - depth / 2 }, { size: outerSize, z: zCenter + depth / 2 },
    { size: innerSize, z: zCenter - depth / 2 }, { size: innerSize, z: zCenter + depth / 2 },
  ];
  for (const { size, z } of rings) {
    const h = size / 2;
    positions.push(-h, -h, z, h, -h, z, h, h, z, -h, h, z);
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
  return mesh(positions, indices);
}

function squareFrame(outerSize: number, innerSize: number, z: number): TriangleMesh {
  const strip = (outerSize - innerSize) / 2;
  const offset = (outerSize + innerSize) / 4;
  return combine(
    sheet(0, -offset, outerSize, strip, z),
    sheet(0, offset, outerSize, strip, z),
    sheet(-offset, 0, strip, innerSize, z),
    sheet(offset, 0, strip, innerSize, z),
  );
}

const separatedSpecs: readonly OutlineLayerSpec[] = [
  { index: 0, zStart: -2.4, zEnd: -1.6, zMid: -2 },
  { index: 1, zStart: 1.6, zEnd: 2.4, zMid: 2 },
];

function expectBoundedProbeEvidence(
  evidence: readonly HoleCandidateProbeEvidence[],
  extractionMode: HoleCandidateProbeEvidence['extractionMode'],
): void {
  expect(evidence).toHaveLength(separatedSpecs.length);
  expect(evidence.map(({ layerId }) => layerId)).toEqual(['outline-layer-0', 'outline-layer-1']);
  expect(evidence.every((item) => item.extractionMode === extractionMode && item.candidates.length <= 64)).toBe(true);
}

function bounds(points: readonly (readonly [number, number])[]) {
  return {
    minX: Math.min(...points.map(([x]) => x)), maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)), maxY: Math.max(...points.map(([, y]) => y)),
  };
}

describe('extractProjectedContours', () => {
  test('rejects unordered or overlapping layer slabs before top-layer feature limits are assigned', () => {
    const unordered = [
      { index: 1, zStart: 0.5, zMid: 0.75, zEnd: 1 },
      { index: 0, zStart: -1, zMid: -0.75, zEnd: -0.5 },
    ];
    const overlapping = [
      { index: 0, zStart: -1, zMid: -0.25, zEnd: 0.5 },
      { index: 1, zStart: 0.25, zMid: 0.75, zEnd: 1 },
    ];

    expect(() => extractProjectedContours(box(0, 0, 20, 20, 2), selection, unordered, DEFAULT_OUTLINE_BUDGETS))
      .toThrow(/ordered|overlap/i);
    expect(() => extractProjectedContours(box(0, 0, 20, 20, 2), selection, overlapping, DEFAULT_OUTLINE_BUDGETS))
      .toThrow(/ordered|overlap/i);
  });

  test('accepts ordered layers with the lower/top 1/12 feature caps', () => {
    const ordered = [
      { index: 0, zStart: -1, zMid: -0.75, zEnd: -0.5 },
      { index: 1, zStart: 0.5, zMid: 0.75, zEnd: 1 },
    ];
    const result = extractProjectedContours(box(0, 0, 20, 20, 3), selection, ordered, DEFAULT_OUTLINE_BUDGETS);

    expect(result.depthFeatures[0].red.length).toBeLessThanOrEqual(1);
    expect(result.depthFeatures[0].blue.length).toBeLessThanOrEqual(1);
    expect(result.depthFeatures[1].red.length).toBeLessThanOrEqual(12);
    expect(result.depthFeatures[1].blue.length).toBeLessThanOrEqual(12);
  });

  test('localizes protected-cut work exhaustion to the affected ordered layer', () => {
    const ordered = [
      { index: 0, zStart: -1, zMid: -0.75, zEnd: -0.5 },
      { index: 1, zStart: 0.5, zMid: 0.75, zEnd: 1 },
    ];
    const protectedEnvelope = Array.from({ length: 1_000 }, (_, index) => {
      const angle = index * Math.PI * 2 / 1_000;
      return [Math.cos(angle), Math.sin(angle)] as const;
    });

    const result = extractProjectedContours(
      box(0, 0, 20, 20, 3),
      selection,
      ordered,
      DEFAULT_OUTLINE_BUDGETS,
      undefined,
      {
        existingBlackCuts: [
          {
            launcherCuts: [],
            fastenerHoles: [],
            engravingProtection: {
              exteriorClearanceMm: 0,
              removalEnvelopes: [protectedEnvelope],
              requiredClearanceMm: 0,
            },
          },
          { launcherCuts: [], fastenerHoles: [] },
        ],
      },
    );

    expect(result.depthFeatures[0]).toMatchObject({
      red: [],
      blue: [],
      warning: PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING,
      omissionCode: 'PROTECTED_CUT_WORK_BUDGET',
      diagnostics: { omissionCode: 'PROTECTED_CUT_WORK_BUDGET' },
    });
    expect(result.depthFeatures[1].omissionCode).not.toBe('PROTECTED_CUT_WORK_BUDGET');
    expect(result.featureWarnings).toContain(PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING);
  });

  test('preserves supplied black arrays while their contours remain protected from engraving', () => {
    const black = (id: string, minX: number) => ({
      id, role: 'CUT_BLACK' as const,
      outer: [[minX, -1], [minX + 1, -1], [minX + 1, 1], [minX, 1]] as const,
      boundsMm: { minX, minY: -1, maxX: minX + 1, maxY: 1 }, areaMm2: 2,
    });
    const launcher = black('launcher', -4), fastener = black('fastener', 3);
    const extraction = extractProjectedContours(
      box(0, 0, 20, 20, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS, undefined,
      { existingBlackCuts: [{ launcherCuts: [launcher], fastenerHoles: [fastener] }] },
    );
    const [colored] = colorizeExteriorLayers(extraction.layers, 0, Infinity, () => undefined, [], [{
      red: [], blue: [], diagnostics: {
        cellSizeMm: 0.5, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0,
        retained: { red: 0, blue: 0 }, omitted: { red: 0, blue: 0 },
      }, evidence: { red: [], blue: [] },
    }], extraction.blackCuts);

    expect(colored.launcherCuts).toEqual([launcher]);
    expect(colored.fastenerHoles).toEqual([fastener]);
  });

  test('publishes a validated exterior override without mutating extracted source evidence', () => {
    const layer = extractProjectedContours(
      box(0, 0, 20, 20, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS,
    ).layers[0];
    const originalOuter = structuredClone(layer.contour.outer);
    const expandedOuter = [
      [-11, -11], [-11, 11], [11, 11], [11, -11],
    ] as const;
    const expandedExterior = {
      id: `${layer.id}-exterior`,
      role: 'CUT_BLACK' as const,
      outer: expandedOuter,
      boundsMm: bounds(expandedOuter),
      areaMm2: 484,
    };

    const [colored] = colorizeExteriorLayers(
      [layer], 0, Infinity, () => undefined, [], [], [{
        launcherCuts: [],
        fastenerHoles: [],
        exteriorOverride: expandedExterior,
      }],
    );

    expect(colored.exterior).toEqual(expandedExterior);
    expect(layer.contour.outer).toEqual(originalOuter);
  });

  test.each([
    ['wrong ID', (layerId: string) => ({
      id: `${layerId}-other`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [-11, 11], [11, 11], [11, -11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['wrong role', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'DEEP_RED' as const,
      outer: [[-11, -11], [-11, 11], [11, 11], [11, -11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['non-finite geometry', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [-11, 11], [Number.NaN, 11], [11, -11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['self-intersecting geometry', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [11, 11], [-11, 11], [11, -11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['counter-clockwise geometry', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [11, -11], [11, 11], [-11, 11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['non-finite bounds metadata', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [-11, 11], [11, 11], [11, -11]] as const,
      boundsMm: { minX: Number.NaN, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['stale bounds metadata', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [-11, 11], [11, 11], [11, -11]] as const,
      boundsMm: { minX: -10, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 484,
    })],
    ['non-finite area metadata', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [-11, 11], [11, 11], [11, -11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: Number.NaN,
    })],
    ['stale area metadata', (layerId: string) => ({
      id: `${layerId}-exterior`, role: 'CUT_BLACK' as const,
      outer: [[-11, -11], [-11, 11], [11, 11], [11, -11]] as const,
      boundsMm: { minX: -11, minY: -11, maxX: 11, maxY: 11 }, areaMm2: 483,
    })],
  ])('rejects an exterior override with %s', (_label, makeOverride) => {
    const layer = extractProjectedContours(
      box(0, 0, 20, 20, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS,
    ).layers[0];

    expect(() => colorizeExteriorLayers(
      [layer], 0, Infinity, () => undefined, [], [], [{
        launcherCuts: [],
        fastenerHoles: [],
        exteriorOverride: makeOverride(layer.id),
      }],
    )).toThrow(/exterior override|id|role|finite|simple|clockwise|layer|bounds|area|metadata/i);
  });

  test('publishes all ordered depth contours instead of wrapping the feature arrays', () => {
    const layer = extractProjectedContours(box(0, 0, 20, 20, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS).layers[0];
    const feature = (id: string, role: 'DEEP_RED' | 'LIGHT_BLUE', minX: number) => ({
      id,
      role,
      outer: [[minX, 1], [minX + 1, 1], [minX + 1, 2], [minX, 2]] as const,
      boundsMm: { minX, minY: 1, maxX: minX + 1, maxY: 2 },
      areaMm2: 1,
    });
    const [colored] = colorizeExteriorLayers([layer], 0, Infinity, () => undefined, [], [{
      red: [feature('deep-0', 'DEEP_RED', -4), feature('deep-1', 'DEEP_RED', -2)],
      blue: [feature('light-0', 'LIGHT_BLUE', 2), feature('light-1', 'LIGHT_BLUE', 4)],
      diagnostics: {
        cellSizeMm: 0.5, contrastMm: 3, redThresholdMm: 5, blueThresholdMm: 2,
        retained: { red: 2, blue: 2 }, omitted: { red: 0, blue: 0 },
      },
      evidence: { red: [], blue: [] },
    }]);

    expect(colored.deepFeatures.map(({ id }) => id)).toEqual(['deep-0', 'deep-1']);
    expect(colored.lightFeatures.map(({ id }) => id)).toEqual(['light-0', 'light-1']);
  });

  test('classifies a launcher-overlapped red remainder as clipped and an enclosed blue source as removed', () => {
    const layer = extractProjectedContours(
      box(0, 0, 20, 20, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS,
    ).layers[0];
    const feature = (
      id: string,
      role: 'DEEP_RED' | 'LIGHT_BLUE',
      outer: readonly (readonly [number, number])[],
    ) => ({
      id, role, outer, boundsMm: bounds(outer),
      areaMm2: Math.abs(outer.reduce((sum, point, index) => {
        const next = outer[(index + 1) % outer.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) / 2),
    });
    const provisionalRed = feature('provisional-red', 'DEEP_RED', [
      [2, -2], [2, 2], [6, 2], [6, -2],
    ]);
    const provisionalBlue = feature('provisional-blue', 'LIGHT_BLUE', [
      [4.25, -1], [4.25, 1], [5.25, 1], [5.25, -1],
    ]);
    const finalRed = feature('final-red', 'DEEP_RED', [
      [2, -2], [2, 2], [3.5, 2], [3.5, -2],
    ]);
    const launcherOuter = [[4, -3], [6, -3], [6, 3], [4, 3]] as const;
    const launcher = {
      id: 'finished-launcher', role: 'CUT_BLACK' as const, outer: launcherOuter,
      boundsMm: bounds(launcherOuter), areaMm2: 12,
    };
    const diagnostics = {
      cellSizeMm: 0.25, contrastMm: 2, redThresholdMm: 1.5, blueThresholdMm: 0.5,
      retained: { red: 1, blue: 0 }, omitted: { red: 0, blue: 0 },
    };
    const final = {
      red: [finalRed], blue: [], diagnostics, evidence: { red: [], blue: [] },
    };
    const [colored] = colorizeExteriorLayers(
      [layer], 0.25, Infinity, () => undefined, [], [final],
    );

    const decision = protectLauncherFromDecorationForTesting(
      colored,
      {
        red: [provisionalRed], blue: [provisionalBlue], diagnostics,
        evidence: { red: [], blue: [] },
      },
      final,
      [launcher],
      0,
      Infinity,
      () => undefined,
    );

    expect(decision).toMatchObject({
      clipped: { red: 1, blue: 0 },
      removed: { red: 0, blue: 1 },
    });
    expect(decision.deepFeatures).toEqual([finalRed]);
    expect(decision.lightFeatures).toEqual([]);
  });

  test('maps split sources against only the final twelve retained launcher-protected remainders', () => {
    const layer = extractProjectedContours(
      box(0, 0, 40, 40, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS,
    ).layers[0];
    const feature = (
      id: string,
      outer: readonly (readonly [number, number])[],
    ) => ({
      id, role: 'DEEP_RED' as const, outer, boundsMm: bounds(outer),
      areaMm2: Math.abs(outer.reduce((sum, point, index) => {
        const next = outer[(index + 1) % outer.length];
        return sum + point[0] * next[1] - next[0] * point[1];
      }, 0) / 2),
    });
    const provisionalRed = Array.from({ length: 12 }, (_, index) => {
      const minimumY = -18 + index * 3;
      return feature(`provisional-red-${index}`, [
        [2, minimumY], [2, minimumY + 2], [index === 0 ? 8 : 6, minimumY + 2],
        [index === 0 ? 8 : 6, minimumY],
      ]);
    });
    const finalRed = [
      feature('final-red-0-left', [[2, -18], [2, -16], [3.5, -16], [3.5, -18]]),
      feature('final-red-0-right', [[6.5, -18], [6.5, -16], [8, -16], [8, -18]]),
      ...provisionalRed.slice(1, 11).map((_, index) => {
        const minimumY = -15 + index * 3;
        return feature(`final-red-${index + 1}`, [
          [2, minimumY], [2, minimumY + 2], [3.5, minimumY + 2], [3.5, minimumY],
        ]);
      }),
    ];
    expect(finalRed).toHaveLength(12);
    const launcherOuter = [[4, -20], [6, -20], [6, 20], [4, 20]] as const;
    const launcher = {
      id: 'finished-launcher', role: 'CUT_BLACK' as const, outer: launcherOuter,
      boundsMm: bounds(launcherOuter), areaMm2: 80,
    };
    const diagnostics = {
      cellSizeMm: 0.25, contrastMm: 2, redThresholdMm: 1.5, blueThresholdMm: 0.5,
      retained: { red: 12, blue: 0 }, omitted: { red: 1, blue: 0 },
    };
    const final = {
      red: finalRed, blue: [], diagnostics, evidence: { red: [], blue: [] },
    };
    const [colored] = colorizeExteriorLayers(
      [layer], 0.25, Infinity, () => undefined, [], [final],
    );

    const decision = protectLauncherFromDecorationForTesting(
      colored,
      {
        red: provisionalRed, blue: [], diagnostics, evidence: { red: [], blue: [] },
      },
      final,
      [launcher],
      0,
      Infinity,
      () => undefined,
    );

    expect(decision).toMatchObject({
      clipped: { red: 11, blue: 0 },
      removed: { red: 1, blue: 0 },
    });
    expect(decision.deepFeatures).toEqual(finalRed);
  });

  test('retains only bounded provisional top-layer decoration as internal validation evidence', () => {
    const stepped = combine(
      box(-5, 0, 12, 20, 6),
      box(0, 0, 4, 20, 4),
      box(5, 0, 12, 20, 2),
    );
    const fullDepthSpecs = [{ index: 0, zStart: -3, zMid: 0, zEnd: 3 }] as const;
    let decorationContours: readonly unknown[] | undefined;
    const result = extractProjectedContours(
      stepped, selection, fullDepthSpecs, DEFAULT_OUTLINE_BUDGETS, undefined, {
        planBlackCuts: (context) => {
          decorationContours = context.decorationContours;
          return { cuts: [{ launcherCuts: [], fastenerHoles: [] }] };
        },
      },
    );

    expect(decorationContours?.length).toBeGreaterThan(0);
    expect(decorationContours?.length).toBeLessThanOrEqual(24);
    expect(result).not.toHaveProperty('provisionalDepthFeatures');
    expect(result.launcherDecorationEvidence.provisional.red.length).toBeLessThanOrEqual(12);
    expect(result.launcherDecorationEvidence.provisional.blue.length).toBeLessThanOrEqual(12);
    expect(result.blackCuts).not.toHaveProperty('launcherDecorationEvidence');
  });

  test.each([0.1, 0.2, 1])('fails closed when a %s mm projected dimension cannot stay within three percent', (size) => {
    expect(() => extractProjectedContours(box(0, 0, size, size, 2, 3), selection, specs, DEFAULT_OUTLINE_BUDGETS))
      .toThrow(/projected.*drift|three percent|resolution/i);
  });

  test('preserves a resolvable 20 mm projected component within three percent', () => {
    const result = extractProjectedContours(box(0, 0, 20, 20, 2, 3), selection, specs, DEFAULT_OUTLINE_BUDGETS);
    const output = result.layers[0].sourceBoundsMm;
    expect((output.maxX - output.minX) / 20).toBeLessThanOrEqual(1.03);
    expect((output.maxY - output.minY) / 20).toBeLessThanOrEqual(1.03);
  });

  test.each([5, 100])('remote geometry at %s mm cannot hide an unresolved retained component', (offset) => {
    const candidate = combine(box(0, 0, 1, 1, 2, 3), box(offset, offset, 0.1, 0.1, 2, 3));
    expect(() => extractProjectedContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS))
      .toThrow(/component.*drift|resolution|three percent/i);
  });

  test('uses retained-component source evidence while intentionally removing a remote smaller component', () => {
    const candidate = combine(box(0, 0, 20, 20, 2, 3), box(100, 100, 1, 1, 2, 3));
    const result = extractProjectedContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    const source = result.layers[0].sourceBoundsMm;
    expect(source.maxX - source.minX).toBeCloseTo(20, 8);
    expect(source.maxY - source.minY).toBeCloseTo(20, 8);
    expect(result.layers[0].removedComponentCount).toBeGreaterThan(0);
    expect(result.layers[0].boundsDriftRatio).toBeGreaterThan(0);
  });

  test('rejects accumulated opposite-edge drift above three percent', () => {
    const metrics = outlineBoundsDriftMetrics(
      { minX: -9, minY: -9, maxX: 9, maxY: 9 },
      { minX: -9.5, minY: -9.5, maxX: 9.5, maxY: 9.5 },
    );
    expect(metrics.legacyEdge).toBeLessThanOrEqual(0.03);
    expect(metrics.direct).toBeGreaterThan(0.03);
    const candidate = combine(box(0, 0, 18, 18, 2, 3), box(180, 180, 1, 1, 2, 3));
    expect(() => extractProjectedContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/drift|three percent/i);
  });

  test('accepts direct width and height drift at or below three percent', () => {
    const result = extractProjectedContours(box(0, 0, 20, 20, 2, 3), selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers[0].boundsDriftRatio).toBeLessThanOrEqual(0.03 + 1e-12);
  });

  test('keeps the largest component, fills holes, and is deterministic after triangle shuffling', () => {
    const twoComponents = combine(box(0, 0, 20, 12), box(40, 0, 4, 4));
    const first = extractProjectedContours(twoComponents, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    const shuffled = extractProjectedContours(reverseTriangleOrder(twoComponents), selection, specs, DEFAULT_OUTLINE_BUDGETS);

    expect(first).toEqual(shuffled);
    expect(first.removedComponentCount).toBeGreaterThanOrEqual(1);
    expect(first.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(first.removedComponentCount);
    expect(first.layers).toHaveLength(1);
    expect(first.layers[0].contour.holes).toEqual([]);
    expect(validateOutlineLayer(first.layers[0]).ok).toBe(true);
    const selected = bounds(first.layers[0].contour.outer);
    expect(selected.maxX - selected.minX).toBeLessThan(14);
    expect(selected.maxY - selected.minY).toBeLessThan(22);
  });

  test('fills an enclosed projected hole and returns only an exterior contour', () => {
    const frame = combine(
      sheet(0, -4.5, 12, 3), sheet(0, 4.5, 12, 3),
      sheet(-4.5, 0, 3, 7), sheet(4.5, 0, 3, 7),
    );
    const result = extractProjectedContours(frame, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers[0].contour.holes).toEqual([]);
    expect(result.layers[0].sourceAreaMm2).toBeGreaterThan(100);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('retains one reliable projected central void independently of the legacy filled exterior', () => {
    const frame = combine(
      sheet(0, -4.5, 12, 3), sheet(0, 4.5, 12, 3),
      sheet(-4.5, 0, 3, 7), sheet(4.5, 0, 3, 7),
    );
    const first = extractProjectedContours(frame, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    const shuffled = extractProjectedContours(reverseTriangleOrder(frame), selection, specs, DEFAULT_OUTLINE_BUDGETS);

    expect(first.layers[0].contour.holes).toEqual([]);
    expect(first.holeSelections).toEqual(shuffled.holeSelections);
    expect(first.holeSelections[0].hole?.outer.length).toBeGreaterThanOrEqual(4);
    expect(first.holeSelections[0].hole?.axisDistanceMm).toBeLessThan(0.1);
  });

  test('uses the smaller projected void when the largest layer-local candidate is unsafe for a narrowing layer', () => {
    const evidence: HoleCandidateProbeEvidence[] = [];
    setHoleCandidateProbeForTesting((item) => { evidence.push(item); });
    try {
      const candidate = combine(squareFrame(10, 4, -2), squareFrame(4, 1, 2));
      const result = extractProjectedContours(candidate, selection, separatedSpecs, DEFAULT_OUTLINE_BUDGETS);
      const retained = result.holeSelections
        .map((holeSelection) => holeSelection.hole?.outer)
        .filter((outer): outer is NonNullable<typeof outer> => outer !== undefined);

      expectBoundedProbeEvidence(evidence, 'projected');
      expect(retained).toHaveLength(result.layers.length);
      for (const contour of retained.slice(1)) expect(contour).toEqual(retained[0]);
      expect(result.featureWarnings).not.toContain(CENTRAL_HOLE_OMISSION_WARNING);
    } finally {
      setHoleCandidateProbeForTesting(undefined);
    }
  });

  test('omits projected holes from every layer when no candidate fits an incompatible exterior', () => {
    const evidence: HoleCandidateProbeEvidence[] = [];
    setHoleCandidateProbeForTesting((item) => { evidence.push(item); });
    try {
      const candidate = combine(squareFrame(10, 4, -2), sheet(0, 0, 3.5, 3.5, 2));
      const result = extractProjectedContours(candidate, selection, separatedSpecs, DEFAULT_OUTLINE_BUDGETS);

      expectBoundedProbeEvidence(evidence, 'projected');
      expect(result.holeSelections).toHaveLength(result.layers.length);
      expect(result.holeSelections.every(({ hole }) => hole === undefined)).toBe(true);
      expect(result.featureWarnings).toContain(CENTRAL_HOLE_OMISSION_WARNING);
    } finally {
      setHoleCandidateProbeForTesting(undefined);
    }
  });

  test('omits a projected multiply-connected void instead of covering its occupied island with a hole', () => {
    const frameWithIsland = combine(
      sheet(0, -4.5, 12, 3), sheet(0, 4.5, 12, 3),
      sheet(-4.5, 0, 3, 7), sheet(4.5, 0, 3, 7),
      sheet(0, 0, 2, 2),
    );
    const result = extractProjectedContours(frameWithIsland, selection, specs, DEFAULT_OUTLINE_BUDGETS);

    expect(result.holeSelections[0]).toEqual(expect.objectContaining({
      hole: undefined,
      omissionReason: 'NO_RELIABLE_CENTRAL_HOLE',
      warning: expect.stringMatching(/reliable central axle hole/i),
    }));
    expect(result.featureWarnings).toEqual([
      'No reliable central axle hole was found; the hole was omitted.',
      '表面深度資料不足，已省略雕刻特徵',
    ]);
  });

  test.each([
    ['open', box(0, 0, 10, 8, 2, 3)],
    ['self-intersecting', combine(box(-2, 0, 8, 3), box(2, 0, 8, 3))],
    ['overlapping', combine(box(-1, 0, 8, 8), box(1, 0, 8, 8))],
  ])('produces a valid exterior from %s mesh triangles', (_name, candidate) => {
    const result = extractProjectedContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].contour.holes).toEqual([]);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('fails closed for invalid meshes, empty masks, and raster budgets', () => {
    expect(() => extractProjectedContours(mesh([0, 0, Number.NaN], [0, 0, 0]), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow();
    expect(() => extractProjectedContours(box(0, 0, 2, 2), selection, [{ index: 0, zStart: 3, zEnd: 4, zMid: 3.5 }], DEFAULT_OUTLINE_BUDGETS)).toThrow(/empty/i);
    expect(() => extractProjectedContours(box(0, 0, 1_000, 20), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/budget/i);
  });

  test('rejects a layer midpoint outside its public interval', () => {
    expect(() => extractProjectedContours(box(0, 0, 2, 2), selection, [
      { index: 0, zStart: -0.5, zEnd: 0.5, zMid: 0.75 },
    ], DEFAULT_OUTLINE_BUDGETS)).toThrow(/midpoint|zMid|interval/i);
  });
});

describe('extractExactContours', () => {
  test('classifies a strictly nested loop as a reliable central hole', () => {
    const candidate = squareTube(20, 4);
    const first = extractExactContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    const reversed = extractExactContours(reverseTriangleOrder(candidate), selection, specs, DEFAULT_OUTLINE_BUDGETS);

    expect(first.layers[0].contour.holes).toEqual([]);
    expect(first.holeSelections).toEqual(reversed.holeSelections);
    expect(first.holeSelections[0].hole?.equivalentDiameterMm).toBeCloseTo(Math.sqrt(16 * 4 / Math.PI), 8);
    expect(first.holeSelections[0].hole?.axisDistanceMm).toBe(0);
  });

  test('uses the smaller exact hole when the largest layer-local candidate is unsafe for a narrowing layer', () => {
    const evidence: HoleCandidateProbeEvidence[] = [];
    setHoleCandidateProbeForTesting((item) => { evidence.push(item); });
    try {
      const candidate = combine(squareTube(10, 3, 1, -2), squareTube(4, 1, 1, 2));
      const result = extractExactContours(candidate, selection, separatedSpecs, DEFAULT_OUTLINE_BUDGETS);
      const retained = result.holeSelections
        .map((holeSelection) => holeSelection.hole?.outer)
        .filter((outer): outer is NonNullable<typeof outer> => outer !== undefined);

      expectBoundedProbeEvidence(evidence, 'exact');
      expect(retained).toHaveLength(result.layers.length);
      for (const contour of retained.slice(1)) expect(contour).toEqual(retained[0]);
      expect(result.featureWarnings).not.toContain(CENTRAL_HOLE_OMISSION_WARNING);
    } finally {
      setHoleCandidateProbeForTesting(undefined);
    }
  });

  test('omits exact holes from every layer when no candidate fits an incompatible exterior', () => {
    const evidence: HoleCandidateProbeEvidence[] = [];
    setHoleCandidateProbeForTesting((item) => { evidence.push(item); });
    try {
      const candidate = combine(squareTube(10, 3, 1, -2), box(0, 0, 2.5, 2.5, 1, -1, 2));
      const result = extractExactContours(candidate, selection, separatedSpecs, DEFAULT_OUTLINE_BUDGETS);

      expectBoundedProbeEvidence(evidence, 'exact');
      expect(result.holeSelections).toHaveLength(result.layers.length);
      expect(result.holeSelections.every(({ hole }) => hole === undefined)).toBe(true);
      expect(result.featureWarnings).toContain(CENTRAL_HOLE_OMISSION_WARNING);
    } finally {
      setHoleCandidateProbeForTesting(undefined);
    }
  });

  test('keeps two depth-zero loops as ambiguity rather than inventing a hole', () => {
    const twoComponents = combine(box(0, 0, 20, 12), box(40, 0, 4, 4));
    expect(() => extractExactContours(twoComponents, selection, specs, DEFAULT_OUTLINE_BUDGETS))
      .toThrow(/depth-zero|multiple closed loops/i);
  });

  test('rejects nesting deeper than a single hole level', () => {
    const nestedIsland = combine(squareTube(20, 8), box(0, 0, 2, 2));
    expect(() => extractExactContours(nestedIsland, selection, specs, DEFAULT_OUTLINE_BUDGETS))
      .toThrow(/nest|depth|ambigu/i);
  });

  test('records a sanitized omission instead of fabricating a hole in a no-hole layer', () => {
    const result = extractExactContours(box(0, 0, 20, 12), selection, specs, DEFAULT_OUTLINE_BUDGETS);

    expect(result.holeSelections).toEqual([expect.objectContaining({
      hole: undefined,
      omissionReason: 'NO_RELIABLE_CENTRAL_HOLE',
      warning: expect.stringMatching(/reliable central axle hole/i),
    })]);
  });

  test('fails closed instead of silently choosing one disconnected closed slice', () => {
    const twoComponents = combine(box(0, 0, 20, 12), box(40, 0, 4, 4));
    for (const candidate of [twoComponents, reverseTriangleOrder(twoComponents)]) {
      expect(() => extractExactContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS))
        .toThrow(ExactContourAmbiguityError);
      expect(() => extractExactContours(candidate, selection, specs, DEFAULT_OUTLINE_BUDGETS))
        .toThrow(/multiple closed loops/i);
    }
  });

  test('rejects open segment graphs', () => {
    expect(() => extractExactContours(box(0, 0, 10, 8, 2, 3), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/open/i);
  });

  test('accepts an exact plane through an ordinary shared vertex', () => {
    const tetrahedron = mesh([
      0, 1, 0,
      0, 0, 1,
      -1, -1, -1,
      1, -1, -1,
    ], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const result = extractExactContours(tetrahedron, selection, specs, DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers).toHaveLength(1);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('accepts shared plane edges contributed from opposite sides exactly once', () => {
    const octahedron = mesh([
      1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0,
      0, 0, 1, 0, 0, -1,
    ], [
      4, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0,
      5, 1, 0, 5, 2, 1, 5, 3, 2, 5, 0, 3,
    ]);
    const result = extractExactContours(octahedron, selection, [
      { index: 0, zStart: 0, zMid: 0, zEnd: 0.5 },
    ], DEFAULT_OUTLINE_BUDGETS);
    expect(result.layers[0].sourceAreaMm2).toBeCloseTo(2, 8);
    expect(validateOutlineLayer(result.layers[0]).ok).toBe(true);
  });

  test('fails closed for a one-sided shared plane edge', () => {
    const foldedTangency = mesh([
      -1, 0, 0, 1, 0, 0, 0, 1, 1, 0, -1, 1,
    ], [0, 1, 2, 1, 0, 3]);
    expect(() => extractExactContours(foldedTangency, selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/shared plane edge.*ambiguous/i);
  });

  test('fails closed for a coplanar triangle', () => {
    expect(() => extractExactContours(sheet(0, 0, 2, 2), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/coplanar/i);
  });

  test('rejects a layer midpoint outside its public interval', () => {
    expect(() => extractExactContours(box(0, 0, 2, 2), selection, [
      { index: 0, zStart: -0.5, zEnd: 0.5, zMid: -0.75 },
    ], DEFAULT_OUTLINE_BUDGETS)).toThrow(/midpoint|zMid|interval/i);
  });

  test('fails closed when the runtime budget expires during bounded work', () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => { now += 10_001; return now; };
    try {
      expect(() => extractExactContours(box(0, 0, 20, 12), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/runtime budget/i);
      expect(() => extractProjectedContours(box(0, 0, 20, 12), selection, specs, DEFAULT_OUTLINE_BUDGETS)).toThrow(/runtime budget/i);
    } finally {
      Date.now = originalNow;
    }
  });
});
