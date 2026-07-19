import { test, expect } from '@playwright/test';

function binaryTetrahedra(triangleCount: number): Buffer {
  const buffer = Buffer.allocUnsafe(84 + triangleCount * 50);
  buffer.fill(0, 0, 80);
  buffer.writeUInt32LE(triangleCount, 80);
  const faces = [[0, 2, 1], [0, 3, 2], [0, 1, 3], [3, 1, 2]] as const;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const tetra = Math.floor(triangle / 4);
    const x = (tetra % 250) * 3;
    const y = (Math.floor(tetra / 250) % 100) * 3;
    const z = Math.floor(tetra / 25_000) * 3;
    const vertices = [[x, y, z + 1], [x - 1, y - 1, z], [x + 1, y - 1, z], [x, y + 1, z]];
    const face = faces[triangle % 4];
    const offset = 84 + triangle * 50;
    for (let corner = 0; corner < 3; corner += 1) for (let component = 0; component < 3; component += 1) {
      buffer.writeFloatLE(vertices[face[corner]][component], offset + 12 + corner * 12 + component * 4);
    }
    buffer.writeUInt16LE(0, offset + 48);
  }
  return buffer;
}

test.describe.configure({ mode: 'serial' });

test('100k triangles reaches the interactive axis step within 3 seconds without a >100 ms main-thread task', async ({ page }, testInfo) => {
  const input = binaryTetrahedra(100_000);
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { longTasks: { startTime: number; duration: number }[] }).longTasks = [];
    new PerformanceObserver((list) => (window as unknown as { longTasks: { startTime: number; duration: number }[] }).longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: 'longtask', buffered: true });
  });
  const browserStarted = await page.evaluate(() => performance.now());
  await page.getByLabel('STL 模型檔案').setInputFiles({ name: '100k.stl', mimeType: 'model/stl', buffer: input });
  const fileSelected = await page.evaluate(() => performance.now());
  const started = Date.now();
  const analysisStarted = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: '分析模型' }).click();
  const clickSettled = await page.evaluate(() => performance.now());
  await expect(page.getByRole('heading', { name: '軸心', exact: true })).toBeVisible({ timeout: 10_000 });
  const elapsedMs = Date.now() - started;
  const diagnostics = await page.evaluate(() => ({ axisVisible: performance.now(), longTasks: (window as unknown as { longTasks: { startTime: number; duration: number }[] }).longTasks }));
  const applicationTasks = diagnostics.longTasks.filter(({ startTime }) => startTime >= fileSelected);
  const longestMainThreadTaskMs = Math.max(0, ...applicationTasks.map(({ duration }) => duration));
  await testInfo.attach('100k-performance.json', { body: JSON.stringify({ elapsedMs, longestMainThreadTaskMs, browserStarted, fileSelected, analysisStarted, clickSettled, ...diagnostics }), contentType: 'application/json' });
  expect(elapsedMs).toBeLessThan(3_000);
  expect(longestMainThreadTaskMs).toBeLessThan(100);
});

test('records the bounded 500k-triangle import result', async ({ page }, testInfo) => {
  const input = binaryTetrahedra(500_000);
  await page.goto('/');
  await page.getByLabel('STL 模型檔案').setInputFiles({ name: '500k.stl', mimeType: 'model/stl', buffer: input });
  const started = Date.now();
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  const elapsedMs = Date.now() - started;
  await testInfo.attach('500k-performance.json', { body: JSON.stringify({ elapsedMs, outcome: 'bounded blocking issue' }), contentType: 'application/json' });
  expect(elapsedMs).toBeLessThan(15_000);
});
