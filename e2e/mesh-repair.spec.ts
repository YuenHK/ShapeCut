import { expect, test } from '@playwright/test';
import { selectModel } from './helpers';

test('an open STL fails plainly when it has no valid projected outline', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/invalid-open.stl');
  await expect(page.getByRole('alert')).toContainText('找不到足夠的有效外形');
});

test('an empty STL fails in plain language and permits another selection', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, { name: 'empty.stl', mimeType: 'model/stl', buffer: Buffer.from('solid empty\nendsolid empty\n') });
  await expect(page.getByRole('alert')).toContainText('這個檔案不是可讀取的 STL');
  await expect(page.getByRole('button', { name: '選擇另一個模型' })).toBeVisible();
});
