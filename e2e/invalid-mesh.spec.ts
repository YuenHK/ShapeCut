import { test, expect } from '@playwright/test';

test('blocks an open STL before axis selection', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('STL 模型檔案').setInputFiles('fixtures/stl/open-triangle.stl');
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByRole('alert')).toContainText('開放邊界');
  await expect(page.getByRole('heading', { name: '匯入與修復' })).toBeVisible();
});
