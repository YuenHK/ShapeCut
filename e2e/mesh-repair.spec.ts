import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseSTL } from '../src/domain/mesh/parse-stl';
import { analyzeMeshProblems } from '../src/domain/mesh/problem-report';

const knightFortressPath = process.env.KNIGHT_FORTRESS_STL
  ?? resolve(process.cwd(), '..', '..', 'Copy of Beyblade X Knight Fortress.stl');

test('diagnoses and offers repair for Knight Fortress without calling it unreadable', async ({ page }) => {
  test.skip(
    !existsSync(knightFortressPath),
    'Knight Fortress is an external user fixture; set KNIGHT_FORTRESS_STL to opt in.',
  );

  await page.goto('/');
  await page.getByLabel('STL 模型檔案').setInputFiles(knightFortressPath);
  await page.getByRole('button', { name: '分析模型' }).click();

  await expect(page.getByText('非流形邊：105', { exact: true })).toBeVisible();
  await expect(page.getByText('退化三角形：63', { exact: true })).toBeVisible();
  await expect(page.getByText(/讀不到檔案/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '進階修復', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '軸心與尺寸' })).toHaveCount(0);

  await page.getByLabel('我明白進階修復可能改變模型細節').check();
  await page.getByRole('button', { name: '進階修復', exact: true }).click();
  await expect(page.getByText('目前預覽：進階修復')).toBeVisible();
  await expect(page.getByText('修復結果未通過安全檢查')).toBeVisible();
  await expect(page.getByText('非流形面扇無法在限制內安全拆分')).toBeVisible();
  await expect(page.getByText('開放邊界：41 → 41', { exact: true })).toBeVisible();
  await expect(page.getByText('非流形邊：49 → 49', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用進階修復' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載已修復 STL' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Copy of Beyblade X Knight Fortress-repaired.stl');
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const repairedBytes = await readFile(downloadPath!);
  const repaired = parseSTL(repairedBytes.buffer.slice(
    repairedBytes.byteOffset,
    repairedBytes.byteOffset + repairedBytes.byteLength,
  ) as ArrayBuffer);
  const repairedReport = analyzeMeshProblems(repaired);
  expect(repairedReport.inspection.boundaryEdgeCount).toBe(41);
  expect(repairedReport.inspection.nonManifoldEdgeCount).toBe(49);
  expect(repairedReport.inspection.degenerateTriangleCount).toBe(0);
  expect(repairedReport.duplicateTriangleCount).toBe(0);

  await page.getByRole('button', { name: '復原原始模型' }).click();
  await expect(page.getByText('目前預覽：原始模型')).toBeVisible();
  await expect(page.getByText('開放邊界：0', { exact: true })).toBeVisible();
  await expect(page.getByText('非流形邊：105', { exact: true })).toBeVisible();
  await expect(page.getByText('退化三角形：63', { exact: true })).toBeVisible();
  await expect(page.getByText('重複三角形：33', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
});
