import { expect, type Page } from '@playwright/test';

export async function importAndReachDecomposition(page: Page, fixture: string) {
  await page.getByLabel('STL 模型檔案').setInputFiles(fixture);
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByRole('heading', { name: '軸心', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '確認軸心' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
}
