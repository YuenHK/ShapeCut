import { expect, test } from '@playwright/test';
import { appendFile, writeFile } from 'node:fs/promises';
import {
  armWorkerPackageReplacement,
  downloadAndInspectOutline,
  expectResult,
  installWorkerResultProbe,
  launcherCompatibleStlFixture,
  readWorkerProbeState,
  selectModel,
} from './helpers';

function binaryTetrahedra(triangleCount: number): Buffer {
  const buffer = Buffer.allocUnsafe(84 + triangleCount * 50); buffer.fill(0, 0, 80); buffer.writeUInt32LE(triangleCount, 80);
  const faces = [[0, 2, 1], [0, 3, 2], [0, 1, 3], [3, 1, 2]] as const;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const tetra = Math.floor(triangle / 4), x = (tetra % 250) * 3, y = (Math.floor(tetra / 250) % 100) * 3, z = Math.floor(tetra / 25_000) * 3;
    const vertices = [[x, y, z + 1], [x - 1, y - 1, z], [x + 1, y - 1, z], [x, y + 1, z]], face = faces[triangle % 4], offset = 84 + triangle * 50;
    for (let corner = 0; corner < 3; corner += 1) for (let component = 0; component < 3; component += 1) buffer.writeFloatLE(vertices[face[corner]][component], offset + 12 + corner * 12 + component * 4);
    buffer.writeUInt16LE(0, offset + 48);
  }
  return buffer;
}

async function installLongTaskObserver(page: Parameters<typeof selectModel>[0]): Promise<void> {
  await page.evaluate(() => {
    const state = { selectedAt: 0, previewAt: 0, resultAt: 0, downloadsAt: 0, entries: [] as Array<{ startTime: number; duration: number }> };
    Object.assign(window, { __shapeCutPerformance: state });
    new PerformanceObserver((list) => state.entries.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))))
      .observe({ type: 'longtask', buffered: true });
  });
}

async function mark(page: Parameters<typeof selectModel>[0], field: 'selectedAt' | 'previewAt' | 'resultAt' | 'downloadsAt'): Promise<void> {
  await page.evaluate((name) => {
    const state = (window as unknown as { __shapeCutPerformance: Record<string, number> }).__shapeCutPerformance;
    state[name] = performance.now();
  }, field);
}

async function performanceEvidence(page: Parameters<typeof selectModel>[0]) {
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    const state = (window as unknown as { __shapeCutPerformance: {
      selectedAt: number; previewAt: number; resultAt: number; downloadsAt: number;
      entries: Array<{ startTime: number; duration: number }>;
    } }).__shapeCutPerformance;
    const relevant = state.entries.filter(({ startTime }) => startTime >= state.selectedAt && startTime <= state.downloadsAt);
    const canvas = document.querySelector<HTMLCanvasElement>('.outline-process-webgl canvas');
    const context = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    const webglBackend = context ? {
      version: context.getParameter(context.VERSION) as string,
      vendor: context.getParameter(context.VENDOR) as string,
      renderer: context.getParameter(context.RENDERER) as string,
      unmaskedVendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) as string : null,
      unmaskedRenderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null,
    } : null;
    return {
      ...state,
      entries: relevant,
      longestMainThreadTaskMs: Math.max(0, ...relevant.map(({ duration }) => duration)),
      webglBackend,
    };
  });
}

test.describe.configure({ mode: 'serial' });

test('safe conversion has no 100 ms main-thread task through preview, explosion, both PDFs, and URLs', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.goto('/');
  await selectModel(page, launcherCompatibleStlFixture(), async () => {
    await installLongTaskObserver(page);
    await mark(page, 'selectedAt');
  }, async () => {
    await mark(page, 'previewAt');
  });
  await expect(page.locator('.outline-process-webgl canvas')).toBeVisible({ timeout: 30_000 });
  await expectResult(page, '需注意', '精確切片');
  await expect(page.getByRole('img', { name: /真實網格和爆炸圖/ })).toBeVisible();
  await mark(page, 'resultAt');
  const output = await downloadAndInspectOutline(page);
  await mark(page, 'downloadsAt');
  const evidence = await performanceEvidence(page);
  await testInfo.attach('complete-pipeline-performance.json', { body: JSON.stringify({ ...evidence, zipSha256: output.sha256 }), contentType: 'application/json' });
  expect(evidence.previewAt).toBeGreaterThanOrEqual(evidence.selectedAt);
  expect(evidence.resultAt).toBeGreaterThanOrEqual(evidence.previewAt);
  expect(evidence.downloadsAt).toBeGreaterThanOrEqual(evidence.resultAt);
  expect(evidence.entries.filter(({ duration }) => duration >= 100), JSON.stringify(evidence)).toEqual([]);
  expect(evidence.longestMainThreadTaskMs).toBeLessThan(100);
  expect(evidence.webglBackend?.renderer).toEqual(expect.any(String));
});

test('100k triangle selection stays off the main thread and reaches a bounded result classification', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await installWorkerResultProbe(page);
  await page.goto('/');
  const fixturePath = testInfo.outputPath('100k.stl');
  await writeFile(fixturePath, binaryTetrahedra(100_000));
  const started = Date.now();
  await selectModel(page, fixturePath, async () => {
    await installLongTaskObserver(page);
    await mark(page, 'selectedAt');
  }, () => mark(page, 'previewAt'));
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 35_000 });
  await mark(page, 'downloadsAt');
  const elapsedMs = Date.now() - started;
  const evidence = await performanceEvidence(page);
  const probe = await readWorkerProbeState(page);
  const terminalCode = probe.errorCodes.at(-1);
  expect(terminalCode).toMatch(/^(?:NO_OUTLINE|RESOURCE_LIMIT|TIME_LIMIT)$/);
  await expect(alert).toContainText(terminalCode === 'NO_OUTLINE'
    ? /找不到足夠的有效外形/
    : /模型太複雜|處理時間過長/);
  await testInfo.attach('100k-performance.json', { body: JSON.stringify({ elapsedMs, outcome: await alert.textContent(), errorCodes: probe.errorCodes, ...evidence }), contentType: 'application/json' });
  expect(elapsedMs).toBeLessThan(35_000);
  expect(evidence.previewAt).toBeGreaterThanOrEqual(evidence.selectedAt);
  expect(evidence.entries.filter(({ duration }) => duration >= 100)).toEqual([]);
  expect(probe.errorCodes).toContain(terminalCode);
});

for (const triangleCount of [200_000, 500_000, 1_000_000]) test(`${triangleCount} triangle intended pipeline stays responsive and reaches a bounded terminal outcome`, async ({ page }, testInfo) => {
  test.skip(process.env.SHAPECUT_RELEASE_BENCHMARK !== '1', 'Explicit fixed-host release benchmark only');
  test.setTimeout(125_000);
  await installWorkerResultProbe(page);
  await page.goto('/?shapecut-wasm-rollout=1');
  const fixturePath = testInfo.outputPath(`${triangleCount}.stl`);
  await writeFile(fixturePath, binaryTetrahedra(triangleCount));
  const started = Date.now();
  await selectModel(page, fixturePath, async () => {
    await installLongTaskObserver(page);
    await mark(page, 'selectedAt');
  }, async () => {
    await mark(page, 'previewAt');
  });
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 120_000 });
  await mark(page, 'downloadsAt');
  const elapsedMs = Date.now() - started;
  const evidence = await performanceEvidence(page);
  const probe = await readWorkerProbeState(page);
  process.stdout.write(`synthetic-release-benchmark ${triangleCount} ${JSON.stringify({
    elapsedMs,
    longestMainThreadTaskMs: evidence.longestMainThreadTaskMs,
    peakAttributableLiveBytes: Math.max(...probe.memoryObservations.map(({ totalBytes }) => totalBytes)),
    outcome: probe.errorCodes.at(-1),
    wasmPublications: probe.wasmPublications,
  })}\n`);
  if (process.env.SHAPECUT_RELEASE_EVIDENCE_LOG) await appendFile(
    process.env.SHAPECUT_RELEASE_EVIDENCE_LOG,
    `${JSON.stringify({
      caseId: `synthetic-${triangleCount}`,
      runIndex: testInfo.repeatEachIndex,
      triangleCount,
      layerCount: 0,
      measurementInterval: 'selection-to-terminal',
      elapsedMs,
      longestMainThreadTaskMs: evidence.longestMainThreadTaskMs,
      peakAttributableLiveBytes: Math.max(...probe.memoryObservations.map(({ totalBytes }) => totalBytes)),
      outcome: probe.errorCodes.at(-1),
      actualWasmPublications: probe.wasmPublications,
    })}\n`,
  );
  await testInfo.attach(`${triangleCount}-performance.json`, { body: JSON.stringify({ triangleCount, elapsedMs, ...probe, ...evidence }), contentType: 'application/json' });
  expect(elapsedMs).toBeLessThan(120_000);
  expect(evidence.previewAt).toBeGreaterThanOrEqual(evidence.selectedAt);
  expect(evidence.longestMainThreadTaskMs).toBeGreaterThanOrEqual(0);
  expect(probe.wasmStartRequests).toBe(0);
  expect(probe.errorCodes.at(-1)).toMatch(/^(?:NO_OUTLINE|RESOURCE_LIMIT|TIME_LIMIT)$/);
});

test('feature-rich PDF packaging is terminated and replaced by a second complete result', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await installWorkerResultProbe(page);
  await page.goto('/');
  const replacement = launcherCompatibleStlFixture('replacement-safe.stl');
  await selectModel(
    page, launcherCompatibleStlFixture('initial-safe.stl'),
    () => armWorkerPackageReplacement(page, replacement),
  );
  const expectedWorkload = [{
    layers: 24, contoursPerLayer: 4.25,
    minimumPointsPerContour: 96, maximumPointsPerContour: 256, totalPoints: 25_152,
  }];
  await expect.poll(async () => (await readWorkerProbeState(page)).packageWorkloads, { timeout: 15_000 })
    .toEqual(expectedWorkload);
  const armed = await readWorkerProbeState(page);
  await expect(page.getByText('replacement-safe.stl', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expectResult(page, '需注意', '精確切片');
  const output = await downloadAndInspectOutline(page);
  const probe = await readWorkerProbeState(page);
  await testInfo.attach('package-replacement.json', { body: JSON.stringify({ ...probe, replacementSha256: output.sha256 }), contentType: 'application/json' });
  expect(probe.packageRequests).toBeGreaterThanOrEqual(2);
  expect(probe.packageCheckpoints).toContain('pdf:create:before');
  expect(probe.replacementCheckpoint).toBe('pdf:create:before');
  expect(probe.replacementTriggered).toBe(1);
  expect(probe.terminated).toBeGreaterThanOrEqual(1);
  expect(probe.created).toBeGreaterThanOrEqual(2);
  const initialTop = probe.results[0].coloredLayers.at(-1)!;
  expect(probe.results[0].assembly!.topFeatures.retained).toEqual({
    red: initialTop.deepFeatures!.length,
    blue: initialTop.lightFeatures!.length,
  });
  expect(probe.results.at(-1)).toMatchObject({ mode: 'exact' });
  expect(probe.packageWorkloads).toEqual(armed.packageWorkloads);
});
