import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, findAxisCandidates } from '../src/domain/axis/find-axis';
import { generateParts } from '../src/domain/decomposition/generate-parts';
import { sampleLathedProfile } from '../src/domain/decomposition/profile-sampler';
import { inspectMesh } from '../src/domain/mesh/inspect-mesh';
import { parseSTL } from '../src/domain/mesh/parse-stl';
import type { SpinnerKit } from '../src/domain/decomposition/types';
import {
  KNIGHT_FORTRESS_LAUNCHER_TEMPLATE,
  renderLauncherTemplateInitializer,
} from '../src/domain/outline-assembly/launcher-template';
import { classifyMaterialReadiness } from '../src/domain/materials/schema';
import { manufacturingGeometryProfile } from '../src/domain/materials/manufacturing-profile';
import {
  convertAutomatically,
} from '../src/domain/pipeline/automatic-outline-pipeline';
import { createOutlinePackage } from '../src/export/outline-package';
import { READY_TEST_MATERIAL } from '../src/test/ready-material';
import {
  validateLauncherRuntimeGeometry,
  type LauncherRuntimeValidation,
} from './launcher-runtime-validation';

const execFileAsync = promisify(execFile);
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== '--public-only')
  || arguments_.filter((argument) => argument === '--public-only').length > 1) {
  throw new Error('Usage: validate-fixtures.ts [--public-only]');
}
const publicOnly = arguments_.includes('--public-only');
const launcherInputs = [process.env.KNIGHT_FORTRESS_STL, process.env.KNIGHT_FORTRESS_GROUP_STL] as const;
if (publicOnly && launcherInputs.some(Boolean)) {
  throw new Error('Public-only fixture validation does not accept private reference inputs');
}
if (!publicOnly && (!launcherInputs[0] || !launcherInputs[1])) {
  throw new Error('Launcher fixture validation requires both private reference inputs');
}

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
let launcherTemplatePass: boolean | 'not-requested' = 'not-requested';
let launcherTemplateDeterministic: boolean | 'not-requested' = 'not-requested';
let launcherRuntimeValidation: readonly LauncherRuntimeValidation[] | 'not-requested' = 'not-requested';
if (!publicOnly) {
  let first: string, second: string;
  try {
    const generate = async (): Promise<string> => (await execFileAsync(process.execPath, [
        fileURLToPath(new URL('../node_modules/vite-node/vite-node.mjs', import.meta.url)),
        fileURLToPath(new URL('./generate-launcher-template.ts', import.meta.url)),
      ], { env: process.env, maxBuffer: 1024 * 1024, timeout: 120_000 })).stdout;
    [first, second] = [await generate(), await generate()];
  } catch {
    throw new Error('Launcher fixture validation could not regenerate the numeric template');
  }
  launcherTemplatePass = first === renderLauncherTemplateInitializer(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE);
  launcherTemplateDeterministic = first === second;
  if (classifyMaterialReadiness(READY_TEST_MATERIAL).status !== 'ready') {
    throw new Error('Private launcher validation material is not release-ready');
  }
  const material = manufacturingGeometryProfile(READY_TEST_MATERIAL);
  const validations: LauncherRuntimeValidation[] = [];
  for (let index = 0; index < launcherInputs.length; index += 1) {
    const caseId = index === 0 ? 'reference-a' : 'reference-b';
    try {
      const bytes = await readFile(launcherInputs[index]!);
      const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const runtime = await convertAutomatically({ bytes: source, material, launcherFitOffsetMm: 0 });
      const packaged = await createOutlinePackage(runtime);
      const artifactLauncherCutCount = packaged.cutSvg.match(/-launcher-clearance-/g)?.length ?? 0;
      validations.push(validateLauncherRuntimeGeometry({
        caseId,
        runtime: {
          mode: runtime.mode,
          material: runtime.material,
          launcher: runtime.assembly.launcher,
          layers: runtime.coloredLayers.map(({ id, exterior, centralHole, launcherCuts }) => ({
            id, exterior, centralHole, launcherCuts,
          })),
        },
        artifactLauncherCutCount,
      }));
    } catch {
      throw new Error(`Private launcher runtime validation failed for ${caseId}`);
    }
  }
  launcherRuntimeValidation = validations;
}
const summary = {
  schemaVersion: 1,
  automaticThreshold: AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD,
  autoSuccess,
  total: results.length,
  outputComparisonPass,
  launcherTemplatePass,
  launcherTemplateDeterministic,
  launcherRuntimeValidation,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (autoSuccess !== 8 || !outputComparisonPass || launcherTemplatePass === false
  || launcherTemplateDeterministic === false || (launcherRuntimeValidation !== 'not-requested'
    && launcherRuntimeValidation.length !== 2) || results.some(({ pass }) => !pass)) {
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
