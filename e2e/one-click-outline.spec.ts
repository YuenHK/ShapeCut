import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  downloadAndInspectOutline,
  expectFiniteClosedSingleContours,
  expectRetainedHoleGeometry,
  expectResult,
  installWorkerResultProbe,
  readLatestWorkerResultSummary,
  selectModel,
} from './helpers';

const fixtures = [
  { env: 'KNIGHT_FORTRESS_STL', path: process.env.KNIGHT_FORTRESS_STL, label: 'Knight Fortress' },
  { env: 'KNIGHT_FORTRESS_GROUP_STL', path: process.env.KNIGHT_FORTRESS_GROUP_STL, label: 'Knight Fortress Group' },
] as const;

for (const fixture of fixtures) {
  test(`${fixture.label} completes warning-mode output with five reconciled downloads`, async ({ page }, testInfo) => {
    expect(fixture.path, `${fixture.env} must point to the external local acceptance fixture`).toBeTruthy();
    expect(existsSync(fixture.path!), `${fixture.env} must point to a readable file`).toBe(true);
    test.setTimeout(120_000);
    await installWorkerResultProbe(page);
    await page.goto('/');
    await selectModel(page, fixture.path!);
    await expectResult(page, '需注意', '2.5D 外形');
    await expect(page.getByRole('region', { name: '模型處理提示' }))
      .toContainText('模型已使用 2.5D 外形簡化');
    const viewport = page.getByRole('img', { name: /真實網格和爆炸圖/ });
    await expect(viewport).toBeVisible();

    const runtime = await readLatestWorkerResultSummary(page);
    expect(runtime).toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    if (fixture.env === 'KNIGHT_FORTRESS_GROUP_STL') expect(runtime.removedComponentCount).toBeGreaterThan(0);
    const output = await downloadAndInspectOutline(page);
    await expect(viewport).toHaveAttribute('data-layer-count', String(output.layers.length));
    expectFiniteClosedSingleContours(output);

    const retainedHoles = runtime.coloredLayers.filter((layer) => layer.hole.status === 'retained');
    expect(retainedHoles.length).toBeGreaterThan(0);
    const exportedHoleCount = output.layers.reduce((sum, layer) => sum + Math.max(0, output.entities.filter((entity) => (
      entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK'
    )).length - 1), 0);
    expect(exportedHoleCount).toBe(retainedHoles.length);
    const retainedHoleEvidence = retainedHoles.map((layer) => {
      const exportedBlack = output.entities.filter((entity) => (
        entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK'
      ));
      expect(exportedBlack).toHaveLength(2);
      expect(exportedBlack[1].points).toHaveLength(layer.hole.points!.length);
      const translation = [
        exportedBlack[1].points[0][0] - layer.hole.points![0][0],
        exportedBlack[1].points[0][1] - layer.hole.points![0][1],
      ] as const;
      exportedBlack[1].points.forEach((point, index) => {
        expect(Math.abs(point[0] - layer.hole.points![index][0] - translation[0])).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(point[1] - layer.hole.points![index][1] - translation[1])).toBeLessThanOrEqual(1e-9);
      });
      return { layerId: layer.id, ...expectRetainedHoleGeometry(layer) };
    });
    expect(output.entityCounts.DEEP_RED).toBe(runtime.coloredLayers.filter(({ hasDeep }) => hasDeep).length);
    expect(output.entityCounts.LIGHT_BLUE).toBe(runtime.coloredLayers.filter(({ hasLight }) => hasLight).length);

    await testInfo.attach(`${fixture.label.replaceAll(' ', '-').toLowerCase()}-result.json`, {
      body: JSON.stringify({
        mode: runtime.mode,
        layers: output.layers.length,
        removedComponentCount: runtime.removedComponentCount,
        retainedHoleCount: retainedHoles.length,
        retainedHoleEvidence,
        deepFeatureCount: output.entityCounts.DEEP_RED,
        lightFeatureCount: output.entityCounts.LIGHT_BLUE,
        sha256: output.sha256,
      }),
      contentType: 'application/json',
    });
  });
}
