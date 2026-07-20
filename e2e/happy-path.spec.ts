import { expect, test } from '@playwright/test';
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
