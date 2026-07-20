import { expect, test } from '@playwright/test';
import { expectResult, selectModel } from './helpers';

test('universal output asks for no material profile and exposes no machine recipe', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expectResult(page, '成功', '精確切片');
  await expect(page.getByText('通用切割外形', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
});
