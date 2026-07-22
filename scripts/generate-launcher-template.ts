import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findAxisCandidates } from '../src/domain/axis/find-axis';
import type { Point2 } from '../src/domain/decomposition/types';
import { parseSTL } from '../src/domain/mesh/parse-stl';
import type { TriangleMesh } from '../src/domain/mesh/types';
import {
  detectLauncherTemplate,
  type LauncherCandidateGroup,
} from '../src/domain/outline-assembly/launcher';
import {
  averageCompatibleLauncherReferences,
  renderLauncherTemplateInitializer,
  type LauncherReference,
  type LauncherTemplate,
} from '../src/domain/outline-assembly/launcher-template';
import { projectMesh, rasterCellSize, rasterProjectLayer, type RasterContour } from '../src/domain/outline-2.5d/raster';
import { simplifyClosedLoop } from '../src/domain/outline-2.5d/simplify';
import { DEFAULT_OUTLINE_BUDGETS } from '../src/domain/outline-2.5d/types';

const REFERENCE_VERSION = 1;
const SLICE_COUNT = 48;
const MAX_VOID_CANDIDATES = 12;
const MAX_GROUP_CANDIDATES = 64;

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function candidateGroups(
  voids: RasterContour['enclosedVoids'],
  tolerance: number,
  deadline: number,
): readonly LauncherCandidateGroup[] {
  const selected = [...voids]
    .filter(({ outer, occupiedCellCount }) => outer.length >= 3 && outer.length <= 4_096 && occupiedCellCount > 0)
    .sort((left, right) => right.occupiedCellCount - left.occupiedCellCount)
    .slice(0, MAX_VOID_CANDIDATES)
    .flatMap((candidate) => {
      try {
        return [{ ...candidate, outer: simplifyClosedLoop(candidate.outer, tolerance, 96, deadline) }];
      } catch (error) {
        if (error instanceof RangeError && /runtime budget/i.test(error.message)) throw error;
        return [];
      }
    });
  const maximumSupport = Math.max(...selected.map(({ occupiedCellCount }) => occupiedCellCount), 1);
  const groups: LauncherCandidateGroup[] = [];
  for (let first = 0; first + 2 < selected.length && groups.length < MAX_GROUP_CANDIDATES; first += 1) {
    for (let second = first + 1; second + 1 < selected.length && groups.length < MAX_GROUP_CANDIDATES; second += 1) {
      for (let third = second + 1; third < selected.length && groups.length < MAX_GROUP_CANDIDATES; third += 1) {
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

function extractReference(mesh: TriangleMesh, provenanceHash: string): LauncherReference {
  const axis = findAxisCandidates(mesh, { sampleCount: 2_048 })[0];
  const projected = projectMesh(mesh, {
    axis: { origin: axis.origin, direction: axis.direction, confidence: axis.confidence, confirmed: true },
    source: 'candidate',
  });
  const axialValues = projected.vertices.map(([, , axial]) => axial);
  const minimum = Math.min(...axialValues), maximum = Math.max(...axialValues), span = maximum - minimum;
  const halfSlab = Math.max(rasterCellSize(projected) / 4, span / 2_000);
  let best: { readonly loops: LauncherReference['loops']; readonly score: number; readonly level: number } | undefined;
  const deadline = Date.now() + 120_000;
  for (let level = 1; level < SLICE_COUNT; level += 1) {
    const zMid = minimum + span * level / SLICE_COUNT;
    let raster: RasterContour;
    try {
      raster = rasterProjectLayer(projected, {
        index: level,
        zStart: zMid - halfSlab,
        zMid,
        zEnd: zMid + halfSlab,
      }, DEFAULT_OUTLINE_BUDGETS, deadline);
    } catch (error) {
      if (error instanceof RangeError && /runtime budget/i.test(error.message)) throw error;
      continue;
    }
    const groups = candidateGroups(raster.enclosedVoids, rasterCellSize(projected), deadline);
    if (groups.length === 0) continue;
    const detection = detectLauncherTemplate({ candidates: groups, axisPoint: [0, 0], deadline });
    if (detection.status !== 'detected') continue;
    const score = detection.score + groups[detection.sourceCandidateIndex].evidenceStrength;
    if (!best || score > best.score + 1e-12 || Math.abs(score - best.score) <= 1e-12 && level < best.level) {
      best = { loops: detection.loops, score, level };
    }
  }
  if (!best) throw new RangeError('Launcher reference did not contain reliable three-hook geometry');
  return { loops: best.loops, provenanceHash };
}

async function loadReference(environmentName: 'KNIGHT_FORTRESS_STL' | 'KNIGHT_FORTRESS_GROUP_STL'): Promise<LauncherReference> {
  const source = process.env[environmentName];
  if (!source) throw new RangeError(`Missing required ${environmentName} input`);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(source);
  } catch {
    throw new RangeError(`Unable to read required ${environmentName} input`);
  }
  let mesh: TriangleMesh;
  try {
    mesh = parseSTL(Uint8Array.from(bytes).buffer);
  } catch {
    throw new RangeError(`Unable to parse required ${environmentName} input`);
  }
  return extractReference(mesh, hashBytes(bytes));
}

export async function generateLauncherTemplateFromEnvironment(): Promise<LauncherTemplate> {
  const references = await Promise.all([
    loadReference('KNIGHT_FORTRESS_STL'),
    loadReference('KNIGHT_FORTRESS_GROUP_STL'),
  ]);
  return averageCompatibleLauncherReferences(references, REFERENCE_VERSION, Date.now() + 120_000);
}

const template = await generateLauncherTemplateFromEnvironment();
process.stdout.write(renderLauncherTemplateInitializer(template));
