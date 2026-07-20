import { expect, test } from '@playwright/test';
import { expectNoEngineeringControls, selectModel } from './helpers';

test('low-symmetry input never asks the user to confirm an axis', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/low-symmetry.stl');
  await expect(page.getByRole('heading', { name: '轉換完成' }).or(page.getByRole('heading', { name: '這次未能完成' }))).toBeVisible({ timeout: 60_000 });
  await expectNoEngineeringControls(page);
  await expect(page.getByLabel(/手動軸心|手動方向/)).toHaveCount(0);
});
