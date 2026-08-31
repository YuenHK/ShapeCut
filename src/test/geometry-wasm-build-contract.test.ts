import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    const pagesBuildJob = pagesWorkflow.slice(
      pagesWorkflow.indexOf('  build:'),
      pagesWorkflow.indexOf('\n  deploy:'),
    );
    expect(pagesBuildJob).toContain('npm run verify:geometry-wasm-generated');
    expect(pagesBuildJob).not.toMatch(/wasm-pack|rustup|cargo install/);

    const regenerationWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/verify-geometry-wasm.yml'),
      'utf8',
    );
    expect(regenerationWorkflow).toContain('rustup toolchain install 1.98.0');
    expect(regenerationWorkflow).toContain('cargo install wasm-pack --version 0.15.0 --locked');
    expect(regenerationWorkflow).toContain('node scripts/verify-geometry-wasm-regeneration.mjs');
    expect(regenerationWorkflow).not.toContain('npm run verify:geometry-wasm-regeneration');
  });

  it('requires successful pinned source-to-artifact provenance before a main Pages build', () => {
    const pagesWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/deploy-pages.yml'),
      'utf8',
    );
    const regenerationJob = pagesWorkflow.slice(
      pagesWorkflow.indexOf('  regenerate_wasm:'),
      pagesWorkflow.indexOf('\n  build:'),
    );
    expect(regenerationJob).toContain('rustup toolchain install 1.98.0');
    expect(regenerationJob).toContain('cargo install wasm-pack --version 0.15.0 --locked');
    expect(regenerationJob).toContain('node scripts/verify-geometry-wasm-regeneration.mjs');
    expect(regenerationJob).not.toContain('npm run verify:geometry-wasm-regeneration');
    expect(pagesWorkflow).toMatch(/  build:\n    needs: regenerate_wasm\n/);
    expect(pagesWorkflow).toMatch(
      /  deploy:\n    needs:\n      - regenerate_wasm\n      - build\n/,
    );
    expect(pagesWorkflow).toMatch(/push:\n    branches:\n      - main/);

    const regenerationWorkflow = readFileSync(
      resolve(repositoryRoot, '.github/workflows/verify-geometry-wasm.yml'),
      'utf8',
    );
    for (const input of [
      'crates/geometry-wasm/**',
      'scripts/build-geometry-wasm.mjs',
      'scripts/verify-geometry-wasm-generated.mjs',
      'scripts/verify-geometry-wasm-regeneration.mjs',
      '.github/workflows/deploy-pages.yml',
      '.github/workflows/verify-geometry-wasm.yml',
      'package.json',
      'package-lock.json',
      'Cargo.lock',
      'rust-toolchain.toml',
    ]) {
      expect(regenerationWorkflow, `missing provenance trigger for ${input}`)
        .toContain(`- "${input}"`);
    }
  });

  it('pins every third-party action to an immutable full SHA with a version comment', () => {
    const officialPins: Record<string, { readonly sha: string; readonly version: string }> = {
      'actions/checkout': { sha: 'd23441a48e516b6c34aea4fa41551a30e30af803', version: 'v6' },
      'actions/setup-node': { sha: '249970729cb0ef3589644e2896645e5dc5ba9c38', version: 'v6' },
      'actions/configure-pages': { sha: '983d7736d9b0ae728b81ab479565c72886d7745b', version: 'v5' },
      'actions/upload-pages-artifact': { sha: '7b1f4a764d45c48632c6b24a0339c27f5614fb0b', version: 'v4' },
      'actions/deploy-pages': { sha: 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e', version: 'v4' },
    };
    const workflowDirectory = resolve(repositoryRoot, '.github/workflows');
    const workflowPaths = readdirSync(workflowDirectory)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => `.github/workflows/${name}`);
    for (const workflowPath of workflowPaths) {
      const workflow = readFileSync(resolve(repositoryRoot, workflowPath), 'utf8');
      const usesLines = workflow.split('\n').filter((line) => line.includes('uses:'));
      expect(usesLines.length, `${workflowPath} must exercise the pinning gate`).toBeGreaterThan(0);
      for (const line of usesLines) {
        expect(line, `${workflowPath} contains a mutable action ref`)
          .toMatch(/uses:\s+[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}\s+#\s+v\d+/i);
        const match = line.match(/uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(v\d+)/i);
        expect(match).not.toBeNull();
        const expected = officialPins[match![1]];
        expect(expected, `${match![1]} must be resolved from its official repository`).toBeDefined();
        expect({ sha: match![2], version: match![3] }).toEqual(expected);
      }
    }
  });
});
