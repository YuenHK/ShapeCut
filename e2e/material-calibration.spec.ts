import { expect, test } from '@playwright/test';
import { expectResult, selectModel } from './helpers';

test('universal output asks for no material profile and exposes no machine recipe', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expectResult(page, '需注意', '精確切片');
  await expect(page.getByText('切割外形與相對深淺層級', { exact: true })).toBeVisible();
  await expect(page.getByText('顏色只表示相對深淺層級，不代表實際雷射功率、速度或走刀次數。', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
});
