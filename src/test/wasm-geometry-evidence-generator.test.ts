import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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

  it('rejects reused job generations and unrecognised validation claims', () => {
    const raw = readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    raw[1].jobGeneration = raw[0].jobGeneration;
    const validation = JSON.parse(readFileSync(validationPath, 'utf8'));
    validation.uncontrolledClaim = true;
    expect(generate(raw.map((value) => JSON.stringify(value)).join('\n'), JSON.parse(readFileSync(validationPath, 'utf8'))).status).not.toBe(0);
    expect(generate(readFileSync(rawPath, 'utf8'), validation).status).not.toBe(0);
  });
});
