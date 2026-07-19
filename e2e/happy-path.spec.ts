import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { importAndReachDecomposition } from './helpers';

test('converts a calibrated symmetric spinner into a valid laser-kit ZIP', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await importAndReachDecomposition(page, 'fixtures/stl/symmetric-spinner.stl');
  await page.getByRole('button', { name: '接受拆件建議' }).click();
  await page.getByLabel('材料設定檔').selectOption('plywood-3');
  await page.getByRole('button', { name: '產生雕刻與材料設定' }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出製作套件' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/laser-kit\.zip$/);
  const path = await download.path();
  const zip = await JSZip.loadAsync(await import('node:fs/promises').then(({ readFile }) => readFile(path!)));
  expect(zip.file('03-settings/project-settings.json')).not.toBeNull();
});
