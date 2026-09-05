import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('release privacy scan needs no external search executable and fails closed without disclosing content', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'release-privacy-'));
  const run = () => spawnSync(process.execPath, ['scripts/verify-release-privacy.mjs', directory], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  try {
    writeFileSync(resolve(directory, 'wasm-geometry-test.json'), '{"caseId":"reference-a"}');
    expect(run().status).toBe(0);
    for (const value of ['/Users/private-person', '\\Users\\private-person', 'private@example.test', 'knight', 'fortress', 'model.stl', 'sha256', 'sourceHash']) {
      writeFileSync(resolve(directory, 'wasm-geometry-test.json'), JSON.stringify({ value }));
      const result = run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(value);
    }
    rmSync(resolve(directory, 'wasm-geometry-test.json'));
    expect(run().status).not.toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
