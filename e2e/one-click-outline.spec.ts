import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  downloadAndInspectOutline,
  expectFiniteClosedSingleContours,
  expectRetainedHoleGeometry,
  expectReleaseAssemblyGeometry,
  expectResult,
  expectSharedCentralHoleGeometry,
  installWorkerResultProbe,
  readLatestWorkerResultSummary,
  readWorkerProbeState,
  selectModel,
} from './helpers';

const fixtures = [
  { env: 'KNIGHT_FORTRESS_STL', path: process.env.KNIGHT_FORTRESS_STL, label: 'Supplied model A', caseId: 'reference-a' },
  { env: 'KNIGHT_FORTRESS_GROUP_STL', path: process.env.KNIGHT_FORTRESS_GROUP_STL, label: 'Supplied model B', caseId: 'reference-b' },
] as const;

for (const fixture of fixtures) {
  test(`${fixture.label} completes warning-mode output with five reconciled downloads`, async ({ page }, testInfo) => {
    expect(fixture.path, `${fixture.env} must point to the external local acceptance fixture`).toBeTruthy();
    expect(existsSync(fixture.path!), `${fixture.env} must point to a readable file`).toBe(true);
    test.setTimeout(120_000);
    await installWorkerResultProbe(page);
    await page.goto('/');
    const selectedAt = Date.now();
    await selectModel(page, fixture.path!);
    await expectResult(page, '需注意', '2.5D 外形');
    const firstDurationMs = Date.now() - selectedAt;
    expect(firstDurationMs).toBeGreaterThanOrEqual(8_000);
    expect(firstDurationMs).toBeLessThan(60_000);
    await expect(page.getByRole('region', { name: '模型處理提示' }))
      .toContainText('模型已使用 2.5D 外形簡化');
    const viewport = page.getByRole('img', { name: /真實網格和爆炸圖/ });
    await expect(viewport).toBeVisible();

    const runtime = await readLatestWorkerResultSummary(page);
    expect(runtime).toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    if (fixture.env === 'KNIGHT_FORTRESS_GROUP_STL') expect(runtime.removedComponentCount).toBeGreaterThan(0);
    const output = await downloadAndInspectOutline(page);
    const probe = await readWorkerProbeState(page);
    await expect(viewport).toHaveAttribute('data-layer-count', String(output.layers.length));
    expectFiniteClosedSingleContours(output);
    expectSharedCentralHoleGeometry(runtime);
    expectReleaseAssemblyGeometry(runtime, output);
    expect(output.zipRecords.map(({ name }) => name).sort()).toEqual([
      'cut-and-engrave.dxf',
      'cut-and-engrave.svg',
      'exploded-view.pdf',
      'preview.pdf',
    ]);

    const retainedHoles = runtime.coloredLayers.filter((layer) => layer.hole.status === 'retained');
    const exportedCentralHoles = output.entities.filter(({ role, id }) => (
      role === 'CUT_BLACK' && id.endsWith('-hole') && !id.includes('-fastener-hole-')
    ));
    expect(exportedCentralHoles).toHaveLength(retainedHoles.length);
    const projectedCandidates = probe.holeCandidates.filter(({ extractionMode }) => extractionMode === 'projected');
    expect(projectedCandidates).toHaveLength(runtime.coloredLayers.length);
    expect(new Set(projectedCandidates.map(({ layerId }) => layerId)).size).toBe(runtime.coloredLayers.length);
    retainedHoles.forEach((layer) => {
      const geometry = expectRetainedHoleGeometry(layer);
      const exportedHole = exportedCentralHoles.find(({ physicalLayerId }) => physicalLayerId === layer.id);
      expect(exportedHole).toBeDefined();
      expect(exportedHole!.points).toHaveLength(layer.hole.points!.length);
      const translation = [
        exportedHole!.points[0][0] - layer.hole.points![0][0],
        exportedHole!.points[0][1] - layer.hole.points![0][1],
      ] as const;
      exportedHole!.points.forEach((point, index) => {
        expect(Math.abs(point[0] - layer.hole.points![index][0] - translation[0])).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(point[1] - layer.hole.points![index][1] - translation[1])).toBeLessThanOrEqual(1e-9);
      });
      expect(geometry.minimumDiameterMm).toBeGreaterThan(0);
    });
    expect(output.entityCounts.DEEP_RED).toBe(runtime.coloredLayers.reduce((sum, layer) => sum + layer.deepFeatures!.length, 0));
    expect(output.entityCounts.LIGHT_BLUE).toBe(runtime.coloredLayers.reduce((sum, layer) => sum + layer.lightFeatures!.length, 0));

    await page.reload();
    const repeatedAt = Date.now();
    await selectModel(page, fixture.path!);
    await expectResult(page, '需注意', '2.5D 外形');
    const repeatedRuntime = await readLatestWorkerResultSummary(page);
    const repeatedOutput = await downloadAndInspectOutline(page);
    const repeatedDurationMs = Date.now() - repeatedAt;
    expect(repeatedDurationMs).toBeGreaterThanOrEqual(8_000);
    expect(repeatedDurationMs).toBeLessThan(60_000);
    expectReleaseAssemblyGeometry(repeatedRuntime, repeatedOutput);
    expect(repeatedRuntime).toEqual(runtime);
    expect(repeatedOutput.sha256).toBe(output.sha256);

    await testInfo.attach(`${fixture.caseId}-result.json`, {
      body: JSON.stringify({
        mode: runtime.mode,
        layers: output.layers.length,
        removedComponentCount: runtime.removedComponentCount,
        retainedHoleCount: retainedHoles.length,
        deepFeatureCount: output.entityCounts.DEEP_RED,
        lightFeatureCount: output.entityCounts.LIGHT_BLUE,
        launcherStatus: runtime.assembly!.launcher.status,
        fastenerCount: runtime.assembly!.fastener.count,
        finishedFastenerDiameterMm: runtime.assembly!.fastener.finishedDiameterMm,
        compensatedFastenerPathDiameterMm: runtime.assembly!.fastener.pathDiameterMm,
        topFeatures: runtime.assembly!.topFeatures,
        warningCount: runtime.featureWarnings.length,
        zipEntryCount: output.zipRecords.length,
        deterministic: repeatedOutput.sha256 === output.sha256,
        timing: { firstDurationMs, repeatedDurationMs },
      }),
      contentType: 'application/json',
    });
  });
}
