import { readFile } from 'node:fs/promises';
import { findAxisCandidates } from '../src/domain/axis/find-axis';
import { generateParts } from '../src/domain/decomposition/generate-parts';
import { sampleLathedProfile } from '../src/domain/decomposition/profile-sampler';
import { inspectMesh } from '../src/domain/mesh/inspect-mesh';
import { parseSTL } from '../src/domain/mesh/parse-stl';

type Entry = { file: string; category: string; expected: 'auto-axis-and-editable-kit' | 'manual-axis-or-block' | 'blocking'; expectedAxis?: [number, number, number] };
const manifest = JSON.parse(await readFile(new URL('../fixtures/acceptance/manifest.json', import.meta.url), 'utf8')) as { schemaVersion: number; models: Entry[] };
if (manifest.schemaVersion !== 1 || manifest.models.length !== 10) throw new Error('Acceptance manifest must contain exactly 10 V1 models');

const results = [];
let autoSuccess = 0;
for (const entry of manifest.models) {
  try {
    const bytes = await readFile(new URL(`../fixtures/acceptance/${entry.file}`, import.meta.url));
    const mesh = parseSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const inspection = inspectMesh(mesh);
    if (inspection.boundaryEdgeCount > 0 || inspection.nonManifoldEdgeCount > 0) {
      const pass = entry.expected !== 'auto-axis-and-editable-kit';
      results.push({ file: entry.file, outcome: 'blocking-invalid-mesh', pass });
      continue;
    }
    const candidates = findAxisCandidates(mesh, { sampleCount: 2048 });
    const axis = candidates[0];
    if (entry.expected === 'auto-axis-and-editable-kit') {
      const expected = entry.expectedAxis!;
      const alignment = Math.abs(axis.direction[0] * expected[0] + axis.direction[1] * expected[1] + axis.direction[2] * expected[2]);
      const profile = sampleLathedProfile(mesh, { ...axis, confirmed: true }, 64);
      const kit = generateParts(profile, { thicknessMm: 3, fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 } }, { ribCount: 6, ringLayers: 2, shaftMm: 2, fit: 'snug' });
      const pass = alignment >= 0.9 && kit.parts.length > 0;
      if (pass) autoSuccess += 1;
      results.push({ file: entry.file, outcome: 'auto-axis-and-editable-kit', alignment, confidence: axis.confidence, parts: kit.parts.length, pass });
    } else {
      results.push({ file: entry.file, outcome: 'manual-axis-required', confidence: axis.confidence, pass: true });
    }
  } catch (error) {
    results.push({ file: entry.file, outcome: 'blocking-error', message: error instanceof Error ? error.message : String(error), pass: entry.expected !== 'auto-axis-and-editable-kit' });
  }
}

console.log(JSON.stringify({ schemaVersion: 1, autoSuccess, total: results.length, results }, null, 2));
if (autoSuccess < 8 || results.some(({ pass }) => !pass)) throw new Error(`Acceptance failed: ${autoSuccess}/8 automatic models passed`);
