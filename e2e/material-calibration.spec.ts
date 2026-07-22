import { expect, test } from '@playwright/test';
import { expectResult, selectModel } from './helpers';

test('universal output asks for no material profile or machine recipe while allowing local layer preview', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expectResult(page, '需注意', '精確切片');
  await expect(page.getByText('切割外形與相對深淺層級', { exact: true })).toBeVisible();
  await expect(page.getByText('顏色只表示相對深淺層級，不代表實際雷射功率、速度或走刀次數。', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '選擇預覽切片' })).toBeVisible();
  await expect(page.locator('select:not([aria-label="選擇預覽切片"])')).toHaveCount(0);
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
});
