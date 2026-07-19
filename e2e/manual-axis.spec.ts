import { expect, test } from '@playwright/test';

test('keeps the real low-symmetry fixture blocked until a valid manual axis is confirmed', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('STL 模型檔案').setInputFiles('fixtures/acceptance/low-symmetry.stl');
  await page.getByRole('button', { name: '分析模型' }).click();

  await expect(page.getByRole('heading', { name: '軸心', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('需要手動設定');
  const confidence = Number.parseInt((await page.getByLabel('最高候選信心').textContent()) ?? '', 10);
  expect(confidence).toBeLessThan(80);
  await expect(page.getByRole('button', { name: '確認軸心' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();

  for (const label of ['手動原點 X', '手動原點 Y', '手動原點 Z', '手動方向 X', '手動方向 Y', '手動方向 Z']) {
    await page.getByLabel(label).fill('0');
  }
  await expect(page.getByRole('alert')).toHaveText('手動方向必須是非零向量。');
  await expect(page.getByRole('button', { name: '確認手動軸心' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();

  await page.getByLabel('手動方向 Z').fill('2');
  await page.getByRole('button', { name: '確認手動軸心' }).click();
  await expect(page.getByRole('button', { name: '下一步' })).toBeEnabled();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('heading', { name: '自動拆件' })).toBeVisible();
});
