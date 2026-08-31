import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('geometry WASM build contract', () => {
  it('preserves existing encoded Rust flags and appends path remaps as unit-separated flags', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'geometry-wasm-flags-'));
    temporaryDirectories.push(directory);
    const fakeWasmPack = resolve(directory, 'wasm-pack');
    const capturePath = resolve(directory, 'capture.json');
    writeFileSync(fakeWasmPack, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') {
  process.stdout.write('wasm-pack 0.15.0\\n');
  process.exit(0);
}
writeFileSync(process.env.FLAG_CAPTURE, JSON.stringify({
  encoded: process.env.CARGO_ENCODED_RUSTFLAGS,
  rustflags: process.env.RUSTFLAGS,
}));
process.exit(73);
`);
    chmodSync(fakeWasmPack, 0o755);
    const existingFlags = ['-Ctarget-feature=+bulk-memory', '--cfg=含 中文 空格'].join('\u001f');

    const result = spawnSync(process.execPath, [resolve(repositoryRoot, 'scripts/build-geometry-wasm.mjs')], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CARGO_ENCODED_RUSTFLAGS: existingFlags,
        FLAG_CAPTURE: capturePath,
        RUSTFLAGS: '--cfg=must-not-be-forwarded',
        WASM_PACK: fakeWasmPack,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(73);
    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      encoded?: string;
      rustflags?: string;
    };
    expect(capture.rustflags).toBeUndefined();
    const encoded = capture.encoded?.split('\u001f');
    expect(encoded?.slice(0, 2)).toEqual(existingFlags.split('\u001f'));
    expect(encoded?.slice(2)).toEqual([
      `--remap-path-prefix=${repositoryRoot}=/workspace/repository`,
      `--remap-path-prefix=${process.env.HOME}=/workspace/home`,
    ]);
  });

  it('keeps standard Node and Pages builds on tracked generated artifacts', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.prebuild).toBeUndefined();
    expect(packageJson.scripts['pretest:browser']).toBeUndefined();
    expect(packageJson.scripts['verify:geometry-wasm-generated'])
      .toBe('node scripts/verify-geometry-wasm-generated.mjs');
    expect(packageJson.scripts['verify:geometry-wasm-regeneration'])
      .toBe('node scripts/verify-geometry-wasm-regeneration.mjs');

    const tracked = spawnSync('git', ['ls-files', 'src/wasm/generated'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).stdout.trim().split('\n');
    expect(tracked).toEqual(expect.arrayContaining([
      'src/wasm/generated/geometry_wasm.js',
      'src/wasm/generated/geometry_wasm_bg.wasm',
      'src/wasm/generated/geometry_wasm.manifest.json',
    ]));

    const pagesWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-pages.yml'),
      'utf8',
    );
    expect(pagesWorkflow).toContain('npm run verify:geometry-wasm-generated');
    expect(pagesWorkflow).not.toMatch(/wasm-pack|rustup|cargo install/);

    const regenerationWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/verify-geometry-wasm.yml'),
      'utf8',
    );
    expect(regenerationWorkflow).toContain('rustup toolchain install 1.98.0');
    expect(regenerationWorkflow).toContain('cargo install wasm-pack --version 0.15.0 --locked');
    expect(regenerationWorkflow).toContain('npm run verify:geometry-wasm-regeneration');
  });
});
