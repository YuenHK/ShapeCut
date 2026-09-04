import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { verifyWasmGeometryRelease } from '../../scripts/verify-wasm-geometry-release';

const root = resolve(import.meta.dirname, '../..');
const rawPath = resolve(root, 'docs/validation/wasm-geometry-release-measurements.jsonl');
const validationPath = resolve(root, 'docs/validation/wasm-geometry-validation-evidence.json');
const committedPath = resolve(root, 'docs/validation/wasm-geometry-release-evidence.json');
const runner = resolve(root, 'node_modules/vite-node/vite-node.mjs');
const generator = resolve(root, 'scripts/generate-wasm-release-evidence.ts');

function generate(raw: string, validation: unknown) {
  const directory = mkdtempSync(resolve(tmpdir(), 'shapecut-release-evidence-'));
  const input = resolve(directory, 'raw.jsonl');
  const sidecar = resolve(directory, 'validation.json');
  const output = resolve(directory, 'output.json');
  writeFileSync(input, raw);
  writeFileSync(sidecar, JSON.stringify(validation));
  const result = spawnSync(process.execPath, [runner, generator, input, sidecar, output], { encoding: 'utf8' });
  return { ...result, outputPath: output };
}

describe('release evidence generator', () => {
  it('reproduces the committed blocked evidence byte-for-byte', () => {
    const result = generate(readFileSync(rawPath, 'utf8'), JSON.parse(readFileSync(validationPath, 'utf8')));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(result.outputPath, 'utf8')).toBe(readFileSync(committedPath, 'utf8'));
  });

  it('rejects reused run IDs and unrecognised validation claims', () => {
    const raw = readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    raw[1].runId = raw[0].runId;
    const validation = JSON.parse(readFileSync(validationPath, 'utf8'));
    validation.uncontrolledClaim = true;
    expect(generate(raw.map((value) => JSON.stringify(value)).join('\n'), JSON.parse(readFileSync(validationPath, 'utf8'))).status).not.toBe(0);
    expect(generate(readFileSync(rawPath, 'utf8'), validation).status).not.toBe(0);
  });

  it('binds five measured real publications per case and produces verifier-eligible evidence', () => {
    const raw = readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const record of raw) {
      record.layerCount = 6;
      record.actualWasmPublications = [{
        generation: 1,
        layerCount: 6,
        activeWorkerCount: 0,
        sliceWorkersCreated: 2,
        sliceWorkersTerminated: 2,
      }];
      if (record.conversionStageMs !== undefined) record.conversionStageMs = 14_000 + record.runIndex;
      if (record.elapsedMs !== undefined) record.elapsedMs = 10_000 + record.runIndex;
      if (record.longestMainThreadTaskMs !== undefined) record.longestMainThreadTaskMs = 50;
      if (record.outcome !== undefined) record.outcome = 'SUCCESS';
      record.peakAttributableLiveBytes = 50_000_000;
    }
    const validation = JSON.parse(readFileSync(validationPath, 'utf8'));
    validation.memory = {
      baselineAttributableLiveBytes: 100_000_000,
      observationStages: ['pipeline:stl-received', 'slice-pool:partitions-ready', 'slice-pool:result-merged', 'slice-pool:cleanup'],
    };
    validation.responsiveness = { cancellationVerifiedUnderOneSecond: true, activeWorkersAfterCancellation: 0 };
    for (const key of Object.keys(validation.geometry)) validation.geometry[key] = true;
    validation.bundle = { hashedWasmAssets: 1, hashedSliceWorkerAssets: 1, sourceMaps: 0, absolutePaths: false, privateTokens: false };
    validation.privateAcceptance = 'passed';
    validation.physicalLauncherCoupon = 'passed';
    const result = generate(raw.map((value) => JSON.stringify(value)).join('\n'), validation);
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(result.outputPath, 'utf8'));
    expect(evidence.benchmarks.every((entry: { origin: string; actualWasmPublications: unknown[] }) => (
      entry.origin === 'wasm' && entry.actualWasmPublications.length === 5
    ))).toBe(true);
    expect(verifyWasmGeometryRelease(evidence)).toMatchObject({
      softwareReleaseEligible: true,
      productionRolloutEligible: true,
      failedGates: [],
    });
  });
});
