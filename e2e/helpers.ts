import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { expect, type Download, type Page } from '@playwright/test';

export type DownloadedOutline = {
  readonly manifest: {
    readonly mode: 'exact' | 'outline-2.5d';
    readonly status: 'success' | 'warning';
    readonly sourceHash: string;
    readonly removedComponentCount: number;
    readonly layers: readonly { readonly id: string; readonly order: number; readonly zStart: number; readonly zEnd: number; readonly removedComponentCount: number }[];
  };
  readonly project: { readonly document: {
    readonly outline: { readonly removedComponentCount: number; readonly layers: readonly { readonly id: string; readonly order: number; readonly zStart: number; readonly zEnd: number; readonly pointCount: number; readonly removedComponentCount: number }[] };
    readonly sheets: readonly { readonly entities: readonly { readonly id: string; readonly polygon: { readonly points: readonly (readonly [number, number])[] } }[] }[];
  } };
  readonly entries: readonly string[];
  readonly sha256: string;
};

export async function selectModel(page: Page, fixture: string | { name: string; mimeType: string; buffer: Buffer }, beforeSetInput?: () => Promise<void>) {
  await beforeSetInput?.();
  await page.getByLabel('選擇 STL 模型').setInputFiles(fixture);
}

export async function expectNoEngineeringControls(page: Page) {
  for (const name of [/修復/, /軸心/, /下一步/, /材料/, /拆件/, /輸出確認/]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
}

export async function expectResult(page: Page, status: '成功' | '需注意', mode: '精確切片' | '2.5D 外形') {
  await expect(page.getByRole('heading', { name: '轉換完成' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(status, { exact: true })).toBeVisible();
  await expect(page.getByText(mode, { exact: true })).toBeVisible();
  await expectNoEngineeringControls(page);
}

export async function downloadAndInspectOutline(page: Page): Promise<DownloadedOutline> {
  const event = page.waitForEvent('download');
  await page.getByRole('link', { name: '下載 ZIP 製作套件' }).click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('shapecut-outline.zip');
  return inspectOutlineDownload(download);
}

async function inspectOutlineDownload(download: Download): Promise<DownloadedOutline> {
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.keys(zip.files).sort();
  expect(entries).toEqual(['cut.dxf', 'cut.svg', 'manifest.json', 'preview.pdf', 'project.json']);
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as DownloadedOutline['manifest'];
  const project = JSON.parse(await zip.file('project.json')!.async('string')) as DownloadedOutline['project'];
  const svg = await zip.file('cut.svg')!.async('string');
  const dxf = await zip.file('cut.dxf')!.async('string');
  const pdf = await PDFDocument.load(await zip.file('preview.pdf')!.async('uint8array'));
  expect(svg).toContain(manifest.sourceHash);
  expect(dxf).toContain(manifest.sourceHash);
  expect(project.document.outline.layers.map(({ id }) => id)).toEqual(manifest.layers.map(({ id }) => id));
  expect(project.document.outline.layers.map(({ id, order, zStart, zEnd, removedComponentCount }) => ({ id, order, zStart, zEnd, removedComponentCount })))
    .toEqual(manifest.layers.map(({ id, order, zStart, zEnd, removedComponentCount }) => ({ id, order, zStart, zEnd, removedComponentCount })));
  expect(project.document.outline.removedComponentCount).toBe(manifest.removedComponentCount);
  expect(manifest.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(manifest.removedComponentCount);
  expect(svg).toContain(`data-removed-component-count="${manifest.removedComponentCount}"`);
  expect(dxf).toContain(`REMOVED_COMPONENT_COUNT:${manifest.removedComponentCount}`);
  expect(pdf.getKeywords()).toContain(`removed-components:${manifest.removedComponentCount}`);
  for (const layer of manifest.layers) {
    const svgRecord = new RegExp(`<polygon id="${layer.id}"[^>]*data-outline-order="${layer.order}"[^>]*data-z-start="${layer.zStart}"[^>]*data-z-end="${layer.zEnd}"[^>]*data-removed-component-count="${layer.removedComponentCount}"`);
    expect(svg).toMatch(svgRecord);
    expect(dxf).toContain(`OUTLINE_LAYER:${layer.id}:${layer.order}:${layer.zStart}:${layer.zEnd}:`);
    expect(dxf).toMatch(new RegExp(`OUTLINE_LAYER:${layer.id}:${layer.order}:${layer.zStart}:${layer.zEnd}:[^\\n]*:${layer.removedComponentCount}\\n`));
    const pdfRecord = new RegExp(`^outline-layer:${layer.id}:${layer.order}:.*:${layer.zStart}:${layer.zEnd}:${layer.removedComponentCount}$`);
    expect(pdf.getKeywords()?.split(/\s+/).some((token) => pdfRecord.test(token))).toBe(true);
  }
  expect(project.document.sheets.flatMap(({ entities }) => entities).map(({ id }) => id)).toEqual(manifest.layers.map(({ id }) => id));
  return { manifest, project, entries, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function expectFiniteClosedSingleContours(output: DownloadedOutline) {
  const entities = output.project.document.sheets.flatMap(({ entities }) => entities);
  expect(entities).toHaveLength(output.manifest.layers.length);
  for (const entity of entities) {
    expect(entity.polygon.points.length).toBeGreaterThanOrEqual(3);
    expect(entity.polygon.points.every((point) => point.length === 2 && point.every(Number.isFinite))).toBe(true);
    expect(new Set(entity.polygon.points.map((point) => point.join(','))).size).toBe(entity.polygon.points.length);
  }
}
