import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { expect, type Download, type Page } from '@playwright/test';

export type DownloadedOutline = {
  readonly manifest: {
    readonly mode: 'exact' | 'outline-2.5d';
    readonly status: 'success' | 'warning';
    readonly warnings: readonly string[];
    readonly sourceHash: string;
    readonly removedComponentCount: number;
    readonly removalEvidenceFingerprint: string;
    readonly diagnosticsFingerprint: string;
    readonly diagnostics: unknown;
    readonly layers: readonly { readonly id: string; readonly order: number; readonly index: number; readonly zStart: number; readonly zEnd: number; readonly removedComponentCount: number }[];
  };
  readonly project: { readonly document: {
    readonly outline: { readonly removedComponentCount: number; readonly removalEvidenceFingerprint: string; readonly diagnosticsFingerprint: string; readonly diagnostics: unknown; readonly layers: readonly { readonly id: string; readonly order: number; readonly index: number; readonly zStart: number; readonly zEnd: number; readonly pointCount: number; readonly removedComponentCount: number }[] };
    readonly sheets: readonly { readonly entities: readonly { readonly id: string; readonly polygon: { readonly points: readonly (readonly [number, number])[] } }[] }[];
  } };
  readonly entries: readonly string[];
  readonly sha256: string;
};

export type RemovalRecord = { readonly id: string; readonly order: number; readonly index: number; readonly zStart: number; readonly zEnd: number; readonly removedComponentCount: number };

function checkedRecords(records: RemovalRecord[], label: string): RemovalRecord[] {
  if (records.some(({ id }) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id))) throw new Error(`${label} contains malformed layer identity`);
  if (records.some(({ order, index, zStart, zEnd, removedComponentCount }) => !Number.isSafeInteger(order) || !Number.isSafeInteger(index) || !Number.isFinite(zStart) || !Number.isFinite(zEnd) || !Number.isSafeInteger(removedComponentCount))) throw new Error(`${label} contains malformed layer metadata`);
  if (new Set(records.map(({ id }) => id)).size !== records.length || new Set(records.map(({ index }) => index)).size !== records.length || new Set(records.map(({ order }) => order)).size !== records.length) throw new Error(`${label} contains duplicate layer identity`);
  return records;
}

export function parseSvgRemovalRecords(svg: string): RemovalRecord[] {
  // cut.svg reserves every polygon as a canonical layer carrier; unrelated polygons fail closed.
  const carriers = [...svg.matchAll(/<polygon\b[^>]*>/g)].map((match) => match[0]);
  const attribute = (tag: string, name: string): string => {
    // Attribute names are whitespace-delimited in XML. Count every assignment first so
    // an unquoted or single-quoted duplicate cannot disappear from the canonical parser.
    const lexical = [...tag.matchAll(new RegExp(`(?:\\s)${name}\\s*=`, 'g'))];
    const parsed = [...tag.matchAll(new RegExp(`(?:\\s)${name}\\s*=\\s*"([^"]*)"`, 'g'))];
    if (lexical.length !== 1 || parsed.length !== 1) throw new Error(`SVG polygon must contain exactly one valid ${name} attribute`);
    return parsed[0][1];
  };
  const integerAttribute = (tag: string, name: string): number => {
    const value = attribute(tag, name);
    if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`SVG polygon has invalid ${name}`);
    return Number(value);
  };
  const numberAttribute = (tag: string, name: string): number => {
    const value = attribute(tag, name);
    if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`SVG polygon has invalid ${name}`);
    return Number(value);
  };
  const records = carriers.map((tag) => ({
    id: attribute(tag, 'id'), order: integerAttribute(tag, 'data-outline-order'),
    index: integerAttribute(tag, 'data-outline-index'), zStart: numberAttribute(tag, 'data-z-start'),
    zEnd: numberAttribute(tag, 'data-z-end'), removedComponentCount: integerAttribute(tag, 'data-removed-component-count'),
  }));
  return checkedRecords(records, 'SVG');
}

export function exactlyOneSvgRootAttribute(svg: string, name: string, expected: string): void {
  const roots = [...svg.matchAll(/<svg\b[^>]*>/g)];
  if (roots.length !== 1) throw new Error('SVG must contain exactly one root element');
  const lexical = [...roots[0][0].matchAll(new RegExp(`(?:\\s)${name}\\s*=`, 'g'))];
  const parsed = [...roots[0][0].matchAll(new RegExp(`(?:\\s)${name}\\s*=\\s*"([^"]*)"`, 'g'))];
  if (lexical.length !== 1 || parsed.length !== 1 || parsed[0][1] !== expected) throw new Error(`SVG root must contain exactly one valid ${name} attribute`);
}

export function parseDxfRemovalRecords(dxf: string): RemovalRecord[] {
  const markers = [...dxf.matchAll(/OUTLINE_LAYER:/g)];
  const records = [...dxf.matchAll(/999\nOUTLINE_LAYER:([^:\n]+):(\d+):(\d+):([^:\n]+):([^:\n]+):\d+:[^:\n]+:(\d+)\n/g)].map((match) => ({ id: match[1], order: Number(match[2]), index: Number(match[3]), zStart: Number(match[4]), zEnd: Number(match[5]), removedComponentCount: Number(match[6]) }));
  if (markers.length !== records.length) throw new Error('DXF contains malformed layer metadata marker');
  return checkedRecords(records, 'DXF');
}

export function parsePdfRemovalRecords(keywords: string): RemovalRecord[] {
  const markerCount = [...keywords.matchAll(/outline-layer:/g)].length;
  const tokens = keywords.split(/\s+/).filter((token) => token.startsWith('outline-layer:'));
  const records = tokens.flatMap((token) => {
    const match = token.match(/^outline-layer:([^:]+):(\d+):(\d+):\d+:[^:]+:([^:]+):([^:]+):(\d+)$/);
    return match ? [{ id: match[1], order: Number(match[2]), index: Number(match[3]), zStart: Number(match[4]), zEnd: Number(match[5]), removedComponentCount: Number(match[6]) }] : [];
  });
  if (markerCount !== records.length) throw new Error('PDF contains malformed layer metadata marker');
  return checkedRecords(records, 'PDF');
}

export function assertExactRemovalRecords(actual: readonly RemovalRecord[], expected: readonly RemovalRecord[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Removal layer records do not exactly match canonical order and identity');
}

export function exactlyOneProvenance(text: string, markerPattern: RegExp, pattern: RegExp, expected: string, label: string): void {
  const markers = [...text.matchAll(markerPattern)];
  const matches = [...text.matchAll(pattern)];
  if (markers.length !== 1 || matches.length !== 1 || matches[0][1] !== expected) throw new Error(`${label} must contain exactly one matching removal provenance record`);
}

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
  expect(project.document.outline.layers.map(({ id, order, index, zStart, zEnd, removedComponentCount }) => ({ id, order, index, zStart, zEnd, removedComponentCount })))
    .toEqual(manifest.layers.map(({ id, order, index, zStart, zEnd, removedComponentCount }) => ({ id, order, index, zStart, zEnd, removedComponentCount })));
  expect(project.document.outline.removedComponentCount).toBe(manifest.removedComponentCount);
  expect(project.document.outline.diagnostics).toEqual(manifest.diagnostics);
  expect(project.document.outline.diagnosticsFingerprint).toBe(manifest.diagnosticsFingerprint);
  expect(project.document.outline.removalEvidenceFingerprint).toBe(manifest.removalEvidenceFingerprint);
  expect(manifest.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0)).toBe(manifest.removedComponentCount);
  expect(svg).toContain(`data-removed-component-count="${manifest.removedComponentCount}"`);
  expect(dxf).toContain(`REMOVED_COMPONENT_COUNT:${manifest.removedComponentCount}`);
  expect(pdf.getKeywords()).toContain(`removed-components:${manifest.removedComponentCount}`);
  expect(svg).toContain(`data-removal-evidence-fingerprint="${manifest.removalEvidenceFingerprint}"`);
  expect(dxf).toContain(`REMOVAL_EVIDENCE_FINGERPRINT:${manifest.removalEvidenceFingerprint}`);
  expect(pdf.getKeywords()).toContain(`removal-evidence:${manifest.removalEvidenceFingerprint}`);
  const expectedRecords = manifest.layers.map(({ id, order, index, zStart, zEnd, removedComponentCount }) => ({ id, order, index, zStart, zEnd, removedComponentCount }));
  assertExactRemovalRecords(parseSvgRemovalRecords(svg), expectedRecords);
  assertExactRemovalRecords(parseDxfRemovalRecords(dxf), expectedRecords);
  assertExactRemovalRecords(parsePdfRemovalRecords(pdf.getKeywords() ?? ''), expectedRecords);
  expect(new Set(expectedRecords.map(({ id }) => id)).size).toBe(expectedRecords.length);
  expect(new Set(expectedRecords.map(({ index }) => index)).size).toBe(expectedRecords.length);
  exactlyOneSvgRootAttribute(svg, 'data-removed-component-count', String(manifest.removedComponentCount));
  exactlyOneSvgRootAttribute(svg, 'data-removal-evidence-fingerprint', manifest.removalEvidenceFingerprint);
  exactlyOneSvgRootAttribute(svg, 'data-diagnostics-fingerprint', manifest.diagnosticsFingerprint);
  exactlyOneProvenance(dxf, /REMOVED_COMPONENT_COUNT:/g, /REMOVED_COMPONENT_COUNT:(\d+)\n/g, String(manifest.removedComponentCount), 'DXF aggregate');
  exactlyOneProvenance(dxf, /REMOVAL_EVIDENCE_FINGERPRINT:/g, /REMOVAL_EVIDENCE_FINGERPRINT:([0-9a-f]+)\n/g, manifest.removalEvidenceFingerprint, 'DXF fingerprint');
  exactlyOneProvenance(dxf, /DIAGNOSTICS_FINGERPRINT:/g, /DIAGNOSTICS_FINGERPRINT:([0-9a-f]+)\n/g, manifest.diagnosticsFingerprint, 'DXF diagnostics');
  exactlyOneProvenance(pdf.getKeywords() ?? '', /removed-components:/g, /(?:^|\s)removed-components:(\d+)(?=\s|$)/g, String(manifest.removedComponentCount), 'PDF aggregate');
  exactlyOneProvenance(pdf.getKeywords() ?? '', /removal-evidence:/g, /(?:^|\s)removal-evidence:([0-9a-f]+)(?=\s|$)/g, manifest.removalEvidenceFingerprint, 'PDF fingerprint');
  exactlyOneProvenance(pdf.getKeywords() ?? '', /diagnostics-evidence:/g, /(?:^|\s)diagnostics-evidence:([0-9a-f]+)(?=\s|$)/g, manifest.diagnosticsFingerprint, 'PDF diagnostics');
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
