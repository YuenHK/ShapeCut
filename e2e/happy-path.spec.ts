import { expect, test } from '@playwright/test';
import { writeBinarySTL } from '../src/domain/mesh/write-stl';
import type { TriangleMesh } from '../src/domain/mesh/types';
import {
  downloadAndInspectOutline,
  expectFiniteClosedSingleContours,
  expectResult,
  expectSharedCentralHoleGeometry,
  installWorkerResultProbe,
  readLatestWorkerResultSummary,
  selectModel,
} from './helpers';

function holedSteppedPlate(): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${x}:${y}:${z}`;
    const existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x * 2, y * 2, z * 0.25);
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

test('one selection converts the safe single-loop model with real wireframe and exploded layers', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expect(page.locator('.outline-process-webgl canvas')).toBeVisible({ timeout: 30_000 });
  await expectResult(page, '需注意', '精確切片');
  const viewport = page.getByRole('img', { name: /真實網格和爆炸圖/ });
  await expect(viewport).toHaveAttribute('data-layer-count', '8');
  const output = await downloadAndInspectOutline(page);
  expect(output.layers).toHaveLength(8);
  expect(output.entityCounts.CUT_BLACK).toBe(8);
  expect(output.entityCounts.DEEP_RED).toBeLessThanOrEqual(output.layers.length);
  expect(output.entityCounts.LIGHT_BLUE).toBeLessThanOrEqual(output.layers.length);
  expect(output.layers.every((layer) => output.entities.filter((entity) => (
    entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK'
  )).length === 1)).toBe(true);
  expectFiniteClosedSingleContours(output);
});

test('synthetic holed and stepped geometry reconciles black, red, and blue roles with reduced motion', async ({ page }) => {
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
  expectSharedCentralHoleGeometry(runtime.coloredLayers);
  const blackByLayer = output.layers.map((layer) => output.entities.filter((entity) => (
    entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK'
  )).length);
  expect(blackByLayer).toEqual(Array.from({ length: 6 }, () => 2));
  expect(output.entityCounts.CUT_BLACK).toBe(12);
  expect(output.entityCounts.DEEP_RED).toBeGreaterThanOrEqual(1);
  expect(output.entityCounts.LIGHT_BLUE).toBeGreaterThanOrEqual(1);
  expect(output.previewPdf.geometryRecords.map(({ role }) => role))
    .toEqual(output.entities.flatMap((entity) => Array.from({ length: entity.points.length }, () => entity.role)));
});

test('synthetic holed and stepped geometry has an actual no-WebGL SVG fallback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebGLRenderingContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'WebGL2RenderingContext', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await selectModel(page, syntheticFixture);
  await expectResult(page, '需注意', '精確切片');
  const fallback = page.getByRole('img', { name: /SVG fallback/ });
  await expect(fallback).toBeVisible();
  await expect(fallback.locator('path[data-role="CUT_BLACK"]')).toHaveCount(12);
  await expect(fallback.locator('path[data-role="DEEP_RED"]')).not.toHaveCount(0);
  await expect(fallback.locator('path[data-role="LIGHT_BLUE"]')).not.toHaveCount(0);
});

test('reload returns to a private upload state without retaining the STL', async ({ page }) => {
  await page.goto('/');
  await selectModel(page, 'fixtures/acceptance/symmetric-smooth.stl');
  await expectResult(page, '需注意', '精確切片');
  await page.reload();
  await expect(page.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
  await expect(page.getByText('檔案只在你的瀏覽器內處理，不會上載到伺服器。')).toBeVisible();
  await expect(page.getByText('symmetric-smooth.stl')).toHaveCount(0);
});
