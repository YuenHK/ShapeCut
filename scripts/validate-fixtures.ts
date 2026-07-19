import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, findAxisCandidates } from '../src/domain/axis/find-axis';
import { generateParts } from '../src/domain/decomposition/generate-parts';
import { sampleLathedProfile } from '../src/domain/decomposition/profile-sampler';
import { inspectMesh } from '../src/domain/mesh/inspect-mesh';
import { parseSTL } from '../src/domain/mesh/parse-stl';
import type { SpinnerKit } from '../src/domain/decomposition/types';

type Entry = { file: string; category: string; expected: 'auto-axis-and-editable-kit' | 'manual-axis-or-block' | 'blocking'; expectedAxis?: [number, number, number] };
const manifest = JSON.parse(await readFile(new URL('../fixtures/acceptance/manifest.json', import.meta.url), 'utf8')) as { schemaVersion: number; models: Entry[] };
if (manifest.schemaVersion !== 1 || manifest.models.length !== 10) throw new Error('Acceptance manifest must contain exactly 10 V1 models');

type Result = {
  file: string;
  outcome: string;
  pass: boolean;
  alignment?: number;
  confidence?: number;
  radialRmsError?: number;
  centroidOffset?: number;
  parts?: number;
  dimensionsMm?: readonly [number, number];
  geometrySha256?: string;
  message?: string;
};

const results: Result[] = [];
let autoSuccess = 0;
for (const entry of manifest.models) {
  try {
    const bytes = await readFile(new URL(`../fixtures/acceptance/${entry.file}`, import.meta.url));
    const mesh = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const inspection = inspectMesh(mesh);
    if (inspection.boundaryEdgeCount > 0 || inspection.nonManifoldEdgeCount > 0) {
      const pass = entry.expected === 'blocking' || entry.expected === 'manual-axis-or-block';
      results.push({ file: entry.file, outcome: 'blocking-invalid-mesh', pass });
      continue;
    }
    if (entry.expected === 'blocking') {
      results.push({ file: entry.file, outcome: 'unexpected-nonblocking-mesh', pass: false });
      continue;
    }
    const candidates = findAxisCandidates(mesh, { sampleCount: 2048 });
    const axis = candidates[0];
    if (entry.expected === 'auto-axis-and-editable-kit') {
      const expected = entry.expectedAxis!;
      const alignment = Math.abs(axis.direction[0] * expected[0] + axis.direction[1] * expected[1] + axis.direction[2] * expected[2]);
      const profile = sampleLathedProfile(mesh, { ...axis, confirmed: true }, 64);
      const kit = generateParts(profile, { thicknessMm: 3, fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 } }, { splitPositionPercent: 40, ribCount: 6, ringLayers: 2, shaftMm: 2, fit: 'snug' });
      const output = kitOutput(kit);
      const pass = alignment >= 0.9 && axis.confidence >= AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD && kit.parts.length > 0;
      if (pass) autoSuccess += 1;
      results.push({
        file: entry.file,
        outcome: pass ? 'auto-axis-and-editable-kit' : 'automatic-acceptance-failed',
        alignment,
        confidence: axis.confidence,
        radialRmsError: axis.radialRmsError,
        centroidOffset: axis.centroidOffset,
        parts: kit.parts.length,
        ...output,
        pass,
      });
    } else {
      const pass = axis.confidence < AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD;
      results.push({
        file: entry.file,
        outcome: pass ? 'manual-axis-required' : 'unexpected-automatic-axis',
        confidence: axis.confidence,
        radialRmsError: axis.radialRmsError,
        centroidOffset: axis.centroidOffset,
        pass,
      });
    }
  } catch (error) {
    results.push({
      file: entry.file,
      outcome: 'blocking-error',
      message: error instanceof Error ? error.message : String(error),
      pass: entry.expected === 'manual-axis-or-block' || entry.expected === 'blocking',
    });
  }
}

const automaticOutputs = results.filter((result) => result.geometrySha256 !== undefined);
const outputComparisonPass = automaticOutputs.length >= 2
  && new Set(automaticOutputs.map(({ geometrySha256 }) => geometrySha256)).size >= 2
  && new Set(automaticOutputs.map(({ dimensionsMm }) => JSON.stringify(dimensionsMm))).size >= 2;
const summary = { schemaVersion: 1, automaticThreshold: AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, autoSuccess, total: results.length, outputComparisonPass, results };
console.log(JSON.stringify(summary, null, 2));
if (autoSuccess !== 8 || !outputComparisonPass || results.some(({ pass }) => !pass)) {
  throw new Error(`Acceptance failed: ${autoSuccess}/8 automatic models passed; output comparison ${outputComparisonPass ? 'passed' : 'failed'}`);
}

function kitOutput(kit: SpinnerKit): { readonly dimensionsMm: readonly [number, number]; readonly geometrySha256: string } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const geometry = kit.parts.map(({ kind, outline, holes, quantity }) => {
    for (const [x, y] of outline.points) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    return { kind, outline, holes, quantity };
  });
  return {
    dimensionsMm: [maxX - minX, maxY - minY],
    geometrySha256: createHash('sha256').update(JSON.stringify(geometry)).digest('hex'),
  };
}
