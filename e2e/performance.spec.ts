import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { selectModel } from './helpers';

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

test.describe.configure({ mode: 'serial' });

test('100k triangle selection stays off the main thread and reaches a bounded result', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.goto('/');
  await page.evaluate(() => { (window as unknown as { longTasks: { startTime: number; duration: number }[] }).longTasks = []; new PerformanceObserver((list) => (window as unknown as { longTasks: { startTime: number; duration: number }[] }).longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))).observe({ type: 'longtask', buffered: true }); });
  const started = Date.now();
  const fixturePath = testInfo.outputPath('100k.stl');
  await writeFile(fixturePath, binaryTetrahedra(100_000));
  const fileSelected = await page.evaluate(() => performance.now());
  await selectModel(page, fixturePath);
  await expect(page.getByRole('status').filter({ hasText: /轉換完成/ }).or(page.getByRole('alert'))).toBeVisible({ timeout: 35_000 });
  const elapsedMs = Date.now() - started;
  const longestMainThreadTaskMs = await page.evaluate((selected) => Math.max(0, ...(window as unknown as { longTasks: { startTime: number; duration: number }[] }).longTasks.filter(({ startTime }) => startTime >= selected).map(({ duration }) => duration)), fileSelected);
  await testInfo.attach('100k-performance.json', { body: JSON.stringify({ elapsedMs, longestMainThreadTaskMs }), contentType: 'application/json' });
  expect(elapsedMs).toBeLessThan(35_000);
  expect(longestMainThreadTaskMs).toBeLessThan(100);
});

test('500k triangle selection fails within the resource/time boundary', async ({ page }, testInfo) => {
  test.setTimeout(25_000);
  await page.goto('/');
  const started = Date.now();
  const fixturePath = testInfo.outputPath('500k.stl');
  await writeFile(fixturePath, binaryTetrahedra(500_000));
  await selectModel(page, fixturePath);
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(/模型太複雜|處理時間過長/);
  const elapsedMs = Date.now() - started;
  await testInfo.attach('500k-performance.json', { body: JSON.stringify({ elapsedMs, outcome: await alert.textContent() }), contentType: 'application/json' });
  expect(elapsedMs).toBeLessThan(20_000);
});
