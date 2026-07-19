import { test, expect } from '@playwright/test';
import { importAndReachDecomposition } from './helpers';

test('requires confirmation for an uncalibrated material profile', async ({ page }) => {
  await page.goto('/');
  await importAndReachDecomposition(page, 'fixtures/stl/symmetric-spinner.stl');
  await page.getByRole('button', { name: '接受拆件建議' }).click();
  await page.getByLabel('材料設定檔').selectOption('cork-3');
  await page.getByRole('button', { name: '產生雕刻與材料設定' }).click();
  await expect(page.getByLabel('排版與輸出').getByRole('button', { name: /材料未校準/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '匯出製作套件' })).toBeDisabled();
});
