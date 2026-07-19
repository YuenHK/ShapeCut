import { expect, type Page } from '@playwright/test';

export async function importAndReachDecomposition(page: Page, fixture: string) {
  await page.getByLabel('STL 模型檔案').setInputFiles(fixture);
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByRole('heading', { name: '軸心', exact: true })).toBeVisible();
  const automaticConfirmation = page.getByRole('button', { name: '確認軸心' });
  if (await automaticConfirmation.isEnabled()) {
    await automaticConfirmation.click();
  } else {
    await page.getByLabel('手動原點 X').fill('0');
    await page.getByLabel('手動原點 Y').fill('0');
    await page.getByLabel('手動原點 Z').fill('0');
    await page.getByLabel('手動方向 X').fill('0');
    await page.getByLabel('手動方向 Y').fill('0');
    await page.getByLabel('手動方向 Z').fill('1');
    await page.getByRole('button', { name: '確認手動軸心' }).click();
  }
  await page.getByRole('button', { name: '下一步' }).click();
}
