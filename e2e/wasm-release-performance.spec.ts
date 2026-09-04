import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  downloadAndInspectOutline,
  expectResult,
  installWorkerResultProbe,
  readWorkerProbeState,
  selectModel,
} from './helpers';

const references = [
  { caseId: 'reference-a', path: process.env.KNIGHT_FORTRESS_STL },
  { caseId: 'reference-b', path: process.env.KNIGHT_FORTRESS_GROUP_STL },
] as const;

test.describe.configure({ mode: 'serial' });

for (const reference of references) test(`release benchmark ${reference.caseId}`, async ({ page }, testInfo) => {
  test.skip(process.env.SHAPECUT_RELEASE_BENCHMARK !== '1', 'Explicit fixed-host release benchmark only');
  test.skip(!reference.path || !existsSync(reference.path), 'External reference is not available');
  test.setTimeout(7 * 120_000);
  const measured: Array<{
    conversionStageMs: number;
    fullOneClickMs: number;
    peakAttributableLiveBytes: number;
    layerCount: number;
  }> = [];
  await installWorkerResultProbe(page);

  for (let run = 0; run < 6; run += 1) {
    await page.goto('/?shapecut-wasm-rollout=1');
    const started = performance.now();
    await selectModel(page, reference.path!);
    await expectResult(page, '需注意', '2.5D 外形');
    const converted = performance.now();
    const output = await downloadAndInspectOutline(page);
    const completed = performance.now();
    const probe = await readWorkerProbeState(page);
    expect(probe.errorCodes).toEqual([]);
    const sample = {
      conversionStageMs: Math.round(converted - started),
      fullOneClickMs: Math.round(completed - started),
      peakAttributableLiveBytes: Math.max(...probe.memoryObservations.map(({ totalBytes }) => totalBytes)),
      layerCount: output.layers.length,
      wasmPartitioned: probe.memoryObservations.some(({ stage }) => stage === 'slice-pool:partitions-ready'),
    };
    process.stdout.write(`release-benchmark ${reference.caseId} ${run === 0 ? 'warmup' : `measured-${run}`} ${JSON.stringify(sample)}\n`);
    if (run > 0) measured.push(sample);
    await page.getByRole('button', { name: '捨棄已儲存專案並選擇另一個模型' }).click();
    await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'upload');
  }

  await testInfo.attach(`${reference.caseId}-wasm-release-benchmark.json`, {
    body: JSON.stringify({
      schemaVersion: 1,
      caseId: reference.caseId,
      warmupRuns: 1,
      measuredRuns: measured,
    }),
    contentType: 'application/json',
  });
  expect(measured).toHaveLength(5);
  expect(measured.every(({ conversionStageMs }) => conversionStageMs > 0)).toBe(true);
});
