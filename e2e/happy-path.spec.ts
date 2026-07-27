import { expect, test } from '@playwright/test';
import { writeBinarySTL } from '../src/domain/mesh/write-stl';
import type { TriangleMesh } from '../src/domain/mesh/types';
import {
  downloadAndInspectOutline,
  expectFiniteClosedSingleContours,
  expectReleaseAssemblyGeometry,
  expectResult,
  expectSharedCentralHoleGeometry,
  installWorkerResultProbe,
  launcherCompatibleStlFixture,
  readLatestWorkerResultSummary,
  readWorkerProbeState,
  selectModel,
} from './helpers';

const launcherCompatibleFixture = launcherCompatibleStlFixture();
const structurallyImpossibleFixture = launcherCompatibleStlFixture(
  'structurally-impossible-launcher-cylinder.stl',
  6,
);

function holedSteppedPlate(): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${x}:${y}:${z}`;
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x * 6, y * 6, z * 0.25);
    vertices.set(key, index);
    return index;
  };
  const occupied = (x: number, y: number, z: number): boolean => {
    if (x < -5 || x >= 5 || y < -5 || y >= 5 || z < 0) return false;
    const height = x < -2 ? 40 : x >= 1 ? 39 : 38;
    const blindCentralHole = (x === -1 || x === 0) && (y === -1 || y === 0) && z >= 36;
    return z < height && !blindCentralHole;
  };
  const faces = [
    { delta: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { delta: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { delta: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { delta: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { delta: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { delta: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ] as const;
  for (let x = -5; x < 5; x += 1) for (let y = -5; y < 5; y += 1) for (let z = 0; z < 40; z += 1) {
    if (!occupied(x, y, z)) continue;
    for (const face of faces) {
      if (occupied(x + face.delta[0], y + face.delta[1], z + face.delta[2])) continue;
      const [a, b, c, d] = face.corners.map(([dx, dy, dz]) => vertex(x + dx, y + dy, z + dz));
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

const syntheticFixture = {
  name: 'synthetic-holed-stepped.stl',
  mimeType: 'model/stl',
  buffer: Buffer.from(writeBinarySTL(holedSteppedPlate(), 'safe')),
};

test('serialized worker probe accepts the fixed public result without internal evidence', async ({ page }) => {
  test.setTimeout(60_000);
  await installWorkerResultProbe(page);
  await page.goto('/');
  await selectModel(page, launcherCompatibleFixture);
  await expectResult(page, '需注意', '精確切片');
  const runtime = await readLatestWorkerResultSummary(page);
  const output = await downloadAndInspectOutline(page);
  const probe = await readWorkerProbeState(page);

  expect(runtime.assembly?.launcher).toMatchObject({
    status: 'fixed',
    cutCount: 3,
    templateVersion: 1,
    templateFingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
    fitOffsetMm: 0,
  });
  expect(runtime.coloredLayers.slice(0, -2).every((layer) => layer.launcherCuts?.length === 0)).toBe(true);
  expect(runtime.coloredLayers.slice(-2).every((layer) => layer.launcherCuts?.length === 3)).toBe(true);
  expect(runtime.coloredLayers.at(-1)!.launcherCuts).toEqual(runtime.coloredLayers.at(-2)!.launcherCuts);
  expect(output.launcherCoupon).toMatchObject({
    templateVersion: runtime.assembly!.launcher.templateVersion,
    templateFingerprint: runtime.assembly!.launcher.templateFingerprint,
    materialId: runtime.material!.id,
    kerfMm: runtime.material!.kerfMm,
    cutCount: 15,
    labels: ['-0.10 mm', '-0.05 mm', '0.00 mm', '+0.05 mm', '+0.10 mm'],
  });
  expectReleaseAssemblyGeometry(runtime, output);
  expect(probe.results).toHaveLength(1);
  expect(probe.errorCodes).toEqual([]);
});

test('structurally impossible fixed launcher geometry blocks every download', async ({ page }) => {
  test.setTimeout(60_000);
  await installWorkerResultProbe(page);
  await page.goto('/');
  await selectModel(page, structurallyImpossibleFixture);

  await expect(page.getByRole('heading', { name: '這次未能完成' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('alert')).toContainText(
    '官方三爪孔會破壞外框或必要承托結構，已停止所有輸出。',
  );
  await expect(page.locator('a[download]')).toHaveCount(0);
  const probe = await readWorkerProbeState(page);
  expect(probe.results).toEqual([]);
  expect(probe.errorCodes).toContain('LAUNCHER_INCOMPATIBLE');
});

test('one selection converts the safe single-loop model with real wireframe and exploded layers', async ({ page }) => {
  test.setTimeout(90_000);
  await installWorkerResultProbe(page);
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const selectedAt = Date.now();
  await selectModel(page, launcherCompatibleFixture);
  await expect(page.locator('.outline-process-webgl canvas')).toBeVisible({ timeout: 30_000 });
  await expectResult(page, '需注意', '精確切片');
  expect(Date.now() - selectedAt).toBeGreaterThanOrEqual(8_000);
  const viewport = page.getByRole('img', { name: /真實網格和爆炸圖/ });
  const output = await downloadAndInspectOutline(page);
  const runtime = await readLatestWorkerResultSummary(page);
  await expect(viewport).toHaveAttribute('data-layer-count', String(runtime.coloredLayers.length));
  expectReleaseAssemblyGeometry(runtime, output);
  expect(output.layers).toHaveLength(runtime.coloredLayers.length);
  const expectedBlackByLayer = runtime.coloredLayers.map((layer) => (
    1 + Number(layer.hole.status === 'retained') + layer.launcherCuts!.length + layer.fastenerHoles!.length
  ));
  expect(output.entityCounts.CUT_BLACK).toBe(expectedBlackByLayer.reduce((sum, count) => sum + count, 0));
  expect(output.layers.map((layer) => output.entities.filter((entity) => (
    entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK'
  )).length)).toEqual(expectedBlackByLayer);
  expectFiniteClosedSingleContours(output);
});

test('synthetic holed and stepped geometry reconciles assembly and retained roles with reduced motion', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    Object.assign(window, { __shapeCutAnimationFrames: 0 });
    window.requestAnimationFrame = (callback) => {
      (window as unknown as { __shapeCutAnimationFrames: number }).__shapeCutAnimationFrames += 1;
      return original(callback);
    };
  });
  await installWorkerResultProbe(page);
  await page.goto('/');
  await selectModel(page, syntheticFixture);
  await expectResult(page, '需注意', '精確切片');
  await expect(page.getByRole('img', { name: /真實網格和爆炸圖/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __shapeCutAnimationFrames: number }).__shapeCutAnimationFrames)).toBe(0);

  const output = await downloadAndInspectOutline(page);
  const runtime = await readLatestWorkerResultSummary(page);
  expect(output.layers).toHaveLength(6);
  expectSharedCentralHoleGeometry(runtime);
  expectReleaseAssemblyGeometry(runtime, output);
  await expect(page.locator('.result-summary div').filter({ hasText: '製作材料' }))
    .toContainText(`${runtime.material!.thicknessMm} mm`);
  await expect(page.locator('.result-summary div').filter({ hasText: '發射器相容性' })).toBeVisible();
  await expect(page.locator('.result-summary div').filter({ hasText: '固定螺絲孔' }))
    .toContainText(runtime.assembly!.fastener.count === 0 ? '已安全省略' : `${runtime.assembly!.fastener.count} 個`);
  const blackByLayer = output.layers.map((layer) => output.entities.filter((entity) => (
    entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK'
  )).length);
  const expectedBlackByLayer = runtime.coloredLayers.map((layer) => (
    1 + Number(layer.hole.status === 'retained') + layer.launcherCuts!.length + layer.fastenerHoles!.length
  ));
  expect(blackByLayer).toEqual(expectedBlackByLayer);
  expect(output.entityCounts.CUT_BLACK).toBe(expectedBlackByLayer.reduce((sum, count) => sum + count, 0));
  expect(output.entityCounts.DEEP_RED).toBe(runtime.coloredLayers.reduce((sum, layer) => sum + layer.deepFeatures!.length, 0));
  expect(output.entityCounts.LIGHT_BLUE).toBe(runtime.coloredLayers.reduce((sum, layer) => sum + layer.lightFeatures!.length, 0));
  expect(output.previewPdf.geometryRecords.map(({ role }) => role))
    .toEqual(output.entities.flatMap((entity) => Array.from({ length: entity.points.length }, () => entity.role)));
});

test('synthetic holed and stepped geometry has an actual no-WebGL SVG fallback', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'WebGL2RenderingContext', { configurable: true, value: undefined });
  });
  await installWorkerResultProbe(page);
  await page.goto('/');
  await selectModel(page, syntheticFixture);
  await expectResult(page, '需注意', '精確切片');
  const fallback = page.getByRole('img', { name: /SVG fallback/ });
  await expect(fallback).toBeVisible();
  const runtime = await readLatestWorkerResultSummary(page);
  const expectedBlackCount = runtime.coloredLayers.reduce((sum, layer) => (
    sum + 1 + Number(layer.hole.status === 'retained') + layer.launcherCuts!.length + layer.fastenerHoles!.length
  ), 0);
  await expect(fallback.locator('path[data-role="CUT_BLACK"]')).toHaveCount(expectedBlackCount);
  await expect(fallback.locator('path[data-role="DEEP_RED"]')).toHaveCount(
    runtime.coloredLayers.reduce((sum, layer) => sum + layer.deepFeatures!.length, 0),
  );
  await expect(fallback.locator('path[data-role="LIGHT_BLUE"]')).toHaveCount(
    runtime.coloredLayers.reduce((sum, layer) => sum + layer.lightFeatures!.length, 0),
  );
});

test('reload returns to a private upload state without retaining the STL', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await selectModel(page, launcherCompatibleFixture);
  await expectResult(page, '需注意', '精確切片');
  await page.reload();
  await expect(page.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
  await expect(page.getByText('檔案只在你的瀏覽器內處理，不會上載到伺服器。')).toBeVisible();
  await expect(page.getByText(launcherCompatibleFixture.name)).toHaveCount(0);
});
