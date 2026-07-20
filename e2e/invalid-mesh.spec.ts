import { expect, test } from '@playwright/test';
import { expectNoEngineeringControls, selectModel } from './helpers';

test('an open triangle fails closed without exposing repair controls', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/stl/open-triangle.stl');
  await expect(page.getByRole('alert')).toContainText('找不到足夠的有效外形');
  await expectNoEngineeringControls(page);
});
