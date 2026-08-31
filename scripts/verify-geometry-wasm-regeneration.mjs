import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedRustVersionPrefix = 'rustc 1.98.0 ';

function runArtifactVerification(directory) {
  const arguments_ = [resolve(repositoryRoot, 'scripts/verify-geometry-wasm-generated.mjs')];
  if (directory) arguments_.push(directory);
  const verification = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verification.stdout) process.stdout.write(verification.stdout);
  if (verification.stderr) process.stderr.write(verification.stderr);
  if (verification.error) throw verification.error;
  if (verification.status !== 0) process.exit(verification.status ?? 1);
}

const rustVersion = spawnSync('rustc', ['+1.98.0', '--version'], { encoding: 'utf8' });
if (rustVersion.error) throw rustVersion.error;
if (rustVersion.status !== 0 || !rustVersion.stdout.startsWith(expectedRustVersionPrefix)) {
  throw new Error(`Expected Rust 1.98.0; received ${rustVersion.stdout.trim() || 'no version'}`);
}
runArtifactVerification();

const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'geometry-wasm-regeneration-'));
const outputDirectory = resolve(temporaryRoot, 'generated');
try {
  const build = spawnSync(process.execPath, [resolve(repositoryRoot, 'scripts/build-geometry-wasm.mjs')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GEOMETRY_WASM_OUTPUT_DIR: outputDirectory,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);

  runArtifactVerification(outputDirectory);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Pinned geometry WASM regeneration matches tracked artifacts byte-for-byte\n');
