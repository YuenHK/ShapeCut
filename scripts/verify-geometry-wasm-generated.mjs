import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDirectory = resolve(repositoryRoot, 'src/wasm/generated');
const directoryArgument = process.argv[2];
const artifactDirectory = directoryArgument
  ? resolve(repositoryRoot, directoryArgument)
  : defaultDirectory;
const manifestPath = resolve(defaultDirectory, 'geometry_wasm.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectedArtifactNames = [
  'geometry_wasm.d.ts',
  'geometry_wasm.js',
  'geometry_wasm_bg.wasm',
  'geometry_wasm_bg.wasm.d.ts',
];

if (manifest.schemaVersion !== 1
  || manifest.rustToolchain !== '1.98.0'
  || manifest.wasmPack !== '0.15.0'
  || manifest.artifacts === null
  || typeof manifest.artifacts !== 'object') {
  throw new Error('Geometry WASM manifest does not match the pinned build contract');
}
const artifactNames = Object.keys(manifest.artifacts).sort();
if (JSON.stringify(artifactNames) !== JSON.stringify(expectedArtifactNames)) {
  throw new Error('Geometry WASM manifest contains an unexpected artifact set');
}

for (const [name, expected] of Object.entries(manifest.artifacts)) {
  if (expected === null
    || typeof expected !== 'object'
    || !Number.isSafeInteger(expected.bytes)
    || expected.bytes < 0
    || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    throw new Error(`Geometry WASM manifest entry is invalid: ${name}`);
  }
  const artifactPath = resolve(artifactDirectory, name);
  const bytes = readFileSync(artifactPath);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (statSync(artifactPath).size !== expected.bytes || actualHash !== expected.sha256) {
    throw new Error(`Geometry WASM artifact is not deterministic: ${name}`);
  }
}

process.stdout.write(
  `Verified ${Object.keys(manifest.artifacts).length} tracked geometry WASM artifacts (${manifest.rustToolchain}, wasm-pack ${manifest.wasmPack})\n`,
);
