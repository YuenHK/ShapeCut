import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../src/domain/outline-features/hole';
import {
  compareDownloadedOutlineBytes,
  downloadAndInspectOutline,
  expectFiniteClosedSingleContours,
  expectRetainedHoleGeometry,
  expectReleaseAssemblyGeometry,
  expectResult,
  expectSharedCentralHoleGeometry,
  installWorkerResultProbe,
  measureCompleteReleaseRun,
  readLatestWorkerResultSummary,
  readWorkerProbeState,
  selectModel,
} from './helpers';

const fixtures = [
  { env: 'KNIGHT_FORTRESS_STL', path: process.env.KNIGHT_FORTRESS_STL, label: 'Supplied model A', caseId: 'reference-a' },
  { env: 'KNIGHT_FORTRESS_GROUP_STL', path: process.env.KNIGHT_FORTRESS_GROUP_STL, label: 'Supplied model B', caseId: 'reference-b' },
] as const;

type ReleaseFixture = typeof fixtures[number];

async function captureCompleteReleaseRun(page: Page, fixture: ReleaseFixture) {
  return measureCompleteReleaseRun(async () => {
    await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'upload');
    await selectModel(page, fixture.path!);
    await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'processing');
    await expectResult(page, '需注意', '2.5D 外形');
    await expect(page.getByRole('link', { name: '下載 ZIP 製作套件' })).toBeVisible();
    await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'result');
    await page.getByRole('tab', { name: '處理提示' }).click();
    await expect(page.getByRole('region', { name: '模型處理提示' }))
      .toContainText('模型已使用 2.5D 外形簡化');
    const viewport = page.getByRole('img', { name: /真實網格和爆炸圖/ });
    await expect(viewport).toBeVisible();

    const runtime = await readLatestWorkerResultSummary(page);
    expect(runtime).toMatchObject({ mode: 'outline-2.5d', status: 'warning' });
    if (fixture.env === 'KNIGHT_FORTRESS_GROUP_STL') {
      expect(runtime.featureWarnings).toContain(CENTRAL_HOLE_OMISSION_WARNING);
      expect(runtime.coloredLayers.every((layer) => layer.hole.status === 'omitted')).toBe(true);
    }
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
      'launcher-fit-coupon.svg',
      'manifest.json',
      'preview.pdf',
      'project.json',
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
    return { runtime, output, retainedHoleCount: retainedHoles.length };
  });
}

function expectFullRunDuration(durationMs: number): void {
  expect(durationMs).toBeGreaterThanOrEqual(8_000);
  expect(durationMs).toBeLessThan(60_000);
}

for (const fixture of fixtures) {
  test(`${fixture.label} completes warning-mode output with six reconciled downloads`, async ({ page }, testInfo) => {
    test.skip(!fixture.path, `${fixture.env} is not available; run this conditional acceptance with the external fixture`);
    expect(existsSync(fixture.path!), `${fixture.env} must point to a readable file`).toBe(true);
    test.setTimeout(120_000);
    await installWorkerResultProbe(page);
    await page.goto('/');
    const first = await captureCompleteReleaseRun(page, fixture);
    expectFullRunDuration(first.durationMs);

    await page.getByRole('button', { name: '捨棄已儲存專案並選擇另一個模型' }).click();
    await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'upload');
    await page.reload();
    const repeated = await captureCompleteReleaseRun(page, fixture);
    expectFullRunDuration(repeated.durationMs);
    expect(repeated.value.runtime).toEqual(first.value.runtime);
    const byteComparison = compareDownloadedOutlineBytes(first.value.output, repeated.value.output);

    await testInfo.attach(`${fixture.caseId}-result.json`, {
      body: JSON.stringify({
        mode: first.value.runtime.mode,
        layers: first.value.output.layers.length,
        removedComponentCount: first.value.runtime.removedComponentCount,
        retainedHoleCount: first.value.retainedHoleCount,
        deepFeatureCount: first.value.output.entityCounts.DEEP_RED,
        lightFeatureCount: first.value.output.entityCounts.LIGHT_BLUE,
        launcherStatus: first.value.runtime.assembly!.launcher.status,
        fastenerCount: first.value.runtime.assembly!.fastener.count,
        finishedFastenerDiameterMm: first.value.runtime.assembly!.fastener.finishedDiameterMm,
        compensatedFastenerPathDiameterMm: first.value.runtime.assembly!.fastener.pathDiameterMm,
        topFeatures: first.value.runtime.assembly!.topFeatures,
        warningCount: first.value.runtime.featureWarnings.length,
        zipEntryCount: first.value.output.zipRecords.length,
        deterministic: byteComparison.byteIdentical,
        comparedArtifactCount: byteComparison.comparedArtifactCount,
        comparedByteCount: Object.values(byteComparison.byteLengths).reduce((sum, count) => sum + count, 0),
        diagnosticSha256Equal: byteComparison.diagnosticSha256.first === byteComparison.diagnosticSha256.repeated,
        timing: {
          interval: 'upload-to-reconciled-six-downloads',
          firstFullRunDurationMs: first.durationMs,
          repeatedFullRunDurationMs: repeated.durationMs,
        },
      }),
      contentType: 'application/json',
    });
  });
}
