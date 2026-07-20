import { expect, test } from '@playwright/test';
import { writeBinarySTL } from '../src/domain/mesh/write-stl';
import { separatedClosedCylinders } from '../src/test/mesh-builders';
import { downloadAndInspectOutline, expectFiniteClosedSingleContours, expectResult, selectModel } from './helpers';

test('one selection converts the safe acceptance model through the exact workflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expectResult(page, '成功', '精確切片');
  const output = await downloadAndInspectOutline(page);
  expect(output.manifest).toMatchObject({ mode: 'exact', status: 'success' });
  expectFiniteClosedSingleContours(output);
});

test('reload returns to a private upload state without retaining the STL', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expectResult(page, '成功', '精確切片');
  await page.reload();
  await expect(page.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
  await expect(page.getByText('檔案只在你的瀏覽器內處理，不會上載到伺服器。')).toBeVisible();
  await expect(page.getByText('symmetric-smooth.stl')).toHaveCount(0);
});

test('disconnected safe solids fall back and export authentic removal evidence', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { packageLongTasks: PerformanceEntry[] }).packageLongTasks = [];
    new PerformanceObserver((list) => (window as unknown as { packageLongTasks: PerformanceEntry[] }).packageLongTasks.push(...list.getEntries()))
      .observe({ type: 'longtask', buffered: true });
  });
  const started = await page.evaluate(() => performance.now());
  await selectModel(page, {
    name: 'disconnected-closed-cylinders.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(writeBinarySTL(separatedClosedCylinders(), 'safe')),
  });
  await expectResult(page, '需注意', '2.5D 外形');
  const output = await downloadAndInspectOutline(page);
  expect(output.manifest).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
  expect(output.manifest.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
  expect(output.manifest.removedComponentCount).toBeGreaterThan(0);
  expectFiniteClosedSingleContours(output);
  const longestMainThreadTask = await page.evaluate((startTime) => Math.max(0, ...(window as unknown as { packageLongTasks: PerformanceEntry[] })
    .packageLongTasks.filter((entry) => entry.startTime >= startTime).map((entry) => entry.duration)), started);
  expect(longestMainThreadTask).toBeLessThan(100);
});
