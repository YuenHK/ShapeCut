import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDirectory = resolve(repositoryRoot, 'crates/geometry-wasm');
const outputDirectory = process.env.GEOMETRY_WASM_OUTPUT_DIR
  ? resolve(repositoryRoot, process.env.GEOMETRY_WASM_OUTPUT_DIR)
  : resolve(repositoryRoot, 'src/wasm/generated');
const wasmPack = process.env.WASM_PACK ?? 'wasm-pack';
const expectedWasmPackVersion = 'wasm-pack 0.15.0';
const rustPathRemapping = [
  `--remap-path-prefix=${repositoryRoot}=/workspace/repository`,
  `--remap-path-prefix=${homedir()}=/workspace/home`,
];
const cargoEncodedRustFlags = [
  process.env.CARGO_ENCODED_RUSTFLAGS,
  ...rustPathRemapping,
].filter(Boolean).join('\u001f');

const version = spawnSync(wasmPack, ['--version'], { encoding: 'utf8' });
if (version.error) throw version.error;
if (version.status !== 0 || version.stdout.trim() !== expectedWasmPackVersion) {
  throw new Error(`Expected ${expectedWasmPackVersion}; received ${version.stdout.trim() || 'no version'}`);
}

const { RUSTFLAGS: ignoredRustFlags, ...buildEnvironment } = process.env;
void ignoredRustFlags;
const build = spawnSync(wasmPack, [
  'build',
  crateDirectory,
  '--target',
  'web',
  '--release',
  '--no-opt',
  '--out-dir',
  outputDirectory,
  '--out-name',
  'geometry_wasm',
  '--no-pack',
  '--',
  '--locked',
], {
  cwd: repositoryRoot,
  env: {
    ...buildEnvironment,
    CARGO_ENCODED_RUSTFLAGS: cargoEncodedRustFlags,
    CARGO_PROFILE_RELEASE_DEBUG: 'false',
  },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (build.stdout) process.stdout.write(build.stdout);
if (build.stderr) process.stderr.write(build.stderr);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

rmSync(resolve(outputDirectory, '.gitignore'), { force: true });

const generatedFiles = readdirSync(outputDirectory, { recursive: true })
  .map((entry) => resolve(outputDirectory, entry.toString()))
  .filter((entry) => statSync(entry).isFile());
const sourceMaps = generatedFiles.filter((entry) => entry.endsWith('.map'));
if (sourceMaps.length > 0) {
  throw new Error(`WASM build emitted source maps: ${sourceMaps.map((entry) => relative(repositoryRoot, entry)).join(', ')}`);
}
for (const entry of generatedFiles.filter((file) => file.endsWith('.js'))) {
  if (readFileSync(entry, 'utf8').includes('sourceMappingURL=')) {
    throw new Error(`WASM build emitted a source map reference: ${relative(repositoryRoot, entry)}`);
  }
}

const wasmPath = resolve(outputDirectory, 'geometry_wasm_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
for (const forbidden of ['/Users/', '/private/', 'sourceMappingURL=']) {
  if (wasmBytes.includes(Buffer.from(forbidden))) {
    throw new Error(`WASM build retained forbidden path or source-map material: ${forbidden}`);
  }
}
const report = {
  path: relative(repositoryRoot, wasmPath),
  bytes: statSync(wasmPath).size,
  sourceMaps: 0,
};
process.stdout.write(`Geometry WASM size: ${JSON.stringify(report)}\n`);
