import { test, expect } from '@playwright/test';
import { importAndReachDecomposition } from './helpers';

test('converts a real symmetric spinner but blocks production export while physical evidence is pending', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await importAndReachDecomposition(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await page.getByRole('button', { name: '接受拆件建議' }).click();
  await page.getByLabel('材料設定檔', { exact: true }).selectOption('plywood-3');
  await page.getByRole('button', { name: '產生雕刻與材料設定' }).click();

  await expect(page.getByLabel('排版與輸出').getByRole('button', { name: /Production export requires exact material identity/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '匯出製作套件' })).toBeDisabled();
});

test('reloads a saved project only after the original STL and repaired mesh are reverified', async ({ page }) => {
  await page.goto('/');
  await importAndReachDecomposition(page, 'fixtures/stl/symmetric-spinner.stl');

  await expect.poll(() => page.evaluate(async () => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open('spinner-laser-kit');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction('projects', 'readonly').objectStore('projects').get('untitled-project');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        database.close();
        resolve(request.result);
      };
    };
  }))).toMatchObject({
    step: 'decomposition',
    repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1', meshSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
  });

  await page.reload();
  await page.getByLabel('開啟已儲存專案').selectOption('untitled-project');
  await page.getByRole('button', { name: '載入專案' }).click();
  await expect(page.getByText(/請重新附加原始 STL/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '匯入與修復' })).toBeVisible();
  await expect(page.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();

  await page.getByLabel('STL 模型檔案').setInputFiles('fixtures/stl/open-triangle.stl');
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByRole('alert')).toContainText('原始 STL 指紋不符');
  await expect(page.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();

  await page.getByLabel('STL 模型檔案').setInputFiles('fixtures/stl/symmetric-spinner.stl');
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByRole('heading', { name: '自動拆件' })).toBeVisible();
  await expect(page.getByRole('button', { name: '紋理與材料' })).toBeDisabled();
});
