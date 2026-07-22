import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findAxisCandidates } from '../src/domain/axis/find-axis';
import { parseSTL } from '../src/domain/mesh/parse-stl';
import type { TriangleMesh } from '../src/domain/mesh/types';
import {
  detectLauncherTemplate,
  type LauncherCandidateGroup,
} from '../src/domain/outline-assembly/launcher';
import {
  averageCompatibleLauncherReferences,
  type LauncherReference,
  type LauncherTemplate,
} from '../src/domain/outline-assembly/launcher-template';
import { projectMesh, rasterCellSize, rasterProjectLayer, type RasterContour } from '../src/domain/outline-2.5d/raster';
import { simplifyClosedLoop } from '../src/domain/outline-2.5d/simplify';
import { DEFAULT_OUTLINE_BUDGETS } from '../src/domain/outline-2.5d/types';

const REFERENCE_VERSION = 1;
const GENERATOR_BUDGET_MS = 120_000;
const SLICE_COUNT = 48;
const MAX_VOID_CANDIDATES = 12;
const MAX_GROUP_CANDIDATES = 64;

export type LauncherTemplateMeshInput = {
  readonly mesh: TriangleMesh;
  readonly provenanceHash: string;
};

export type LauncherTemplateGeneratorBudget = {
  readonly deadline: number;
  readonly checkpoint?: () => void;
};

class GeneratorCheckpointInterruption {
  constructor(readonly original: unknown) {}
}

function checkGeneratorBudget(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Launcher template generation exceeded the runtime budget');
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function candidateGroups(
  voids: RasterContour['enclosedVoids'],
  tolerance: number,
  deadline: number,
  checkpoint: () => void,
): readonly LauncherCandidateGroup[] {
  const selected: Array<RasterContour['enclosedVoids'][number]> = [];
  const ranked = [...voids]
    .filter(({ outer, occupiedCellCount }) => outer.length >= 3 && outer.length <= 4_096 && occupiedCellCount > 0)
    .sort((left, right) => right.occupiedCellCount - left.occupiedCellCount)
    .slice(0, MAX_VOID_CANDIDATES);
  for (const candidate of ranked) {
    checkGeneratorBudget(deadline, checkpoint);
    try {
      selected.push({
        ...candidate,
        outer: simplifyClosedLoop(candidate.outer, tolerance, 96, deadline, checkpoint),
      });
    } catch (error) {
      if (!(error instanceof RangeError) || /runtime budget/i.test(error.message)) throw error;
    }
  }
  const maximumSupport = Math.max(...selected.map(({ occupiedCellCount }) => occupiedCellCount), 1);
  const groups: LauncherCandidateGroup[] = [];
  for (let first = 0; first + 2 < selected.length && groups.length < MAX_GROUP_CANDIDATES; first += 1) {
    for (let second = first + 1; second + 1 < selected.length && groups.length < MAX_GROUP_CANDIDATES; second += 1) {
      for (let third = second + 1; third < selected.length && groups.length < MAX_GROUP_CANDIDATES; third += 1) {
        checkGeneratorBudget(deadline, checkpoint);
        const loops = [selected[first], selected[second], selected[third]].map(({ outer, occupiedCellCount }) => ({
          outer,
          closed: true,
          support: occupiedCellCount / maximumSupport,
        })) as unknown as LauncherCandidateGroup['loops'];
        groups.push({
          loops,
          evidenceStrength: loops.reduce((sum, { support }) => sum + support, 0) / 3,
        });
      }
    }
  }
  return groups;
}

function extractReference(
  input: LauncherTemplateMeshInput,
  deadline: number,
  checkpoint: () => void,
): LauncherReference {
  checkGeneratorBudget(deadline, checkpoint);
  const axis = findAxisCandidates(input.mesh, { sampleCount: 2_048, deadline, checkpoint })[0];
  checkGeneratorBudget(deadline, checkpoint);
  if (!axis) throw new RangeError('Launcher reference did not contain a usable axis');
  const projected = projectMesh(input.mesh, {
    axis: { origin: axis.origin, direction: axis.direction, confidence: axis.confidence, confirmed: true },
    source: 'candidate',
  }, deadline, checkpoint);
  checkGeneratorBudget(deadline, checkpoint);
  const axialValues = projected.vertices.map(([, , axial]) => axial);
  const minimum = Math.min(...axialValues), maximum = Math.max(...axialValues), span = maximum - minimum;
  const cellSize = rasterCellSize(projected);
  const halfSlab = Math.max(cellSize / 4, span / 2_000);
  let best: { readonly loops: LauncherReference['loops']; readonly score: number; readonly level: number } | undefined;
  for (let level = 1; level < SLICE_COUNT; level += 1) {
    checkGeneratorBudget(deadline, checkpoint);
    const zMid = minimum + span * level / SLICE_COUNT;
    let raster: RasterContour;
    try {
      raster = rasterProjectLayer(projected, {
        index: level,
        zStart: zMid - halfSlab,
        zMid,
        zEnd: zMid + halfSlab,
      }, DEFAULT_OUTLINE_BUDGETS, deadline, checkpoint);
    } catch (error) {
      if (!(error instanceof RangeError) || /runtime budget/i.test(error.message)) throw error;
      continue;
    }
    const groups = candidateGroups(raster.enclosedVoids, cellSize, deadline, checkpoint);
    if (groups.length === 0) continue;
    const detection = detectLauncherTemplate({ candidates: groups, axisPoint: [0, 0], deadline, checkpoint });
    if (detection.status !== 'detected') continue;
    const score = detection.score + groups[detection.sourceCandidateIndex].evidenceStrength;
    if (!best || score > best.score + 1e-12 || Math.abs(score - best.score) <= 1e-12 && level < best.level) {
      best = { loops: detection.loops, score, level };
    }
  }
  if (!best) throw new RangeError('Launcher reference did not contain reliable three-hook geometry');
  return { loops: best.loops, provenanceHash: input.provenanceHash };
}

export function generateLauncherTemplateFromMeshes(
  inputs: readonly LauncherTemplateMeshInput[],
  budget: LauncherTemplateGeneratorBudget,
): LauncherTemplate {
  const callerCheckpoint = budget.checkpoint ?? (() => undefined);
  const checkpoint = (): void => {
    try {
      callerCheckpoint();
    } catch (error) {
      throw new GeneratorCheckpointInterruption(error);
    }
  };
  try {
    checkGeneratorBudget(budget.deadline, checkpoint);
    if (inputs.length !== 2) throw new RangeError('Launcher template generator requires exactly two references');
    const references = inputs.map((input) => extractReference(input, budget.deadline, checkpoint));
    checkGeneratorBudget(budget.deadline, checkpoint);
    return averageCompatibleLauncherReferences(references, REFERENCE_VERSION, budget.deadline, checkpoint);
  } catch (error) {
    if (error instanceof GeneratorCheckpointInterruption) throw error.original;
    throw error;
  }
}

async function loadMesh(
  environmentName: 'KNIGHT_FORTRESS_STL' | 'KNIGHT_FORTRESS_GROUP_STL',
  deadline: number,
  checkpoint: () => void,
): Promise<LauncherTemplateMeshInput> {
  checkGeneratorBudget(deadline, checkpoint);
  const source = process.env[environmentName];
  if (!source) throw new RangeError(`Missing required ${environmentName} input`);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(source);
  } catch {
    throw new RangeError(`Unable to read required ${environmentName} input`);
  }
  checkGeneratorBudget(deadline, checkpoint);
  let mesh: TriangleMesh;
  try {
    mesh = parseSTL(Uint8Array.from(bytes).buffer);
  } catch {
    throw new RangeError(`Unable to parse required ${environmentName} input`);
  }
  checkGeneratorBudget(deadline, checkpoint);
  return { mesh, provenanceHash: hashBytes(bytes) };
}

export async function generateLauncherTemplateFromEnvironment(
  checkpoint: () => void = () => undefined,
): Promise<LauncherTemplate> {
  const deadline = Date.now() + GENERATOR_BUDGET_MS;
  checkGeneratorBudget(deadline, checkpoint);
  const inputs = await Promise.all([
    loadMesh('KNIGHT_FORTRESS_STL', deadline, checkpoint),
    loadMesh('KNIGHT_FORTRESS_GROUP_STL', deadline, checkpoint),
  ]);
  return generateLauncherTemplateFromMeshes(inputs, { deadline, checkpoint });
}
