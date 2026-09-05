import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const allowedProducerPairs = new Set([
  JSON.stringify([['walrus', '0.26.5'], ['wasm-bindgen', '0.2.127']]),
  JSON.stringify([['walrus', '0.26.4'], ['wasm-bindgen', '0.2.127 (a579ee62b)']]),
]);

function readUnsignedLeb128(bytes, offset) {
  let value = 0, shift = 0;
  for (let count = 0; count < 5; count += 1) {
    if (offset >= bytes.length) throw new Error('Geometry WASM contains a truncated unsigned LEB128 value');
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error('Geometry WASM contains an oversized unsigned LEB128 value');
}

function readWasmString(bytes, offset, limit) {
  const length = readUnsignedLeb128(bytes, offset);
  const end = length.offset + length.value;
  if (end > limit) throw new Error('Geometry WASM contains a truncated metadata string');
  return { value: bytes.subarray(length.offset, end).toString('utf8'), offset: end };
}

function stripKnownProducerSection(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('Geometry WASM output has an invalid module header');
  }
  const chunks = [bytes.subarray(0, 8)];
  let offset = 8, producerSections = 0;
  while (offset < bytes.length) {
    const sectionStart = offset;
    const id = bytes[offset++];
    const size = readUnsignedLeb128(bytes, offset);
    const payloadStart = size.offset, sectionEnd = payloadStart + size.value;
    if (sectionEnd > bytes.length) throw new Error('Geometry WASM contains a truncated section');
    let isProducerSection = false;
    if (id === 0) {
      const sectionName = readWasmString(bytes, payloadStart, sectionEnd);
      if (sectionName.value === 'producers') {
        isProducerSection = true;
        producerSections += 1;
        let cursor = sectionName.offset;
        const fieldCount = readUnsignedLeb128(bytes, cursor); cursor = fieldCount.offset;
        if (fieldCount.value !== 1) throw new Error('Geometry WASM contains unexpected producer metadata fields');
        const fieldName = readWasmString(bytes, cursor, sectionEnd); cursor = fieldName.offset;
        if (fieldName.value !== 'processed-by') throw new Error('Geometry WASM contains an unexpected producer metadata field');
        const valueCount = readUnsignedLeb128(bytes, cursor); cursor = valueCount.offset;
        if (valueCount.value !== 2) throw new Error(`Geometry WASM contains an unexpected producer count: ${valueCount.value}`);
        const producers = [];
        for (let index = 0; index < valueCount.value; index += 1) {
          const name = readWasmString(bytes, cursor, sectionEnd); cursor = name.offset;
          const version = readWasmString(bytes, cursor, sectionEnd); cursor = version.offset;
          producers.push([name.value, version.value]);
        }
        if (cursor !== sectionEnd || !allowedProducerPairs.has(JSON.stringify(producers))) {
          throw new Error(`Geometry WASM contains unrecognized producer metadata: ${JSON.stringify(producers)}`);
        }
      }
    }
    if (!isProducerSection) chunks.push(bytes.subarray(sectionStart, sectionEnd));
    offset = sectionEnd;
  }
  if (producerSections !== 1) throw new Error(`Expected one Geometry WASM producer section; received ${producerSections}`);
  return Buffer.concat(chunks);
}

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
const wasmBytes = stripKnownProducerSection(readFileSync(wasmPath));
writeFileSync(wasmPath, wasmBytes);
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
