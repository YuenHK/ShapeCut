import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { OutlineLayer } from '../domain/outline-2.5d/extract';
import { contourBounds } from '../domain/outline-2.5d/simplify';
import type { OutlineMode, OutlineResultStatus } from '../domain/outline-2.5d/types';
import { validateOutlineLayer } from '../domain/outline-2.5d/validate';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import type {
  LayerEntity,
  ManufacturingDocument,
  ManufacturingSheet,
  OutlineDocumentLayer,
  OutlineDocumentMetadata,
} from './layers';
import {
  flattenOutlineSheets,
  writeOutlineDxf,
  writeOutlinePreviewPdf,
  writeOutlineSvg,
  writeOutlineZip,
} from './package';
import { writeOutlineProjectJson } from './project-json';

const MARGIN_MM = 5;
const SPACING_MM = 5;
const MAX_PART_MM = 990;
const MAX_SHEET_HEIGHT_MM = 1000;
const HASH_PATTERN = /^[0-9a-f]{32}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'(])(?:\/[\p{L}\p{N}._~-]+(?:\/[\p{L}\p{N}._~-]+)*|[A-Za-z]:\\[^\s]+)(?=$|[\s"',;)])/u;
const FORBIDDEN_PROCESS_PATTERN = /\b(?:slot|hole|engrave|power|speed|passes)\b/i;

export type OutlineManifestV1 = {
  readonly schemaVersion: 1;
  readonly mode: OutlineMode;
  readonly sourceHash: string;
  readonly status: OutlineResultStatus;
  readonly warnings: readonly string[];
  readonly layers: readonly {
    readonly id: string;
    readonly order: number;
    readonly zStart: number;
    readonly zEnd: number;
    readonly boundsMm: readonly [number, number];
  }[];
  readonly materialIndependent: true;
};

export type OutlinePackage = {
  readonly document: ManufacturingDocument;
  readonly manifest: OutlineManifestV1;
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly projectJson: string;
  readonly manifestJson: string;
  readonly zip: Uint8Array;
};

type MeasuredLayer = {
  readonly layer: OutlineLayer;
  readonly width: number;
  readonly height: number;
  readonly minX: number;
  readonly minY: number;
};

function assertPublicText(value: string, label: string): void {
  const privateMatch = value.match(EMAIL_PATTERN) ?? value.match(ABSOLUTE_PATH_PATTERN);
  if (privateMatch) {
    throw new RangeError(`${label} must not contain a private path or email address`);
  }
  if (FORBIDDEN_PROCESS_PATTERN.test(value)) {
    throw new RangeError(`${label} must not contain slots, holes, engraving, or process settings`);
  }
}

function measured(layer: OutlineLayer): MeasuredLayer {
  const validation = validateOutlineLayer(layer);
  if (!validation.ok) throw new RangeError(`Invalid outline layer ${layer.id}: ${validation.reasons.join('; ')}`);
  if (!SAFE_ID_PATTERN.test(layer.id)) throw new RangeError('Outline layer IDs must be safe portable identifiers');
  assertPublicText(layer.id, 'Outline layer ID');
  const bounds = contourBounds(layer.contour.outer);
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  if (width > MAX_PART_MM || height > MAX_PART_MM) {
    throw new RangeError('Outline part exceeds the 990 mm size limit and cannot be rescaled');
  }
  return { layer, width, height, minX: bounds.minX, minY: bounds.minY };
}

function sortedLayers(result: AutomaticOutlineResult): MeasuredLayer[] {
  if (!HASH_PATTERN.test(result.sourceHash)) throw new RangeError('Outline source hash must contain 32 hexadecimal characters');
  if (!['exact', 'outline-2.5d'].includes(result.mode)) throw new RangeError('Outline mode provenance is invalid');
  if (!['success', 'warning', 'failure'].includes(result.status)) throw new RangeError('Outline status provenance is invalid');
  if (result.status === 'failure' || result.layers.length === 0) throw new RangeError('Cannot package a failed or empty outline result');
  for (const warning of result.warnings) assertPublicText(warning, 'Outline warning');
  const ids = new Set<string>();
  const indices = new Set<number>();
  const values = result.layers.map((item) => {
    if (ids.has(item.id) || indices.has(item.index)) throw new RangeError('Outline layer IDs and indices must be unique');
    ids.add(item.id); indices.add(item.index);
    return measured(item);
  });
  return values.sort((left, right) => left.layer.zStart - right.layer.zStart
    || left.layer.zEnd - right.layer.zEnd || left.layer.index - right.layer.index || left.layer.id.localeCompare(right.layer.id));
}

export function createOutlineDocument(result: AutomaticOutlineResult): ManufacturingDocument {
  const layers = sortedLayers(result);
  const canvasWidth = Math.min(1000, Math.max(300, Math.ceil(Math.max(...layers.map(({ width }) => width)) + 10)));
  const sheets: ManufacturingSheet[] = [];
  const metadataLayers: OutlineDocumentLayer[] = [];
  let entities: LayerEntity[] = [];
  let cursorX = MARGIN_MM, cursorY = MARGIN_MM, rowHeight = 0, maxY = MARGIN_MM;

  const finishSheet = (): void => {
    if (entities.length === 0) return;
    sheets.push({ width: canvasWidth, height: Math.ceil(maxY + MARGIN_MM), entities });
    entities = [];
    cursorX = MARGIN_MM; cursorY = MARGIN_MM; rowHeight = 0; maxY = MARGIN_MM;
  };

  layers.forEach((item, index) => {
    if (cursorX + item.width > canvasWidth - MARGIN_MM && entities.length > 0) {
      cursorX = MARGIN_MM;
      cursorY += rowHeight + SPACING_MM;
      rowHeight = 0;
    }
    if (cursorY + item.height > MAX_SHEET_HEIGHT_MM - MARGIN_MM && entities.length > 0) finishSheet();
    const points = item.layer.contour.outer.map(([x, y]) => [x - item.minX + cursorX, y - item.minY + cursorY] as const);
    const sheetIndex = sheets.length;
    entities.push({
      id: item.layer.id,
      partId: item.layer.id,
      instance: 0,
      contour: 'outline',
      layer: 'CUT',
      polygon: { points },
    });
    metadataLayers.push({
      id: item.layer.id,
      order: index + 1,
      zStart: item.layer.zStart,
      zEnd: item.layer.zEnd,
      boundsMm: [item.width, item.height],
      sourceBoundsMm: { ...item.layer.sourceBoundsMm },
      pointCount: item.layer.contour.outer.length,
      sheetIndex,
    });
    cursorX += item.width + SPACING_MM;
    rowHeight = Math.max(rowHeight, item.height);
    maxY = Math.max(maxY, cursorY + item.height);
  });
  finishSheet();

  const outline: OutlineDocumentMetadata = {
    mode: result.mode,
    sourceHash: result.sourceHash,
    status: result.status,
    warnings: [...result.warnings],
    layers: metadataLayers,
    materialIndependent: true,
  };
  const document: ManufacturingDocument = {
    provenance: { inputFingerprint: result.sourceHash },
    unit: 'mm',
    sheets,
    manifest: metadataLayers.map(({ id, order }) => ({ partId: id, quantity: 1, assemblyOrder: order })),
    outline,
  };
  validateOutlineDocument(document);
  return document;
}

function manifestFromDocument(document: ManufacturingDocument): OutlineManifestV1 {
  const metadata = requireMetadata(document);
  return {
    schemaVersion: 1,
    mode: metadata.mode,
    sourceHash: metadata.sourceHash,
    status: metadata.status,
    warnings: [...metadata.warnings],
    layers: metadata.layers.map(({ id, order, zStart, zEnd, boundsMm }) => ({ id, order, zStart, zEnd, boundsMm })),
    materialIndependent: true,
  };
}

export async function createOutlinePackage(result: AutomaticOutlineResult): Promise<OutlinePackage> {
  const document = createOutlineDocument(result);
  const manifest = manifestFromDocument(document);
  const metadata = requireMetadata(document);
  const exportSheet = flattenOutlineSheets(document);
  const cutSvg = writeOutlineSvg(exportSheet, metadata);
  const cutDxf = writeOutlineDxf(exportSheet, metadata);
  const previewPdf = await writeOutlinePreviewPdf(metadata);
  const projectJson = writeOutlineProjectJson(document);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const zip = await writeOutlineZip({ cutSvg, cutDxf, previewPdf, projectJson, manifestJson });
  const output = { document, manifest, cutSvg, cutDxf, previewPdf, projectJson, manifestJson, zip };
  await verifyOutlinePackage(output);
  return output;
}

function requireMetadata(document: ManufacturingDocument): OutlineDocumentMetadata {
  if (!document.outline) throw new RangeError('Outline document metadata is required');
  return document.outline;
}

function validateOutlineDocument(document: ManufacturingDocument): void {
  const metadata = requireMetadata(document);
  if (document.unit !== 'mm' || document.sheets.length === 0 || !HASH_PATTERN.test(metadata.sourceHash)
    || !['exact', 'outline-2.5d'].includes(metadata.mode) || !['success', 'warning'].includes(metadata.status)
    || document.provenance.inputFingerprint !== metadata.sourceHash || metadata.materialIndependent !== true) {
    throw new RangeError('Outline document provenance is invalid');
  }
  if (metadata.layers.length !== document.manifest.length) throw new RangeError('Outline document layer manifest mismatch');
  const entities = document.sheets.flatMap(({ entities: sheetEntities }) => sheetEntities);
  if (entities.length !== metadata.layers.length) throw new RangeError('Outline document entity count mismatch');
  metadata.layers.forEach((layer, index) => {
    const part = document.manifest[index], entity = entities[index];
    if (layer.order !== index + 1 || part.partId !== layer.id || part.quantity !== 1 || part.assemblyOrder !== layer.order
      || entity.id !== layer.id || entity.partId !== layer.id || entity.instance !== 0
      || entity.layer !== 'CUT' || entity.contour !== 'outline' || entity.polygon.points.length !== layer.pointCount
      || layer.sheetIndex < 0 || document.sheets[layer.sheetIndex]?.entities.includes(entity) !== true) {
      throw new RangeError('Outline document identity, order, or CUT geometry mismatch');
    }
    const bounds = contourBounds(entity.polygon.points);
    const actual = [bounds.maxX - bounds.minX, bounds.maxY - bounds.minY];
    if (!nearlyEqual(actual[0], layer.boundsMm[0]) || !nearlyEqual(actual[1], layer.boundsMm[1])) {
      throw new RangeError('Outline document bounds mismatch');
    }
  });
}

function canonicalEntities(sheet: ManufacturingSheet): unknown[] {
  return sheet.entities.map((entity) => ({
    id: entity.id,
    partId: entity.partId,
    instance: entity.instance,
    contour: entity.contour,
    layer: entity.layer,
    points: entity.polygon.points.map((point) => [...point]),
  }));
}

function svgEntities(svg: string): unknown[] {
  return [...svg.matchAll(/<g id="layer-([^"]+)"[^>]*>(.*?)<\/g>/gs)].flatMap((group) =>
    [...group[2].matchAll(/<polygon id="([^"]+)"[^>]*data-part-id="([^"]+)" data-instance="(\d+)" data-contour="([^"]+)" points="([^"]+)"\/>/g)].map((match) => ({
      id: match[1], partId: match[2], instance: Number(match[3]), contour: match[4], layer: group[1],
      points: match[5].split(' ').map((point) => point.split(',').map(Number)),
    })),
  );
}

function dxfEntities(dxf: string): unknown[] {
  return [...dxf.matchAll(/999\nENTITY_ID:([^\n]+)\n999\nPART_ID:([^\n]+)\n999\nINSTANCE:(\d+)\n999\nCONTOUR:([^\n]+)\n0\nLWPOLYLINE\n8\n([^\n]+)\n90\n(\d+)\n70\n1\n((?:10\n[^\n]+\n20\n[^\n]+\n)+)/g)].map((match) => {
    const points = [...match[7].matchAll(/10\n([^\n]+)\n20\n([^\n]+)\n/g)].map((point) => [Number(point[1]), Number(point[2])]);
    if (points.length !== Number(match[6])) throw new RangeError('DXF point count mismatch');
    return { id: match[1], partId: match[2], instance: Number(match[3]), contour: match[4], layer: match[5], points };
  });
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

function nearlyEqual(left: number, right: number): boolean {
  const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 4096 * Number.EPSILON);
  return Math.abs(left - right) <= tolerance;
}

export async function verifyOutlinePackage(output: OutlinePackage): Promise<void> {
  validateOutlineDocument(output.document);
  const expectedManifest = manifestFromDocument(output.document);
  if (exactJson(output.manifest) !== exactJson(expectedManifest)
    || exactJson(JSON.parse(output.manifestJson)) !== exactJson(expectedManifest)) {
    throw new RangeError('Outline manifest reconciliation mismatch');
  }
  const project = JSON.parse(output.projectJson);
  if (exactJson(project) !== exactJson(JSON.parse(writeOutlineProjectJson(output.document)))) {
    throw new RangeError('Outline project JSON reconciliation mismatch');
  }
  const exportSheet = flattenOutlineSheets(output.document);
  const expectedEntities = canonicalEntities(exportSheet);
  if (exactJson(svgEntities(output.cutSvg)) !== exactJson(expectedEntities)
    || exactJson(dxfEntities(output.cutDxf)) !== exactJson(expectedEntities)) {
    throw new RangeError('Outline geometry reconciliation mismatch');
  }
  const metadata = requireMetadata(output.document);
  if (output.cutSvg !== writeOutlineSvg(exportSheet, metadata) || output.cutDxf !== writeOutlineDxf(exportSheet, metadata)) {
    throw new RangeError('Outline metadata reconciliation mismatch');
  }
  const pdf = await PDFDocument.load(output.previewPdf);
  const keywords = pdf.getKeywords() ?? '';
  const requiredKeywords = [
    `outline-source:${metadata.sourceHash}`,
    `outline-mode:${metadata.mode}`,
    `outline-status:${metadata.status}`,
    'material-independent:true',
    ...metadata.layers.map((layer) => `outline-layer:${layer.id}:${layer.order}:${layer.pointCount}:${layer.boundsMm[0]}x${layer.boundsMm[1]}:${layer.zStart}:${layer.zEnd}`),
  ];
  const actualKeywords = keywords === '' ? [] : keywords.split(/\s+/);
  if (exactJson(actualKeywords) !== exactJson(requiredKeywords)) throw new RangeError('Outline PDF metadata reconciliation mismatch');
  const pdfMetadata = [
    pdf.getTitle(), pdf.getSubject(), pdf.getAuthor(), pdf.getCreator(), pdf.getProducer(), keywords,
  ].filter((value): value is string => typeof value === 'string').join('\n');
  assertPublicText(pdfMetadata, 'Outline PDF metadata');

  [output.cutSvg, output.cutDxf, output.projectJson, output.manifestJson].forEach((value) => assertPublicText(value, 'Outline package'));
  const zip = await JSZip.loadAsync(output.zip);
  const paths = Object.keys(zip.files).filter((path) => !zip.files[path].dir).sort();
  if (exactJson(paths) !== exactJson(['cut.dxf', 'cut.svg', 'manifest.json', 'preview.pdf', 'project.json'])) {
    throw new RangeError('Outline ZIP entry reconciliation mismatch');
  }
  const zippedPdf = await zip.file('preview.pdf')!.async('uint8array');
  if (await zip.file('cut.svg')!.async('string') !== output.cutSvg
    || await zip.file('cut.dxf')!.async('string') !== output.cutDxf
    || await zip.file('project.json')!.async('string') !== output.projectJson
    || await zip.file('manifest.json')!.async('string') !== output.manifestJson
    || zippedPdf.length !== output.previewPdf.length
    || zippedPdf.some((byte, index) => byte !== output.previewPdf[index])) {
    throw new RangeError('Outline ZIP package reconciliation mismatch');
  }
}
