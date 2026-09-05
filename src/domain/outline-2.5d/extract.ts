import type { Point2 } from '../decomposition/types';
import type { TriangleMesh } from '../mesh/types';
import type { ColoredOutlineLayer, FeatureContour } from '../outline-features/types';
import { validatePolygon } from '../engraving/geometry';
import type { LauncherCandidateGroup } from '../outline-assembly/launcher';
import type { PhysicalCutProtection } from '../outline-assembly/physical-cut-envelope';
import {
  CENTRAL_HOLE_OMISSION_WARNING,
  selectSharedCentralHole,
  type CentralHoleRequest,
  type CentralHoleSelection,
  type CentralHoleCandidate,
} from '../outline-features/hole';
import {
  extractAdaptiveDepthFeatures,
  type DepthFeatureResult,
} from '../outline-features/depth-field';
import { validateDepthFeatureContours } from '../outline-features/validate';
import {
  recomputeLauncherDecorationOverlap,
  type InternalLauncherDecorationEvidence,
  type LauncherDecorationOverlap,
} from '../outline-features/launcher-decoration-evidence';
import { projectMesh, rasterCellSize, rasterProjectLayer, type ProjectedMesh } from './raster';
import { contourBounds, signedArea, simplifyClosedLoop, type Bounds2 } from './simplify';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineAxisSelection, type OutlineBudgets, type OutlineLayerSpec } from './types';
import { validateOutlineLayer } from './validate';
import {
  ExactContourAmbiguityError,
  collectTypeScriptExactSegments,
  type ExactSegment,
  type ExactSegmentCollection,
} from './segment-source';

export { ExactContourAmbiguityError } from './segment-source';

export type OutlineLayer = {
  readonly id: string;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly contour: { readonly outer: readonly Point2[]; readonly holes: readonly [] };
  readonly sourceAreaMm2: number;
  readonly simplifiedAreaMm2: number;
  readonly sourceBoundsMm: Bounds2;
  readonly simplificationToleranceMm: number;
  readonly boundsDriftRatio: number;
  readonly areaDriftRatio: number;
  readonly removedComponentCount: number;
};
export type OutlineExtraction = {
  readonly layers: readonly OutlineLayer[];
  readonly holeSelections: readonly CentralHoleSelection[];
  readonly depthFeatures: readonly DepthFeatureResult[];
  readonly blackCuts: readonly ExistingBlackCuts[];
  readonly launcherDecorationOverlap: LauncherDecorationOverlap;
  /** Bounded provisional contours retained only for internal strict validation. */
  readonly launcherDecorationEvidence: InternalLauncherDecorationEvidence;
  readonly featureWarnings: readonly string[];
  readonly cellSizeMm?: number;
  readonly removedComponentCount: number;
};
export type ExistingBlackCuts = {
  readonly launcherCuts: readonly FeatureContour[];
  readonly fastenerHoles: readonly FeatureContour[];
  readonly exteriorOverride?: FeatureContour;
  /** Production-only material-aware envelopes used before engraving retention. */
  readonly engravingProtection?: PhysicalCutProtection;
};
export type OutlineFeatureExtractionOptions = {
  readonly existingBlackCuts?: readonly ExistingBlackCuts[];
  readonly planBlackCuts?: (context: OutlineBlackCutPlanningContext) => OutlineBlackCutPlan;
};

export type OutlineBlackCutPlanningContext = {
  readonly layers: readonly OutlineLayer[];
  readonly holeSelections: readonly CentralHoleSelection[];
  readonly launcherCandidates: readonly LauncherCandidateGroup[];
  /** Private, bounded evidence used only to rank fixed launcher placement. */
  readonly decorationContours: readonly FeatureContour[];
  readonly cellSizeMm: number;
  readonly deadline: number;
};

type LauncherDecorationDecision = LauncherDecorationOverlap & {
  readonly deepFeatures: readonly FeatureContour[];
  readonly lightFeatures: readonly FeatureContour[];
};

export type OutlineBlackCutPlan = {
  readonly cuts: readonly ExistingBlackCuts[];
  readonly warnings?: readonly string[];
  /** A material-aware planner may conservatively omit the shared optional hole. */
  readonly holeSelections?: readonly CentralHoleSelection[];
};

export type HoleCandidateProbeEvidence = {
  readonly extractionMode: 'exact' | 'projected';
  readonly layerId: string;
  readonly candidates: readonly CentralHoleCandidate[];
  readonly exterior: readonly Point2[];
  readonly axisPoint: Point2;
  readonly layerWidthMm: number;
  readonly planarDiameterMm: number;
  readonly cellSizeMm: number;
};

let holeCandidateProbeForTesting: ((evidence: HoleCandidateProbeEvidence) => void) | undefined;

export function setHoleCandidateProbeForTesting(
  probe: ((evidence: HoleCandidateProbeEvidence) => void) | undefined,
): void {
  holeCandidateProbeForTesting = probe;
}

function emitHoleCandidatesForTesting(evidence: HoleCandidateProbeEvidence): void {
  if (!holeCandidateProbeForTesting) return;
  if (evidence.candidates.length > 64) throw new RangeError('Central-hole probe candidate bound exceeded');
  holeCandidateProbeForTesting({
    ...evidence,
    exterior: evidence.exterior.map(([x, y]) => [x, y] as Point2),
    candidates: evidence.candidates.map((candidate) => ({
      outer: candidate.outer.map(([x, y]) => [x, y] as Point2),
      ...(candidate.occupiedCellCount === undefined ? {} : { occupiedCellCount: candidate.occupiedCellCount }),
      ...(candidate.closed === undefined ? {} : { closed: candidate.closed }),
    })),
  });
}

export function colorizeExteriorLayers(
  layers: readonly OutlineLayer[],
  cellSizeMm = 0,
  deadline = Date.now() + 30_000,
  checkpoint: () => void = () => undefined,
  holeSelections: readonly CentralHoleSelection[] = [],
  depthFeatures: readonly DepthFeatureResult[] = [],
  blackCuts: readonly ExistingBlackCuts[] = [],
): readonly ColoredOutlineLayer[] {
  const checkColorizationDeadline = (): void => {
    checkpoint();
    checkDeadline(deadline);
  };
  checkColorizationDeadline();
  if (!Number.isFinite(cellSizeMm) || cellSizeMm < 0) {
    throw new RangeError('Colored outline layers require a finite non-negative cell size');
  }
  if (holeSelections.length !== 0 && holeSelections.length !== layers.length) {
    throw new RangeError('Colored outline layers require one ordered hole selection per layer');
  }
  if (depthFeatures.length !== 0 && depthFeatures.length !== layers.length) {
    throw new RangeError('Colored outline layers require one ordered depth result per layer');
  }
  if (blackCuts.length !== 0 && blackCuts.length !== layers.length) {
    throw new RangeError('Colored outline layers require one ordered black-cut record per layer');
  }
  const coloredLayers: ColoredOutlineLayer[] = [];
  for (const layer of layers) {
    checkColorizationDeadline();
    const exterior: FeatureContour = {
      id: `${layer.id}-exterior`,
      role: 'CUT_BLACK',
      outer: layer.contour.outer,
      boundsMm: contourBounds(layer.contour.outer, deadline, checkpoint),
      areaMm2: layer.simplifiedAreaMm2,
    };
    const holeSelection = holeSelections[coloredLayers.length];
    const centralHole: FeatureContour | undefined = holeSelection?.hole && {
      id: `${layer.id}-central-hole`,
      role: 'CUT_BLACK',
      outer: holeSelection.hole.outer,
      boundsMm: holeSelection.hole.boundsMm,
      areaMm2: holeSelection.hole.areaMm2,
    };
    const depthFeature = depthFeatures[coloredLayers.length];
    const existingBlackCuts = blackCuts[coloredLayers.length];
    const exteriorOverride = existingBlackCuts?.exteriorOverride;
    if (exteriorOverride) {
      validateExteriorOverride(layer, exteriorOverride, deadline, checkpoint);
    }
    checkColorizationDeadline();
    coloredLayers.push({
      id: layer.id,
      index: layer.index,
      zStart: layer.zStart,
      zEnd: layer.zEnd,
      exterior: exteriorOverride ?? exterior,
      centralHole,
      launcherCuts: existingBlackCuts?.launcherCuts ?? [],
      fastenerHoles: existingBlackCuts?.fastenerHoles ?? [],
      deepFeatures: depthFeature?.red ?? [],
      lightFeatures: depthFeature?.blue ?? [],
      removedComponentCount: layer.removedComponentCount,
      diagnostics: {
        hole: holeSelection?.hole
          ? {
            status: 'retained',
            equivalentDiameterMm: holeSelection.hole.equivalentDiameterMm,
            axisDistanceMm: holeSelection.hole.axisDistanceMm,
          }
          : { status: 'omitted' },
        depth: depthFeature?.diagnostics ?? {
          cellSizeMm,
          contrastMm: 0,
          redThresholdMm: 0,
          blueThresholdMm: 0,
          retained: { red: 0, blue: 0 },
          omitted: { red: 0, blue: 0 },
        },
      },
    });
  }
  checkColorizationDeadline();
  return coloredLayers;
}

function validateExteriorOverride(
  layer: OutlineLayer,
  exterior: FeatureContour,
  deadline: number,
  checkpoint: () => void,
): void {
  const expectedId = `${layer.id}-exterior`;
  if (exterior.id !== expectedId) {
    throw new RangeError(`Exterior override ID must match layer ${layer.id}`);
  }
  if (exterior.role !== 'CUT_BLACK') {
    throw new RangeError('Exterior override role must be CUT_BLACK');
  }
  if (!validatePolygon({ points: exterior.outer }, checkpoint)) {
    throw new RangeError('Exterior override must be one finite simple clockwise contour');
  }
  const area = signedArea(exterior.outer, deadline, checkpoint);
  if (area >= 0) {
    throw new RangeError('Exterior override must be one finite simple clockwise contour');
  }
  const expectedBounds = contourBounds(exterior.outer, deadline, checkpoint);
  if (exterior.areaMm2 !== Math.abs(area)
    || exterior.boundsMm.minX !== expectedBounds.minX
    || exterior.boundsMm.minY !== expectedBounds.minY
    || exterior.boundsMm.maxX !== expectedBounds.maxX
    || exterior.boundsMm.maxY !== expectedBounds.maxY) {
    throw new RangeError('Exterior override bounds and area metadata must exactly match its contour');
  }
}

/** Exact slice topology is ambiguous, so projected extraction may be attempted. */
function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new RangeError('Contour extraction exceeded the runtime budget');
}

function validateBudgets(budgets: OutlineBudgets): void {
  const validRuntimeBudget = budgets.maxRuntimeMs === Number.POSITIVE_INFINITY
    || (typeof budgets.maxRuntimeMs === 'number'
      && Number.isFinite(budgets.maxRuntimeMs)
      && budgets.maxRuntimeMs > 0);
  if (!validRuntimeBudget
    || !Number.isInteger(budgets.maxContourPointsPerLayer) || budgets.maxContourPointsPerLayer < 3
    || budgets.maxContourPointsPerLayer > 4096) {
    throw new RangeError('Contour extraction requires valid fail-closed budgets');
  }
}

function validateRequest(projected: ProjectedMesh, specs: readonly OutlineLayerSpec[], budgets: OutlineBudgets, deadline: number): void {
  checkDeadline(deadline);
  if (specs.length === 0 || specs.length > budgets.maxLayers) throw new RangeError('Contour extraction requires layers within budget');
  if (projected.triangles.length * specs.length > budgets.maxTriangleLayerTests) {
    throw new RangeError('Contour extraction exceeds the triangle-layer test budget');
  }
  for (let index = 0; index < specs.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const spec = specs[index];
    if (![spec.zStart, spec.zMid, spec.zEnd].every(Number.isFinite) || spec.zEnd <= spec.zStart
      || spec.zMid < spec.zStart || spec.zMid > spec.zEnd) {
      throw new RangeError('Contour extraction requires each finite layer interval to contain its midpoint');
    }
    const previous = specs[index - 1];
    if (previous && (spec.index <= previous.index || spec.zStart < previous.zEnd)) {
      throw new RangeError('Contour extraction requires strictly ordered non-overlapping layer intervals');
    }
  }
}

function boundedBlackCutsForLayers(
  supplied: readonly ExistingBlackCuts[],
  layers: readonly OutlineLayer[],
  deadline: number,
): readonly ExistingBlackCuts[] {
  const layerCount = layers.length;
  if (!Array.isArray(supplied) || supplied.length !== 0 && supplied.length !== layerCount) {
    throw new RangeError('Contour extraction requires ordered existing black cuts for every layer');
  }
  return Array.from({ length: layerCount }, (_, index) => {
    const cuts = supplied[index];
    if (cuts !== undefined && (!Array.isArray(cuts.launcherCuts) || !Array.isArray(cuts.fastenerHoles))) {
      throw new RangeError('Contour extraction requires bounded black-cut arrays');
    }
    if (cuts?.exteriorOverride) {
      validateExteriorOverride(
        layers[index],
        cuts.exteriorOverride,
        deadline,
        () => checkDeadline(deadline),
      );
    }
    return cuts ?? { launcherCuts: [], fastenerHoles: [] };
  });
}

export function launcherCandidateGroupsFromHoleCandidates(
  candidates: readonly CentralHoleCandidate[],
  deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs,
  checkpoint: () => void = () => undefined,
): readonly LauncherCandidateGroup[] {
  checkpoint();
  checkDeadline(deadline);
  const ranked = candidates.filter(({ outer, closed }) => closed !== false && outer.length >= 3 && outer.length <= 4096)
    .map((candidate) => ({
      candidate,
      evidence: candidate.occupiedCellCount ?? Math.abs(signedArea(candidate.outer, deadline)),
    }))
    .filter(({ evidence }) => Number.isFinite(evidence) && evidence > 0)
    .sort((left, right) => right.evidence - left.evidence)
    .slice(0, 18);
  const maximum = Math.max(...ranked.map(({ evidence }) => evidence), 1);
  const groups: LauncherCandidateGroup[] = [];
  for (let first = 0; first + 2 < ranked.length && groups.length < 64; first += 1) {
    for (let second = first + 1; second + 1 < ranked.length && groups.length < 64; second += 1) {
      for (let third = second + 1; third < ranked.length && groups.length < 64; third += 1) {
        checkpoint();
        checkDeadline(deadline);
        const loops = [ranked[first], ranked[second], ranked[third]].map(({ candidate, evidence }) => ({
          outer: candidate.outer,
          closed: true,
          support: evidence / maximum,
        })) as unknown as LauncherCandidateGroup['loops'];
        groups.push({ loops, evidenceStrength: loops.reduce((sum, loop) => sum + loop.support, 0) / 3 });
      }
    }
  }
  return groups;
}

function resolveBlackCuts(
  options: OutlineFeatureExtractionOptions | undefined,
  context: OutlineBlackCutPlanningContext,
): OutlineBlackCutPlan {
  if (options?.existingBlackCuts && options.planBlackCuts) {
    throw new RangeError('Contour extraction accepts either existing cuts or one black-cut planner');
  }
  const plan = options?.planBlackCuts?.(context) ?? { cuts: options?.existingBlackCuts ?? [] };
  const holeSelections = plan.holeSelections ?? context.holeSelections;
  if (holeSelections.length !== context.layers.length) {
    throw new RangeError('Black-cut planner hole decisions must match the extracted layer count');
  }
  if (plan.holeSelections && !holeSelections.every((selection, index) => (
    selection === context.holeSelections[index]
    || (
      selection.hole === undefined
      && selection.omissionReason === 'NO_RELIABLE_CENTRAL_HOLE'
      && selection.warning === CENTRAL_HOLE_OMISSION_WARNING
    )
  ))) {
    throw new RangeError('Black-cut planner may only omit the optional shared central hole');
  }
  return {
    cuts: boundedBlackCutsForLayers(plan.cuts, context.layers, context.deadline),
    warnings: plan.warnings ?? [],
    holeSelections,
  };
}

function extractDepthFeaturesForLayer(
  projected: ProjectedMesh,
  layer: OutlineLayer,
  spec: OutlineLayerSpec,
  layerIndex: number,
  layerCount: number,
  holeSelection: CentralHoleSelection,
  cellSizeMm: number,
  budgets: OutlineBudgets,
  deadline: number,
  blackCuts?: ExistingBlackCuts,
): DepthFeatureResult {
  const exterior = blackCuts?.exteriorOverride;
  return extractAdaptiveDepthFeatures(projected, {
    layerId: layer.id,
    layer: spec,
    exterior: exterior?.outer ?? layer.contour.outer,
    centralHole: holeSelection.hole?.outer,
    exteriorAreaMm2: exterior?.areaMm2 ?? layer.simplifiedAreaMm2,
    cellSizeMm,
    planarDiameterMm: projected.planarDiameter,
    budgets,
    totalLayerCount: layerCount,
    maximumFeaturesPerRole: layerIndex === layerCount - 1 ? 12 : 1,
    protectedCuts: blackCuts?.engravingProtection?.removalEnvelopes
      ?? [...(blackCuts?.launcherCuts ?? []), ...(blackCuts?.fastenerHoles ?? [])].map(({ outer }) => outer),
    exteriorClearanceMm: blackCuts?.engravingProtection?.exteriorClearanceMm,
    protectedCutClearanceMm: blackCuts?.engravingProtection?.requiredClearanceMm,
    deadline,
  });
}

function provisionalDepthFeatures(
  projected: ProjectedMesh,
  layers: readonly OutlineLayer[],
  specs: readonly OutlineLayerSpec[],
  holeSelections: readonly CentralHoleSelection[],
  cellSizeMm: number,
  budgets: OutlineBudgets,
  deadline: number,
): ReadonlyMap<number, DepthFeatureResult> {
  const provisional = new Map<number, DepthFeatureResult>();
  for (let index = Math.max(0, layers.length - 2); index < layers.length; index += 1) {
    checkDeadline(deadline);
    provisional.set(index, extractDepthFeaturesForLayer(
      projected, layers[index], specs[index], index, layers.length,
      holeSelections[index], cellSizeMm, budgets, deadline,
    ));
  }
  return provisional;
}

function finishedLauncherEnvelopes(
  layer: OutlineLayer,
  holeSelection: CentralHoleSelection,
  cuts: ExistingBlackCuts,
  deadline: number,
): readonly FeatureContour[] {
  const protection = cuts.engravingProtection;
  if (!protection || cuts.launcherCuts.length === 0) return [];
  const firstLauncher = holeSelection.hole ? 1 : 0;
  return protection.removalEnvelopes
    .slice(firstLauncher, firstLauncher + cuts.launcherCuts.length)
    .map((outer, index): FeatureContour => ({
      id: `${layer.id}-launcher-finished-envelope-${index + 1}`,
      role: 'CUT_BLACK',
      outer,
      boundsMm: contourBounds(outer, deadline),
      areaMm2: Math.abs(signedArea(outer, deadline)),
    }));
}

function protectLauncherFromDecoration(
  layer: ColoredOutlineLayer,
  provisional: DepthFeatureResult | undefined,
  final: DepthFeatureResult,
  finishedLauncherEnvelopes: readonly FeatureContour[],
  protectedCutClearanceMm: number,
  deadline: number,
  checkpoint: () => void,
): LauncherDecorationDecision {
  const validateRemainders = (
    red: readonly FeatureContour[],
    blue: readonly FeatureContour[],
    centralHole?: readonly Point2[],
    clearanceMm = 0,
  ): void => {
    const validation = validateDepthFeatureContours({
      exterior: layer.exterior.outer,
      centralHole,
      red,
      blue,
      clearanceMm,
      deadline,
      checkpoint,
    });
    if (!validation.ok) {
      throw new RangeError(`Launcher-protected decoration remainder is invalid: ${validation.reasons.join('; ')}`);
    }
  };
  validateRemainders(final.red, final.blue, layer.centralHole?.outer);
  for (const envelope of finishedLauncherEnvelopes) {
    validateRemainders(final.red, final.blue, envelope.outer, protectedCutClearanceMm);
  }
  const decision = recomputeLauncherDecorationOverlap({
    provisional: {
      red: provisional?.red ?? [],
      blue: provisional?.blue ?? [],
    },
  }, {
    red: final.red,
    blue: final.blue,
  }, finishedLauncherEnvelopes, deadline, checkpoint);
  return {
    deepFeatures: final.red,
    lightFeatures: final.blue,
    clipped: decision.clipped,
    removed: decision.removed,
  };
}

/** Test seam for the bounded internal provisional-to-final validation decision. */
export const protectLauncherFromDecorationForTesting = protectLauncherFromDecoration;

function withinDrift(sourceBounds: Bounds2, simplified: readonly Point2[], deadline: number): boolean {
  return boundsDriftRatio(sourceBounds, simplified, deadline) <= 0.03 + 1e-12;
}

export function outlineBoundsDriftMetrics(source: Bounds2, output: Bounds2): { readonly direct: number; readonly legacyEdge: number } {
  const width = source.maxX - source.minX, height = source.maxY - source.minY;
  return {
    direct: Math.max(Math.abs((output.maxX - output.minX) - width) / width, Math.abs((output.maxY - output.minY) - height) / height),
    legacyEdge: Math.max(
      Math.abs(output.minX - source.minX) / width, Math.abs(output.maxX - source.maxX) / width,
      Math.abs(output.minY - source.minY) / height, Math.abs(output.maxY - source.maxY) / height,
    ),
  };
}

function boundsDriftRatio(sourceBounds: Bounds2, simplified: readonly Point2[], deadline: number): number {
  const result = contourBounds(simplified, deadline);
  return outlineBoundsDriftMetrics(sourceBounds, result).direct;
}

function makeLayer(
  spec: OutlineLayerSpec,
  source: readonly Point2[],
  tolerance: number,
  budgets: OutlineBudgets,
  deadline: number,
  removedComponentCount: number,
  sourceEvidence?: Readonly<{ bounds: Bounds2; area: number }>,
): OutlineLayer {
  checkDeadline(deadline);
  const sourceAreaMm2 = sourceEvidence?.area ?? Math.abs(signedArea(source, deadline));
  const sourceBoundsMm = sourceEvidence?.bounds ?? contourBounds(source, deadline);
  let currentTolerance = tolerance;
  let simplified = simplifyClosedLoop(source, currentTolerance, budgets.maxContourPointsPerLayer, deadline);
  let simplifiedAreaMm2 = Math.abs(signedArea(simplified, deadline));
  for (let attempt = 0; attempt < 16 && (!withinDrift(sourceBoundsMm, simplified, deadline)
    || Math.abs(simplifiedAreaMm2 - sourceAreaMm2) / sourceAreaMm2 > 0.03); attempt += 1) {
    checkDeadline(deadline);
    currentTolerance /= 2;
    simplified = simplifyClosedLoop(source, currentTolerance, budgets.maxContourPointsPerLayer, deadline);
    simplifiedAreaMm2 = Math.abs(signedArea(simplified, deadline));
  }
  if (!withinDrift(sourceBoundsMm, simplified, deadline)) throw new RangeError('Simplified contour bounds drift exceeds three percent');
  const finalAreaDrift = Math.abs(simplifiedAreaMm2 - sourceAreaMm2) / sourceAreaMm2;
  if (finalAreaDrift > 0.03 + 1e-12) throw new RangeError(`Projected component area drift exceeds three percent (${finalAreaDrift})`);
  const layer: OutlineLayer = {
    id: `outline-layer-${spec.index}`,
    index: spec.index,
    zStart: spec.zStart,
    zEnd: spec.zEnd,
    contour: { outer: simplified, holes: [] },
    sourceAreaMm2,
    simplifiedAreaMm2,
    sourceBoundsMm,
    simplificationToleranceMm: currentTolerance,
    boundsDriftRatio: boundsDriftRatio(sourceBoundsMm, simplified, deadline),
    areaDriftRatio: finalAreaDrift,
    removedComponentCount,
  };
  const validation = validateOutlineLayer(layer, deadline);
  if (!validation.ok) throw new RangeError(`Invalid outline layer: ${validation.reasons.join('; ')}`);
  return layer;
}

export function extractProjectedContours(
  mesh: TriangleMesh,
  selection: OutlineAxisSelection,
  specs: readonly OutlineLayerSpec[],
  budgets: OutlineBudgets,
  deadline = Date.now() + budgets.maxRuntimeMs,
  options?: OutlineFeatureExtractionOptions,
): OutlineExtraction {
  validateBudgets(budgets);
  const projected = projectMesh(mesh, selection, deadline); validateRequest(projected, specs, budgets, deadline);
  const cellSizeMm = rasterCellSize(projected);
  const width = Math.ceil((projected.maxX - projected.minX) / cellSizeMm) + 3;
  const height = Math.ceil((projected.maxY - projected.minY) / cellSizeMm) + 3;
  if (width * height * specs.length > budgets.maxRasterCellsTotal) throw new RangeError('Projected contour exceeds the total raster cell budget');
  let removedComponentCount = 0;
  const tolerance = Math.max(cellSizeMm * 1.5, projected.planarDiameter * 0.001);
  const layers: OutlineLayer[] = [];
  const holeRequests: CentralHoleRequest[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    checkDeadline(deadline);
    const spec = specs[index];
    const raster = rasterProjectLayer(projected, spec, budgets, deadline);
    removedComponentCount += raster.componentCount - 1;
    const layer = makeLayer(spec, raster.outer, tolerance, budgets, deadline, raster.componentCount - 1, {
      bounds: raster.sourceBoundsMm, area: Math.abs(signedArea(raster.outer, deadline)),
    });
    layers.push(layer);
    const layerWidthMm = layer.sourceBoundsMm.maxX - layer.sourceBoundsMm.minX;
    const holeRequest = {
      candidates: raster.enclosedVoids,
      exterior: layer.contour.outer,
      axisPoint: [0, 0],
      layerWidthMm,
      planarDiameterMm: projected.planarDiameter,
      cellSizeMm,
      deadline,
    } satisfies CentralHoleRequest;
    emitHoleCandidatesForTesting({ extractionMode: 'projected', layerId: layer.id, ...holeRequest });
    holeRequests.push(holeRequest);
  }
  let holeSelections = selectSharedCentralHole(holeRequests);
  const provisional = provisionalDepthFeatures(
    projected, layers, specs, holeSelections, cellSizeMm, budgets, deadline,
  );
  const blackCutPlan = resolveBlackCuts(options, {
    layers,
    holeSelections,
    launcherCandidates: launcherCandidateGroupsFromHoleCandidates(holeRequests.at(-1)?.candidates ?? [], deadline),
    decorationContours: [...provisional.values()].flatMap(({ red, blue }) => [...red, ...blue]),
    cellSizeMm,
    deadline,
  });
  holeSelections = blackCutPlan.holeSelections ?? holeSelections;
  const blackCuts = blackCutPlan.cuts;
  const depthFeatures = layers.map((layer, index) => extractDepthFeaturesForLayer(
    projected, layer, specs[index], index, layers.length, holeSelections[index],
    cellSizeMm, budgets, deadline, blackCuts[index],
  ));
  const topIndex = layers.length - 1;
  const topColored = colorizeExteriorLayers(
    [layers[topIndex]], cellSizeMm, deadline, () => undefined,
    [holeSelections[topIndex]], [depthFeatures[topIndex]], [blackCuts[topIndex]],
  )[0];
  const launcherDecision = protectLauncherFromDecoration(
    topColored,
    provisional.get(topIndex),
    depthFeatures[topIndex],
    finishedLauncherEnvelopes(layers[topIndex], holeSelections[topIndex], blackCuts[topIndex], deadline),
    blackCuts[topIndex].engravingProtection?.requiredClearanceMm ?? 0,
    deadline,
    () => checkDeadline(deadline),
  );
  const featureWarnings = new Set<string>();
  for (const warning of blackCutPlan.warnings ?? []) featureWarnings.add(warning);
  if (!holeSelections[0].hole) featureWarnings.add(CENTRAL_HOLE_OMISSION_WARNING);
  for (const feature of depthFeatures) if (feature.warning) featureWarnings.add(feature.warning);
  return {
    layers,
    holeSelections,
    depthFeatures: depthFeatures.map((feature, index) => index === topIndex ? {
      ...feature,
      red: launcherDecision.deepFeatures,
      blue: launcherDecision.lightFeatures,
    } : feature),
    blackCuts,
    launcherDecorationOverlap: {
      clipped: launcherDecision.clipped,
      removed: launcherDecision.removed,
    },
    launcherDecorationEvidence: {
      provisional: {
        red: provisional.get(topIndex)?.red ?? [],
        blue: provisional.get(topIndex)?.blue ?? [],
      },
      protectedCutClearanceMm: blackCuts[topIndex].engravingProtection?.requiredClearanceMm ?? 0,
    },
    featureWarnings: [...featureWarnings],
    cellSizeMm,
    removedComponentCount,
  };
}

function exactLoops(segments: readonly ExactSegment[], diameter: number, deadline: number): readonly (readonly Point2[])[] {
  checkDeadline(deadline);
  if (segments.length === 0) throw new ExactContourAmbiguityError('Exact contour has an empty segment graph');
  const quantum = Math.max(1e-9, diameter * 1e-9);
  const key = ([x, y]: Point2) => `${Math.round(x / quantum)},${Math.round(y / quantum)}`;
  const points = new Map<string, Point2>(), adjacency = new Map<string, string[]>();
  const retainCanonicalPoint = (pointKey: string, candidate: Point2) => {
    const current = points.get(pointKey);
    if (!current || candidate[0] < current[0] || (candidate[0] === current[0] && candidate[1] < current[1])) {
      points.set(pointKey, candidate);
    }
  };
  const uniqueEdges = new Set<string>();
  for (let index = 0; index < segments.length; index += 1) {
    if ((index & 255) === 0) checkDeadline(deadline);
    const [a, b] = segments[index];
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (uniqueEdges.has(edgeKey)) throw new ExactContourAmbiguityError('Exact contour segment graph overlaps');
    uniqueEdges.add(edgeKey);
    retainCanonicalPoint(ka, a); retainCanonicalPoint(kb, b);
    const aNeighbors = adjacency.get(ka), bNeighbors = adjacency.get(kb);
    if (aNeighbors) aNeighbors.push(kb); else adjacency.set(ka, [kb]);
    if (bNeighbors) bNeighbors.push(ka); else adjacency.set(kb, [ka]);
  }
  if (adjacency.size === 0) throw new ExactContourAmbiguityError('Exact contour segment graph is open or non-manifold');
  for (const neighbors of adjacency.values()) {
    checkDeadline(deadline);
    if (neighbors.length !== 2 || neighbors[0] === neighbors[1]) {
      throw new ExactContourAmbiguityError('Exact contour segment graph is open or non-manifold');
    }
    neighbors.sort((left, right) => { checkDeadline(deadline); return left.localeCompare(right); });
  }
  const visited = new Set<string>(), loops: Point2[][] = [];
  const starts = [...adjacency.keys()];
  starts.sort((left, right) => { checkDeadline(deadline); return left.localeCompare(right); });
  for (let startIndex = 0; startIndex < starts.length; startIndex += 1) {
    if ((startIndex & 255) === 0) checkDeadline(deadline);
    const start = starts[startIndex];
    if (visited.has(start)) continue;
    const loop: Point2[] = []; let previous: string | undefined, current = start;
    for (let guard = 0; guard <= adjacency.size; guard += 1) {
      if ((guard & 255) === 0) checkDeadline(deadline);
      if (visited.has(current) && current !== start) {
        throw new ExactContourAmbiguityError('Exact contour segment graph overlaps');
      }
      if (current === start && loop.length > 0) break;
      visited.add(current); loop.push(points.get(current)!);
      const neighbors = adjacency.get(current)!;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      previous = current; current = next;
    }
    if (current !== start || loop.length < 3) {
      throw new ExactContourAmbiguityError('Exact contour segment graph is open');
    }
    loops.push(loop);
  }
  return loops;
}

const MAX_EXACT_HOLE_CANDIDATES = 64;
const MAX_EXACT_LOOPS_PER_LAYER = 1 + MAX_EXACT_HOLE_CANDIDATES;

function exactCross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function exactOnSegment(a: Point2, b: Point2, point: Point2, areaTolerance: number, lengthTolerance: number): boolean {
  return Math.abs(exactCross(a, b, point)) <= areaTolerance
    && point[0] >= Math.min(a[0], b[0]) - lengthTolerance
    && point[0] <= Math.max(a[0], b[0]) + lengthTolerance
    && point[1] >= Math.min(a[1], b[1]) - lengthTolerance
    && point[1] <= Math.max(a[1], b[1]) + lengthTolerance;
}

function exactSegmentsIntersect(
  a: Point2,
  b: Point2,
  c: Point2,
  d: Point2,
  areaTolerance: number,
  lengthTolerance: number,
): boolean {
  const abC = exactCross(a, b, c), abD = exactCross(a, b, d);
  const cdA = exactCross(c, d, a), cdB = exactCross(c, d, b);
  if (((abC > areaTolerance && abD < -areaTolerance) || (abC < -areaTolerance && abD > areaTolerance))
    && ((cdA > areaTolerance && cdB < -areaTolerance) || (cdA < -areaTolerance && cdB > areaTolerance))) return true;
  return exactOnSegment(a, b, c, areaTolerance, lengthTolerance)
    || exactOnSegment(a, b, d, areaTolerance, lengthTolerance)
    || exactOnSegment(c, d, a, areaTolerance, lengthTolerance)
    || exactOnSegment(c, d, b, areaTolerance, lengthTolerance);
}

function exactPointLocation(
  point: Point2,
  polygon: readonly Point2[],
  areaTolerance: number,
  lengthTolerance: number,
  deadline: number,
): -1 | 0 | 1 {
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    if ((index & 63) === 0) checkDeadline(deadline);
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if (exactOnSegment(a, b, point, areaTolerance, lengthTolerance)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])) {
      const x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
      if (x > point[0]) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function classifyExactNestedLoops(
  loops: readonly (readonly Point2[])[],
  diameter: number,
  deadline: number,
): { readonly exterior: readonly Point2[]; readonly holes: readonly (readonly Point2[])[] } {
  checkDeadline(deadline);
  const lengthTolerance = Math.max(1e-9, diameter * 1e-9);
  const areaTolerance = Math.max(1e-18, diameter * diameter * 64 * Number.EPSILON);
  for (let loopIndex = 0; loopIndex < loops.length; loopIndex += 1) {
    checkDeadline(deadline);
    const loop = loops[loopIndex];
    if (loop.length < 3 || loop.length > 4096 || !Number.isFinite(signedArea(loop, deadline))
      || Math.abs(signedArea(loop, deadline)) <= areaTolerance) {
      throw new ExactContourAmbiguityError('Exact contour loop is degenerate or non-simple');
    }
    for (let first = 0; first < loop.length; first += 1) {
      checkDeadline(deadline);
      const firstNext = (first + 1) % loop.length;
      for (let second = first + 1; second < loop.length; second += 1) {
        if ((second & 63) === 0) checkDeadline(deadline);
        const secondNext = (second + 1) % loop.length;
        if (firstNext === second || secondNext === first) continue;
        if (exactSegmentsIntersect(
          loop[first], loop[firstNext], loop[second], loop[secondNext], areaTolerance, lengthTolerance,
        )) throw new ExactContourAmbiguityError('Exact contour loop is non-simple');
      }
    }
  }
  for (let left = 0; left < loops.length; left += 1) {
    for (let right = left + 1; right < loops.length; right += 1) {
      checkDeadline(deadline);
      for (let leftEdge = 0; leftEdge < loops[left].length; leftEdge += 1) {
        if ((leftEdge & 63) === 0) checkDeadline(deadline);
        const leftNext = (leftEdge + 1) % loops[left].length;
        for (let rightEdge = 0; rightEdge < loops[right].length; rightEdge += 1) {
          if ((rightEdge & 63) === 0) checkDeadline(deadline);
          const rightNext = (rightEdge + 1) % loops[right].length;
          if (exactSegmentsIntersect(
            loops[left][leftEdge], loops[left][leftNext], loops[right][rightEdge], loops[right][rightNext],
            areaTolerance, lengthTolerance,
          )) throw new ExactContourAmbiguityError('Exact contour loops touch or intersect ambiguously');
        }
      }
    }
  }
  const depths = loops.map((loop, loopIndex) => {
    let depth = 0;
    for (let containerIndex = 0; containerIndex < loops.length; containerIndex += 1) {
      checkDeadline(deadline);
      if (containerIndex === loopIndex) continue;
      const location = exactPointLocation(
        loop[0], loops[containerIndex], areaTolerance, lengthTolerance, deadline,
      );
      if (location === 0) throw new ExactContourAmbiguityError('Exact contour containment is ambiguous');
      if (location === 1) depth += 1;
    }
    return depth;
  });
  const roots = loops.filter((_, index) => depths[index] === 0);
  if (roots.length !== 1) throw new ExactContourAmbiguityError('Exact contour has multiple closed loops at depth-zero exterior');
  if (depths.some((depth) => depth > 1)) {
    throw new ExactContourAmbiguityError('Exact contour nesting depth exceeds one hole level');
  }
  const holes = loops.filter((_, index) => depths[index] === 1);
  if (holes.length > MAX_EXACT_HOLE_CANDIDATES) {
    throw new RangeError('Exact contour exceeds the central-hole candidate budget');
  }
  return { exterior: roots[0], holes };
}

function clockwise(points: readonly Point2[], deadline: number): readonly Point2[] {
  return signedArea(points, deadline) < 0 ? points : [...points].reverse();
}

export function extractExactContours(
  mesh: TriangleMesh,
  selection: OutlineAxisSelection,
  specs: readonly OutlineLayerSpec[],
  budgets: OutlineBudgets,
  deadline = Date.now() + budgets.maxRuntimeMs,
  options?: OutlineFeatureExtractionOptions,
  suppliedSegments?: ExactSegmentCollection,
  suppliedProjection?: ProjectedMesh,
): OutlineExtraction {
  validateBudgets(budgets);
  const projected = suppliedProjection ?? projectMesh(mesh, selection, deadline);
  validateRequest(projected, specs, budgets, deadline);
  const tolerance = Math.max(rasterCellSize(projected) * 1.5, projected.planarDiameter * 0.001);
  const layers: OutlineLayer[] = [];
  const holeRequests: CentralHoleRequest[] = [];
  const cellSizeMm = rasterCellSize(projected);
  const segmentCollection = suppliedSegments ?? collectTypeScriptExactSegments(
    projected, specs, deadline, () => checkDeadline(deadline),
  );
  if (segmentCollection.layers.length !== specs.length) {
    throw new RangeError('Exact segment collection does not match the layer schedule');
  }
  for (let index = 0; index < specs.length; index += 1) {
    checkDeadline(deadline);
    const spec = specs[index];
    const segmentLayer = segmentCollection.layers[index];
    if (segmentLayer.planeIndex !== index || segmentLayer.z !== spec.zMid) {
      throw new RangeError('Exact segment collection does not match the layer schedule');
    }
    const loops = exactLoops(segmentLayer.segments, projected.planarDiameter, deadline);
    if (loops.length > MAX_EXACT_LOOPS_PER_LAYER) {
      throw new RangeError('Exact contour loop count exceeds the layer budget');
    }
    const classified = classifyExactNestedLoops(loops, projected.planarDiameter, deadline);
    const layer = makeLayer(spec, clockwise(classified.exterior, deadline), tolerance, budgets, deadline, 0);
    layers.push(layer);
    const holeRequest = {
      candidates: classified.holes.map((outer) => ({ outer })),
      exterior: layer.contour.outer,
      axisPoint: [0, 0],
      layerWidthMm: layer.sourceBoundsMm.maxX - layer.sourceBoundsMm.minX,
      planarDiameterMm: projected.planarDiameter,
      cellSizeMm,
      deadline,
    } satisfies CentralHoleRequest;
    emitHoleCandidatesForTesting({ extractionMode: 'exact', layerId: layer.id, ...holeRequest });
    holeRequests.push(holeRequest);
  }
  let holeSelections = selectSharedCentralHole(holeRequests);
  const provisional = provisionalDepthFeatures(
    projected, layers, specs, holeSelections, cellSizeMm, budgets, deadline,
  );
  const blackCutPlan = resolveBlackCuts(options, {
    layers,
    holeSelections,
    launcherCandidates: launcherCandidateGroupsFromHoleCandidates(holeRequests.at(-1)?.candidates ?? [], deadline),
    decorationContours: [...provisional.values()].flatMap(({ red, blue }) => [...red, ...blue]),
    cellSizeMm,
    deadline,
  });
  holeSelections = blackCutPlan.holeSelections ?? holeSelections;
  const blackCuts = blackCutPlan.cuts;
  const depthFeatures = layers.map((layer, index) => extractDepthFeaturesForLayer(
    projected, layer, specs[index], index, layers.length, holeSelections[index],
    cellSizeMm, budgets, deadline, blackCuts[index],
  ));
  const topIndex = layers.length - 1;
  const topColored = colorizeExteriorLayers(
    [layers[topIndex]], cellSizeMm, deadline, () => undefined,
    [holeSelections[topIndex]], [depthFeatures[topIndex]], [blackCuts[topIndex]],
  )[0];
  const launcherDecision = protectLauncherFromDecoration(
    topColored,
    provisional.get(topIndex),
    depthFeatures[topIndex],
    finishedLauncherEnvelopes(layers[topIndex], holeSelections[topIndex], blackCuts[topIndex], deadline),
    blackCuts[topIndex].engravingProtection?.requiredClearanceMm ?? 0,
    deadline,
    () => checkDeadline(deadline),
  );
  const featureWarnings = new Set<string>();
  for (const warning of blackCutPlan.warnings ?? []) featureWarnings.add(warning);
  if (!holeSelections[0].hole) featureWarnings.add(CENTRAL_HOLE_OMISSION_WARNING);
  for (const feature of depthFeatures) if (feature.warning) featureWarnings.add(feature.warning);
  return {
    layers,
    holeSelections,
    depthFeatures: depthFeatures.map((feature, index) => index === topIndex ? {
      ...feature,
      red: launcherDecision.deepFeatures,
      blue: launcherDecision.lightFeatures,
    } : feature),
    blackCuts,
    launcherDecorationOverlap: {
      clipped: launcherDecision.clipped,
      removed: launcherDecision.removed,
    },
    launcherDecorationEvidence: {
      provisional: {
        red: provisional.get(topIndex)?.red ?? [],
        blue: provisional.get(topIndex)?.blue ?? [],
      },
      protectedCutClearanceMm: blackCuts[topIndex].engravingProtection?.requiredClearanceMm ?? 0,
    },
    featureWarnings: [...featureWarnings],
    removedComponentCount: 0,
  };
}
