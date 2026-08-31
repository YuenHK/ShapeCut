// @vitest-environment node
import { fileURLToPath } from 'node:url';
import type { RollupOutput } from 'rollup';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';

describe('slice worker production build fixture', () => {
  it('emits a dedicated bundled slice worker artifact and references it from the entry', async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        target: 'es2022',
        rollupOptions: {
          input: fileURLToPath(new URL('./slice-worker-pool.build-fixture.ts', import.meta.url)),
        },
      },
    }) as RollupOutput;
    const chunks = result.output.filter((output) => output.type === 'chunk');
    const worker = result.output.find((output) => /slice\.worker-[\w-]+\.js$/.test(output.fileName));
    expect(worker, result.output.map((output) => output.fileName).join(', ')).toBeDefined();
    expect(worker!.type).toBe('asset');
    if (worker?.type !== 'asset') throw new TypeError('slice worker asset was not emitted');
    const workerSource = typeof worker.source === 'string'
      ? worker.source
      : new TextDecoder().decode(worker.source);
    expect(workerSource).toContain('slice-result');
    expect(workerSource).toContain('transfer');
    expect(workerSource).not.toContain('Array.from');
    const craftedWorker = result.output.find(
      (output) => /crafted-production-worker\.test-fixture-[\w-]+\.js$/.test(output.fileName),
    );
    expect(craftedWorker).toBeDefined();
    if (craftedWorker?.type !== 'asset') {
      throw new TypeError('crafted production worker asset was not emitted');
    }
    const craftedSource = typeof craftedWorker.source === 'string'
      ? craftedWorker.source
      : new TextDecoder().decode(craftedWorker.source);
    expect(craftedSource).toContain('crafted-production-worker-contract-surface');
    expect(craftedSource).toMatch(/publisherExported:!1|publisherExported:false/);
    const entry = chunks.find((chunk) => chunk.isEntry);
    expect(entry?.code).toContain(worker!.fileName);
    expect(entry?.code).toContain(craftedWorker.fileName);
  });
});
