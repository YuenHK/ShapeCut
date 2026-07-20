import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { downloadAndInspectOutline, expectFiniteClosedSingleContours, expectResult, selectModel } from './helpers';

const fixtures = [
  { env: 'KNIGHT_FORTRESS_STL', path: process.env.KNIGHT_FORTRESS_STL, label: 'Knight Fortress' },
  { env: 'KNIGHT_FORTRESS_GROUP_STL', path: process.env.KNIGHT_FORTRESS_GROUP_STL, label: 'Knight Fortress Group' },
] as const;

for (const fixture of fixtures) {
  test(`${fixture.label} completes the one-click 2.5D workflow`, async ({ page }, testInfo) => {
    test.skip(!fixture.path || !existsSync(fixture.path), `${fixture.env} must point to the external local acceptance fixture.`);
    test.setTimeout(120_000);
    await page.goto('/');
    await selectModel(page, fixture.path!);
    await expectResult(page, '需注意', '2.5D 外形');
    await expect(page.getByRole('strong').filter({ hasText: /^已簡化模型$/ })).toBeVisible();
    const output = await downloadAndInspectOutline(page);
    expect(output.manifest).toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    expectFiniteClosedSingleContours(output);
    if (fixture.env === 'KNIGHT_FORTRESS_GROUP_STL') expect(output.manifest.removedComponentCount).toBeGreaterThan(0);
    await testInfo.attach(`${fixture.label.replaceAll(' ', '-').toLowerCase()}-result.json`, {
      body: JSON.stringify({ mode: output.manifest.mode, layers: output.manifest.layers.length, removedComponentCount: output.manifest.removedComponentCount, sha256: output.sha256 }),
      contentType: 'application/json',
    });
  });
}
