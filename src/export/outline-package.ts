import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD } from '../domain/axis/find-axis';
import { polygonMassProperties, polygonsIntersectOrTouch, validatePolygon } from '../domain/engraving/geometry';
import type { OutlineLayer } from '../domain/outline-2.5d/extract';
import { contourBounds, signedArea } from '../domain/outline-2.5d/simplify';
import { DEFAULT_OUTLINE_BUDGETS, type OutlineMode, type OutlineResultStatus } from '../domain/outline-2.5d/types';
import { validateOutlineLayer } from '../domain/outline-2.5d/validate';
import { diagnosticsFingerprint, removalEvidenceFingerprint, type AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
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
const FILE_URI_PATTERN = /\bfile:\/\/(?:\/|[\p{L}\p{N}._~-]+\/)[^\s"'<>]+/iu;
const SVG_TAG_PATTERN = /<[^>]*>/g;
const SVG_ROOT_RELATIVE_URL_ATTRIBUTE_PATTERN = /\b(?:href|src)\s*=\s*\\?(["'])(\/(?!\/)[^\\"'<>]*)\\?\1/gi;
const POSIX_PATH_PATTERN = /(?:^|[^\p{L}\p{N}_\/])\/(?![/>])/u;
const WINDOWS_PATH_PATTERN = /(?:^|[^\p{L}\p{N}_\\/])(?:[A-Za-z]:[\\/]|\\{2,}(?!\\)[^\\\s"'<>]+\\+(?!\\)[^\\\s"'<>]+)/u;
const FORWARD_UNC_PATH_PATTERN = /(?:^|[^\p{L}\p{N}_\/:])\/{2,}(?!\/)[^\/\s"'<>]+\/+(?!\/)[^\/\s"'<>]+/u;
const SOURCE_FILE_PATTERN = /(?:^|[\\/])[^\\/\s]*\.stl(?:[\\/]|$)/i;
const FORBIDDEN_PROCESS_PATTERN = /(?:slot|hole|engrave|power|speed|passes)/i;
const PRESS_FIT_PATTERN = /press(?:to)?fit/i;
const MATERIAL_TERM = '(?:material|acrylic|pmma|plywood|wood|mdf|paper|cardboard|leather|fabric|cork|rubber|foam|plastic|metal|steel|aluminum|aluminium)';
const PRODUCTION_READINESS_TERM = '(?:productionready|readyforproduction)';
const PRODUCTION_MATERIAL_CLAIM_PATTERN = new RegExp(`(?:${PRODUCTION_READINESS_TERM}.*${MATERIAL_TERM}|${MATERIAL_TERM}.*${PRODUCTION_READINESS_TERM})`, 'i');
const PROJECTED_WARNINGS = Object.freeze([
  '已簡化模型',
  '原始內部細節、孔洞及細小分離零件已被忽略',
  '不同材料厚度會改變堆疊後高度',
  '輸出不包含雷射功率或速度',
  '正式製作前應先試切少量零件',
]);
const FALLBACK_AXIS_WARNING = '未找到可信旋轉軸，已使用模型最短包圍盒軸';
const EXACT_FALLBACK_WARNING = '精確切片失敗，已改用 2.5D 外形模式';
const checkPackageDeadline = (deadline: number): void => {
  if (!Number.isFinite(deadline) || Date.now() > deadline) throw new RangeError('Outline package exceeded the shared deadline');
};

export type OutlineManifestV1 = {
  readonly schemaVersion: 1;
  readonly mode: OutlineMode;
  readonly sourceHash: string;
  readonly status: OutlineResultStatus;
  readonly warnings: readonly string[];
  readonly repairAccepted: boolean;
  readonly removedComponentCount: number;
  readonly removalEvidenceFingerprint: string;
  readonly axisSource: 'candidate' | 'shortest-bounds';
  readonly diagnostics: AutomaticOutlineResult['diagnostics'];
  readonly diagnosticsFingerprint: string;
  readonly layers: readonly {
    readonly id: string;
    readonly order: number;
    readonly index: number;
    readonly zStart: number;
    readonly zEnd: number;
    readonly boundsMm: readonly [number, number];
    readonly removedComponentCount: number;
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

function isPublicSvgResource(path: string): boolean {
  let decoded = path;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return false;
  }
  if (/%[0-9a-f]{2}/i.test(decoded) || decoded.includes('\\') || /[?#]/.test(decoded)) return false;
  const segments = decoded.split('/');
  return segments[0] === ''
    && segments[1]?.toLowerCase() === 'assets'
    && segments.length > 2
    && segments.slice(2).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function svgAwarePrivacyScanText(value: string): string {
  const openElements: string[] = [];
  return value.replace(SVG_TAG_PATTERN, (tag) => {
    const closing = tag.match(/^<\/([A-Za-z][A-Za-z0-9:._-]*)\s*>$/);
    if (closing) {
      const name = closing[1].toLowerCase();
      if (openElements.at(-1) !== name) return tag;
      openElements.pop();
      return '';
    }
    const opening = tag.match(/^<([A-Za-z][A-Za-z0-9:._-]*)(?:\s|\/?>)/);
    if (opening && !/\/\s*>$/.test(tag)) openElements.push(opening[1].toLowerCase());
    return tag.replace(
      SVG_ROOT_RELATIVE_URL_ATTRIBUTE_PATTERN,
      (attribute, _quote: string, path: string) => isPublicSvgResource(path) ? '' : attribute,
    );
  });
}

function decodePublicTextForScan(value: string, label: string): string {
  let decoded = value;
  try {
    for (let pass = 0; pass < 4 && decoded.includes('%'); pass += 1) {
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    throw new RangeError(`${label} contains malformed percent encoding`);
  }
  if (decoded.includes('%')) throw new RangeError(`${label} contains residual percent encoding`);
  return decoded;
}

function assertPublicText(value: string, label: string): void {
  const decodedValue = decodePublicTextForScan(value, label);
  const privacyScanText = svgAwarePrivacyScanText(decodedValue);
  const privateMatch = decodedValue.match(EMAIL_PATTERN) ?? decodedValue.match(FILE_URI_PATTERN)
    ?? privacyScanText.match(POSIX_PATH_PATTERN) ?? decodedValue.match(WINDOWS_PATH_PATTERN)
    ?? decodedValue.match(FORWARD_UNC_PATH_PATTERN) ?? decodedValue.match(SOURCE_FILE_PATTERN);
  if (privateMatch) {
    throw new RangeError(`${label} must not contain a private path or email address`);
  }
  const normalizedProcessText = decodedValue.normalize('NFKC').replace(/[^A-Za-z0-9]+/g, '');
  if (FORBIDDEN_PROCESS_PATTERN.test(normalizedProcessText) || PRESS_FIT_PATTERN.test(normalizedProcessText)
    || PRODUCTION_MATERIAL_CLAIM_PATTERN.test(normalizedProcessText)) {
    throw new RangeError(`${label} must not contain slots, holes, engraving, press fits, production material claims, or process settings`);
  }
}

function assertSafetyProvenance(value: Pick<AutomaticOutlineResult, 'mode' | 'status' | 'warnings' | 'repairAccepted'> & {
  readonly axisSource: AutomaticOutlineResult['axis']['source'];
}): void {
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string' || warning.trim() === '')
    || new Set(value.warnings).size !== value.warnings.length) {
    throw new RangeError('Outline safety warning provenance is empty or invalid');
  }
  const warnings = new Set(value.warnings);
  if (value.mode === 'outline-2.5d') {
    if (value.status !== 'warning' || PROJECTED_WARNINGS.some((warning) => !warnings.has(warning))) {
      throw new RangeError('2.5D outline provenance requires warning status and all simplification warnings');
    }
    if ((value.axisSource === 'shortest-bounds') !== warnings.has(FALLBACK_AXIS_WARNING)) {
      throw new RangeError('2.5D outline axis warning provenance is inconsistent');
    }
    if (value.repairAccepted !== warnings.has(EXACT_FALLBACK_WARNING)) {
      throw new RangeError('2.5D repair fallback warning provenance is inconsistent');
    }
    return;
  }
  if (value.mode !== 'exact' || value.repairAccepted !== true) {
    throw new RangeError('Exact outline provenance requires accepted repair');
  }
  const fallbackAxis = value.axisSource === 'shortest-bounds';
  if ((!fallbackAxis && (value.status !== 'success' || value.warnings.length !== 0))
    || (fallbackAxis && (value.status !== 'warning' || value.warnings.length !== 1 || !warnings.has(FALLBACK_AXIS_WARNING)))) {
    throw new RangeError('Exact outline status and warning provenance is inconsistent');
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
  if (!Number.isSafeInteger(result.removedComponentCount) || result.removedComponentCount < 0) {
    throw new RangeError('Outline removed-component count must be a non-negative safe integer');
  }
  if (!/^[0-9a-f]{32}$/.test(result.removalEvidenceFingerprint)
    || result.removalEvidenceFingerprint !== removalEvidenceFingerprint(result)) {
    throw new RangeError('Outline removal evidence fingerprint is missing or inconsistent');
  }
  if (!['exact', 'outline-2.5d'].includes(result.mode)) throw new RangeError('Outline mode provenance is invalid');
  const diagnostic = result.diagnostics;
  const inspection = result.originalReport.inspection;
  if (!diagnostic || diagnostic.repairDecision !== (result.repairAccepted ? 'accepted' : 'projected-original')
    || (result.mode === 'exact' ? diagnostic.rasterCellSizeMm !== null : !(Number.isFinite(diagnostic.rasterCellSizeMm) && diagnostic.rasterCellSizeMm! > 0))
    || JSON.stringify(diagnostic.topology) !== JSON.stringify({ triangleCount: inspection.triangleCount, boundaryEdgeCount: inspection.boundaryEdgeCount, nonManifoldEdgeCount: inspection.nonManifoldEdgeCount, degenerateTriangleCount: inspection.degenerateTriangleCount, duplicateTriangleCount: result.originalReport.duplicateTriangleCount, inconsistentWindingEdgeCount: result.originalReport.inconsistentWindingEdgeCount, selfIntersectionCount: result.originalReport.selfIntersectionCount, selfIntersectionAnalysisComplete: result.originalReport.selfIntersectionAnalysisComplete })
    || diagnostic.layers.length !== result.layers.length
    || diagnostic.layers.some((item, index) => JSON.stringify(item) !== JSON.stringify({ id: result.layers[index].id, simplificationToleranceMm: result.layers[index].simplificationToleranceMm, boundsDriftRatio: result.layers[index].boundsDriftRatio, areaDriftRatio: result.layers[index].areaDriftRatio, areaEvidenceBasis: result.mode === 'exact' ? 'exact-slice-pre-simplification' : 'retained-raster-pre-simplification' }))) {
    throw new RangeError('Outline diagnostics are missing or inconsistent');
  }
  const measuredRemoved = result.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0);
  if (!Number.isSafeInteger(measuredRemoved) || measuredRemoved !== result.removedComponentCount
    || (result.mode === 'exact' && measuredRemoved !== 0)) {
    throw new RangeError('Outline removed-component evidence is inconsistent');
  }
  if (!['success', 'warning', 'failure'].includes(result.status)) throw new RangeError('Outline status provenance is invalid');
  if (result.status === 'failure' || result.layers.length === 0) throw new RangeError('Cannot package a failed or empty outline result');
  if (result.layers.length > DEFAULT_OUTLINE_BUDGETS.maxLayers) throw new RangeError('Outline result exceeds the 24-layer pipeline budget');
  const axis = result.axis?.axis;
  const origin = axis?.origin, direction = axis?.direction;
  const directionLength = Array.isArray(direction) && direction.length === 3 ? Math.hypot(...direction) : Number.NaN;
  const shortestDirection = Array.isArray(direction) && direction.length === 3
    && direction.filter((component) => Math.abs(component) > 1e-12).length === 1
    && direction.some((component) => Math.abs(Math.abs(component) - 1) <= 1e-12);
  if (!['candidate', 'shortest-bounds'].includes(result.axis?.source)
    || axis?.confirmed !== true || !Array.isArray(origin) || origin.length !== 3
    || !Array.isArray(direction) || direction.length !== 3
    || ![...origin, ...direction, axis.confidence].every(Number.isFinite)
    || Math.abs(directionLength - 1) > 1e-12
    || (result.axis.source === 'candidate'
      ? axis.confidence < AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD || axis.confidence > 1
      : axis.confidence !== 0 || !shortestDirection)) {
    throw new RangeError('Outline axis provenance is invalid or empty');
  }
  assertSafetyProvenance({
    mode: result.mode,
    status: result.status,
    warnings: result.warnings,
    repairAccepted: result.repairAccepted,
    axisSource: result.axis.source,
  });
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
      index: item.layer.index,
      zStart: item.layer.zStart,
      zEnd: item.layer.zEnd,
      boundsMm: [item.width, item.height],
      sourceBoundsMm: { ...item.layer.sourceBoundsMm },
      pointCount: item.layer.contour.outer.length,
      sheetIndex,
      removedComponentCount: item.layer.removedComponentCount,
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
    repairAccepted: result.repairAccepted,
    removedComponentCount: result.removedComponentCount,
    removalEvidenceFingerprint: result.removalEvidenceFingerprint,
    axisSource: result.axis.source,
    diagnostics: structuredClone(result.diagnostics),
    diagnosticsFingerprint: diagnosticsFingerprint(result.diagnostics),
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
    repairAccepted: metadata.repairAccepted,
    removedComponentCount: metadata.removedComponentCount,
    removalEvidenceFingerprint: metadata.removalEvidenceFingerprint,
    axisSource: metadata.axisSource,
    diagnostics: structuredClone(metadata.diagnostics),
    diagnosticsFingerprint: metadata.diagnosticsFingerprint,
    layers: metadata.layers.map(({ id, order, index, zStart, zEnd, boundsMm, removedComponentCount }) => ({ id, order, index, zStart, zEnd, boundsMm, removedComponentCount })),
    materialIndependent: true,
  };
}

export async function createOutlinePackage(result: AutomaticOutlineResult, deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs): Promise<OutlinePackage> {
  checkPackageDeadline(deadline);
  const document = createOutlineDocument(result);
  checkPackageDeadline(deadline);
  const manifest = manifestFromDocument(document);
  const metadata = requireMetadata(document);
  const exportSheet = flattenOutlineSheets(document);
  const cutSvg = writeOutlineSvg(exportSheet, metadata);
  const cutDxf = writeOutlineDxf(exportSheet, metadata);
  const previewPdf = await writeOutlinePreviewPdf(metadata, document.sheets);
  checkPackageDeadline(deadline);
  const projectJson = writeOutlineProjectJson(document);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const zip = await writeOutlineZip({ cutSvg, cutDxf, previewPdf, projectJson, manifestJson });
  checkPackageDeadline(deadline);
  const output = { document, manifest, cutSvg, cutDxf, previewPdf, projectJson, manifestJson, zip };
  await verifyOutlinePackage(output, deadline);
  return output;
}

function requireMetadata(document: ManufacturingDocument): OutlineDocumentMetadata {
  if (!document.outline) throw new RangeError('Outline document metadata is required');
  return document.outline;
}

function validateOutlineDocument(document: ManufacturingDocument): void {
  const metadata = requireMetadata(document);
  if (!Array.isArray(metadata.layers) || metadata.layers.length === 0
    || metadata.layers.length > DEFAULT_OUTLINE_BUDGETS.maxLayers) {
    throw new RangeError('Outline document must contain between 1 and 24 layers within the pipeline budget');
  }
  if (document.unit !== 'mm' || !Array.isArray(document.sheets) || document.sheets.length === 0
    || !Array.isArray(document.manifest) || !Array.isArray(metadata.warnings)
    || !Number.isSafeInteger(metadata.removedComponentCount) || metadata.removedComponentCount < 0
    || !/^[0-9a-f]{32}$/.test(metadata.removalEvidenceFingerprint)
    || !/^[0-9a-f]{32}$/.test(metadata.diagnosticsFingerprint)
    || metadata.diagnosticsFingerprint !== diagnosticsFingerprint(metadata.diagnostics)
    || !HASH_PATTERN.test(metadata.sourceHash)
    || !['exact', 'outline-2.5d'].includes(metadata.mode) || !['success', 'warning'].includes(metadata.status)
    || !['candidate', 'shortest-bounds'].includes(metadata.axisSource)
    || document.provenance.inputFingerprint !== metadata.sourceHash || metadata.materialIndependent !== true) {
    throw new RangeError('Outline document provenance is invalid');
  }
  assertSafetyProvenance({
    mode: metadata.mode,
    status: metadata.status,
    warnings: metadata.warnings,
    repairAccepted: metadata.repairAccepted,
    axisSource: metadata.axisSource,
  });
  const diagnostic = metadata.diagnostics;
  const topologyValues = diagnostic ? Object.values(diagnostic.topology) : [];
  if (!diagnostic || diagnostic.repairDecision !== (metadata.repairAccepted ? 'accepted' : 'projected-original')
    || (metadata.mode === 'exact' ? diagnostic.rasterCellSizeMm !== null : !(Number.isFinite(diagnostic.rasterCellSizeMm) && diagnostic.rasterCellSizeMm! > 0))
    || topologyValues.length !== 8
    || topologyValues.some((value, index) => index === 7 ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || (value as number) < 0)
    || diagnostic.layers.length !== metadata.layers.length
    || diagnostic.layers.some((item, index) => item.id !== metadata.layers[index].id
      || item.areaEvidenceBasis !== (metadata.mode === 'exact' ? 'exact-slice-pre-simplification' : 'retained-raster-pre-simplification')
      || ![item.simplificationToleranceMm, item.boundsDriftRatio, item.areaDriftRatio].every(Number.isFinite)
      || item.simplificationToleranceMm <= 0 || item.boundsDriftRatio < 0 || item.boundsDriftRatio > 0.03 + 1e-12
      || item.areaDriftRatio < 0 || item.areaDriftRatio > 0.03 + 1e-12)) {
    throw new RangeError('Outline diagnostic provenance is invalid');
  }
  for (const warning of metadata.warnings) assertPublicText(warning, 'Outline warning');
  if (metadata.layers.length !== document.manifest.length) throw new RangeError('Outline document layer manifest mismatch');
  const ids = new Set<string>();
  for (const [index, layer] of metadata.layers.entries()) {
    const source = layer.sourceBoundsMm;
    if (!SAFE_ID_PATTERN.test(layer.id) || ids.has(layer.id) || layer.order !== index + 1
      || !Number.isSafeInteger(layer.pointCount) || layer.pointCount < 3 || layer.pointCount > 4096
      || !Number.isSafeInteger(layer.sheetIndex) || layer.sheetIndex < 0
      || !Number.isSafeInteger(layer.removedComponentCount) || layer.removedComponentCount < 0
      || !Array.isArray(layer.boundsMm) || layer.boundsMm.length !== 2
      || ![layer.zStart, layer.zEnd, ...layer.boundsMm].every(Number.isFinite) || layer.zEnd <= layer.zStart
      || layer.boundsMm[0] <= 0 || layer.boundsMm[1] <= 0 || layer.boundsMm[0] > MAX_PART_MM || layer.boundsMm[1] > MAX_PART_MM
      || !source || ![source.minX, source.minY, source.maxX, source.maxY].every(Number.isFinite)
      || source.maxX <= source.minX || source.maxY <= source.minY
      || relativeDifference(source.maxX - source.minX, layer.boundsMm[0]) > 0.06 + 1e-12
      || relativeDifference(source.maxY - source.minY, layer.boundsMm[1]) > 0.06 + 1e-12) {
      throw new RangeError('Outline document identity, bounds, or sourceBounds provenance is invalid');
    }
    if (index > 0) {
      const prior = metadata.layers[index - 1];
      if (layer.zStart < prior.zStart || (layer.zStart === prior.zStart && layer.zEnd < prior.zEnd)) {
        throw new RangeError('Outline document layer order is not deterministic');
      }
    }
    assertPublicText(layer.id, 'Outline layer ID');
    ids.add(layer.id);
  }
  const removedComponentCount = metadata.layers.reduce((sum, layer) => sum + layer.removedComponentCount, 0);
  if (!Number.isSafeInteger(removedComponentCount) || removedComponentCount !== metadata.removedComponentCount
    || (metadata.mode === 'exact' && removedComponentCount !== 0)) {
    throw new RangeError('Outline removed-component evidence is inconsistent');
  }
  const expectedRemovalFingerprint = removalEvidenceFingerprint({
    sourceHash: metadata.sourceHash, mode: metadata.mode,
    layers: metadata.layers.map(({ id, index, zStart, zEnd, removedComponentCount }) => ({ id, index, zStart, zEnd, removedComponentCount } as OutlineLayer)),
  });
  if (metadata.removalEvidenceFingerprint !== expectedRemovalFingerprint) throw new RangeError('Outline removal evidence fingerprint is inconsistent');

  const canvasWidth = Math.min(1000, Math.max(300, Math.ceil(Math.max(...metadata.layers.map(({ boundsMm }) => boundsMm[0])) + 10)));
  let sheetIndex = 0, entityIndex = 0;
  let cursorX = MARGIN_MM, cursorY = MARGIN_MM, rowHeight = 0, maxY = MARGIN_MM;
  let sheetPolygons: LayerEntity['polygon'][] = [];
  const finishExpectedSheet = (): void => {
    const sheet = document.sheets[sheetIndex];
    if (!sheet || entityIndex === 0 || sheet.entities.length !== entityIndex
      || sheet.width !== canvasWidth || sheet.height !== Math.ceil(maxY + MARGIN_MM)
      || sheet.height > MAX_SHEET_HEIGHT_MM) {
      throw new RangeError('Outline document sheet bounds or deterministic placement is invalid');
    }
  };

  for (const [index, layer] of metadata.layers.entries()) {
    const [width, height] = layer.boundsMm;
    if (cursorX + width > canvasWidth - MARGIN_MM && entityIndex > 0) {
      cursorX = MARGIN_MM;
      cursorY += rowHeight + SPACING_MM;
      rowHeight = 0;
    }
    if (cursorY + height > MAX_SHEET_HEIGHT_MM - MARGIN_MM && entityIndex > 0) {
      finishExpectedSheet();
      sheetIndex += 1; entityIndex = 0;
      cursorX = MARGIN_MM; cursorY = MARGIN_MM; rowHeight = 0; maxY = MARGIN_MM;
      sheetPolygons = [];
    }
    const sheet = document.sheets[sheetIndex];
    const part = document.manifest[index], entity = sheet?.entities[entityIndex];
    if (!sheet || !entity || layer.sheetIndex !== sheetIndex
      || part?.partId !== layer.id || part.quantity !== 1 || part.assemblyOrder !== layer.order
      || entity.id !== layer.id || entity.partId !== layer.id || entity.instance !== 0
      || entity.layer !== 'CUT' || entity.contour !== 'outline'
      || !entity.polygon || !Array.isArray(entity.polygon.points) || entity.polygon.points.length !== layer.pointCount) {
      throw new RangeError('Outline document identity, order, or CUT geometry mismatch');
    }
    if (!validatePolygon(entity.polygon)) {
      throw new RangeError('Outline document polygon must be finite, simple, unique, non-zero, and clockwise');
    }
    const uniquePoints = new Set(entity.polygon.points.map((point: readonly [number, number]) => `${point[0]}:${point[1]}`));
    const area = polygonMassProperties(entity.polygon).area;
    if (uniquePoints.size !== entity.polygon.points.length || !Number.isFinite(area) || area <= 0
      || signedArea(entity.polygon.points) >= 0) {
      throw new RangeError('Outline document polygon must be finite, simple, unique, non-zero, and clockwise');
    }
    const bounds = contourBounds(entity.polygon.points);
    const actualWidth = bounds.maxX - bounds.minX, actualHeight = bounds.maxY - bounds.minY;
    if (!nearlyEqual(bounds.minX, cursorX) || !nearlyEqual(bounds.minY, cursorY)
      || !nearlyEqual(actualWidth, width) || !nearlyEqual(actualHeight, height)
      || (bounds.minX < MARGIN_MM && !nearlyEqual(bounds.minX, MARGIN_MM))
      || (bounds.minY < MARGIN_MM && !nearlyEqual(bounds.minY, MARGIN_MM))
      || (bounds.maxX > sheet.width - MARGIN_MM && !nearlyEqual(bounds.maxX, sheet.width - MARGIN_MM))
      || (bounds.maxY > sheet.height - MARGIN_MM && !nearlyEqual(bounds.maxY, sheet.height - MARGIN_MM))) {
      throw new RangeError('Outline document geometry violates bounds, 5 mm margins, deterministic placement, or no-rescaling');
    }
    if (sheetPolygons.some((polygon) => polygonsIntersectOrTouch(polygon, entity.polygon))) {
      throw new RangeError('Outline document parts overlap or touch');
    }
    sheetPolygons.push(entity.polygon);
    entityIndex += 1;
    cursorX += width + SPACING_MM;
    rowHeight = Math.max(rowHeight, height);
    maxY = Math.max(maxY, cursorY + height);
  }
  finishExpectedSheet();
  if (sheetIndex !== document.sheets.length - 1) throw new RangeError('Outline document contains unexpected or empty sheets');
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

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(Number.MIN_VALUE, Math.abs(left));
}

export async function verifyOutlinePackage(output: OutlinePackage, deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs): Promise<void> {
  checkPackageDeadline(deadline);
  validateOutlineDocument(output.document);
  checkPackageDeadline(deadline);
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
  const expectedPdf = await writeOutlinePreviewPdf(metadata, output.document.sheets);
  checkPackageDeadline(deadline);
  if (expectedPdf.length !== output.previewPdf.length
    || expectedPdf.some((byte, index) => byte !== output.previewPdf[index])) {
    throw new RangeError('Outline PDF content and CUT geometry reconciliation mismatch');
  }
  const pdf = await PDFDocument.load(output.previewPdf);
  const keywords = pdf.getKeywords() ?? '';
  const requiredKeywords = [
    `outline-source:${metadata.sourceHash}`,
    `outline-mode:${metadata.mode}`,
    `outline-status:${metadata.status}`,
    `repair-accepted:${metadata.repairAccepted}`,
    `removed-components:${metadata.removedComponentCount}`,
    `removal-evidence:${metadata.removalEvidenceFingerprint}`,
    `diagnostics-evidence:${metadata.diagnosticsFingerprint}`,
    `axis-source:${metadata.axisSource}`,
    'material-independent:true',
    ...metadata.layers.map((layer) => `outline-layer:${layer.id}:${layer.order}:${layer.index}:${layer.pointCount}:${layer.boundsMm[0]}x${layer.boundsMm[1]}:${layer.zStart}:${layer.zEnd}:${layer.removedComponentCount}`),
  ];
  const actualKeywords = keywords === '' ? [] : keywords.split(/\s+/);
  if (exactJson(actualKeywords) !== exactJson(requiredKeywords)) throw new RangeError('Outline PDF metadata reconciliation mismatch');
  const pdfMetadata = [
    pdf.getTitle(), pdf.getSubject(), pdf.getAuthor(), pdf.getCreator(), pdf.getProducer(), keywords,
  ].filter((value): value is string => typeof value === 'string').join('\n');
  assertPublicText(pdfMetadata, 'Outline PDF metadata');

  [output.cutSvg, output.cutDxf, output.projectJson, output.manifestJson].forEach((value) => assertPublicText(value, 'Outline package'));
  const zip = await JSZip.loadAsync(output.zip);
  checkPackageDeadline(deadline);
  const entries = Object.entries(zip.files).sort(([left], [right]) => left.localeCompare(right));
  for (const [path, entry] of entries) {
    const originalPath = entry.unsafeOriginalName ?? path;
    assertPublicText(path, 'Outline ZIP entry');
    assertPublicText(originalPath, 'Outline ZIP original entry');
    if (originalPath !== path) throw new RangeError('Outline ZIP original entry name is unsafe or was sanitized');
  }
  const paths = entries.map(([path]) => path);
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
