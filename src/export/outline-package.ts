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
import {
  createColoredOutlineDocument,
  validateColoredOutlineDocument,
  type ColoredDocumentDeadlineOptions,
} from './colored-outline-document';
import { writeColoredPreviewPdf, writeExplodedViewPdf } from './exploded-pdf';
import {
  createLauncherFitCoupon,
  verifyLauncherFitCouponSvg,
  writeLauncherFitCouponSvg,
} from './launcher-fit-coupon';
import {
  coloredOutlineEntityRecords,
  parseColoredOutlineDxf,
  parseColoredOutlineSvg,
  writeColoredOutlineDxf,
  writeColoredOutlineSvg,
  writeColoredOutlineZip,
} from './package';

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
const checkPackageDeadline = (deadline: number, now: () => number = Date.now): void => {
  if (!Number.isFinite(deadline) || now() > deadline) throw new RangeError('Outline package exceeded the shared deadline');
};
type PackageDeadlineOptions = { readonly now?: () => number; readonly onCheckpoint?: (label: string) => void };
type PackageDeadlineInput = PackageDeadlineOptions | (() => number);
type PackageCheckpoint = (label: string) => void;
const packageCheckpoint = (deadline: number, input: PackageDeadlineInput): PackageCheckpoint => (label) => {
  const options = typeof input === 'function' ? { now: input } : input;
  options.onCheckpoint?.(label);
  checkPackageDeadline(deadline, options.now ?? Date.now);
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

export type ColoredOutlinePackage = {
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly explodedViewPdf: Uint8Array;
  readonly launcherCouponSvg: string;
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

function measured(layer: OutlineLayer, checkpoint: PackageCheckpoint = () => undefined): MeasuredLayer {
  checkpoint('create:measure-layer');
  const validation = validateOutlineLayer(layer, Infinity, () => checkpoint('create:outline-validation-loop'));
  if (!validation.ok) throw new RangeError(`Invalid outline layer ${layer.id}: ${validation.reasons.join('; ')}`);
  if (!SAFE_ID_PATTERN.test(layer.id)) throw new RangeError('Outline layer IDs must be safe portable identifiers');
  assertPublicText(layer.id, 'Outline layer ID');
  const bounds = contourBounds(layer.contour.outer, Infinity, () => checkpoint('create:contour-bounds-loop'));
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  if (width > MAX_PART_MM || height > MAX_PART_MM) {
    throw new RangeError('Outline part exceeds the 990 mm size limit and cannot be rescaled');
  }
  return { layer, width, height, minX: bounds.minX, minY: bounds.minY };
}

function sortedLayers(result: AutomaticOutlineResult, checkpoint: PackageCheckpoint = () => undefined): MeasuredLayer[] {
  checkpoint('create:sorted-layers:start');
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
    checkpoint('create:metadata-layer-loop');
    if (ids.has(item.id) || indices.has(item.index)) throw new RangeError('Outline layer IDs and indices must be unique');
    ids.add(item.id); indices.add(item.index);
    return measured(item, checkpoint);
  });
  return values.sort((left, right) => left.layer.zStart - right.layer.zStart
    || left.layer.zEnd - right.layer.zEnd || left.layer.index - right.layer.index || left.layer.id.localeCompare(right.layer.id));
}

export function createOutlineDocument(result: AutomaticOutlineResult, checkpoint: PackageCheckpoint = () => undefined): ManufacturingDocument {
  const layers = sortedLayers(result, checkpoint);
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
    checkpoint('create:document-layer-loop');
    if (cursorX + item.width > canvasWidth - MARGIN_MM && entities.length > 0) {
      cursorX = MARGIN_MM;
      cursorY += rowHeight + SPACING_MM;
      rowHeight = 0;
    }
    if (cursorY + item.height > MAX_SHEET_HEIGHT_MM - MARGIN_MM && entities.length > 0) finishSheet();
    const points = item.layer.contour.outer.map(([x, y], pointIndex) => {
      if ((pointIndex & 63) === 0) checkpoint('create:document-point-loop');
      return [x - item.minX + cursorX, y - item.minY + cursorY] as const;
    });
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
  validateOutlineDocument(document, checkpoint);
  checkpoint('create:document:return');
  return document;
}

function manifestFromDocument(document: ManufacturingDocument, checkpoint: PackageCheckpoint = () => undefined): OutlineManifestV1 {
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
    layers: metadata.layers.map(({ id, order, index, zStart, zEnd, boundsMm, removedComponentCount }) => {
      checkpoint('metadata:manifest-layer-loop');
      return { id, order, index, zStart, zEnd, boundsMm, removedComponentCount };
    }),
    materialIndependent: true,
  };
}

export async function createLegacyOutlinePackage(result: AutomaticOutlineResult, deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs, options: PackageDeadlineInput = {}): Promise<OutlinePackage> {
  const checkpoint = packageCheckpoint(deadline, options);
  checkpoint('create:start');
  const document = createOutlineDocument(result, checkpoint);
  checkpoint('create:document:after');
  const manifest = manifestFromDocument(document, checkpoint);
  const metadata = requireMetadata(document);
  const exportSheet = flattenOutlineSheets(document, checkpoint);
  const cutSvg = writeOutlineSvg(exportSheet, metadata, checkpoint);
  const cutDxf = writeOutlineDxf(exportSheet, metadata, checkpoint);
  const previewPdf = await writeOutlinePreviewPdf(metadata, document.sheets, checkpoint);
  checkpoint('create:pdf:after');
  const projectJson = writeOutlineProjectJson(document);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const zip = await writeOutlineZip({ cutSvg, cutDxf, previewPdf, projectJson, manifestJson }, checkpoint);
  checkpoint('create:zip:after');
  const output = { document, manifest, cutSvg, cutDxf, previewPdf, projectJson, manifestJson, zip };
  await verifyLegacyOutlinePackage(output, deadline, options);
  checkpoint('create:return');
  return output;
}

function requireMetadata(document: ManufacturingDocument): OutlineDocumentMetadata {
  if (!document.outline) throw new RangeError('Outline document metadata is required');
  return document.outline;
}

function validateOutlineDocument(document: ManufacturingDocument, checkpoint: PackageCheckpoint = () => undefined): void {
  checkpoint('verify:document:start');
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
  for (const warning of metadata.warnings) { checkpoint('verify:metadata-warning-loop'); assertPublicText(warning, 'Outline warning'); }
  if (metadata.layers.length !== document.manifest.length) throw new RangeError('Outline document layer manifest mismatch');
  const ids = new Set<string>();
  for (const [index, layer] of metadata.layers.entries()) {
    checkpoint('verify:metadata-layer-loop');
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
      || relativeDifference(source.maxX - source.minX, layer.boundsMm[0]) > 0.03 + 1e-12
      || relativeDifference(source.maxY - source.minY, layer.boundsMm[1]) > 0.03 + 1e-12) {
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
    checkpoint('verify:entity-loop');
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
    if (!validatePolygon(entity.polygon, () => checkpoint('verify:polygon-validation-loop'))) {
      throw new RangeError('Outline document polygon must be finite, simple, unique, non-zero, and clockwise');
    }
    const uniquePoints = new Set(entity.polygon.points.map((point: readonly [number, number]) => `${point[0]}:${point[1]}`));
    checkpoint('verify:entity-points:after');
    const area = polygonMassProperties(entity.polygon).area;
    if (uniquePoints.size !== entity.polygon.points.length || !Number.isFinite(area) || area <= 0
      || signedArea(entity.polygon.points) >= 0) {
      throw new RangeError('Outline document polygon must be finite, simple, unique, non-zero, and clockwise');
    }
    const bounds = contourBounds(entity.polygon.points, Infinity, () => checkpoint('verify:entity-bounds-loop'));
    const actualWidth = bounds.maxX - bounds.minX, actualHeight = bounds.maxY - bounds.minY;
    const sourceWidth = layer.sourceBoundsMm.maxX - layer.sourceBoundsMm.minX;
    const sourceHeight = layer.sourceBoundsMm.maxY - layer.sourceBoundsMm.minY;
    const recomputedBoundsDrift = Math.max(
      Math.abs(actualWidth - sourceWidth) / sourceWidth, Math.abs(actualHeight - sourceHeight) / sourceHeight,
    );
    if (!nearlyEqual(recomputedBoundsDrift, metadata.diagnostics.layers[index].boundsDriftRatio)) {
      throw new RangeError('Outline diagnostic bounds drift does not match canonical geometry');
    }
    if (!nearlyEqual(bounds.minX, cursorX) || !nearlyEqual(bounds.minY, cursorY)
      || !nearlyEqual(actualWidth, width) || !nearlyEqual(actualHeight, height)
      || (bounds.minX < MARGIN_MM && !nearlyEqual(bounds.minX, MARGIN_MM))
      || (bounds.minY < MARGIN_MM && !nearlyEqual(bounds.minY, MARGIN_MM))
      || (bounds.maxX > sheet.width - MARGIN_MM && !nearlyEqual(bounds.maxX, sheet.width - MARGIN_MM))
      || (bounds.maxY > sheet.height - MARGIN_MM && !nearlyEqual(bounds.maxY, sheet.height - MARGIN_MM))) {
      throw new RangeError('Outline document geometry violates bounds, 5 mm margins, deterministic placement, or no-rescaling');
    }
    if (sheetPolygons.some((polygon) => polygonsIntersectOrTouch(polygon, entity.polygon, (label) => checkpoint(`verify:polygon-overlap:${label ?? 'segment-loop'}`)))) {
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

function canonicalEntities(sheet: ManufacturingSheet, checkpoint: PackageCheckpoint = () => undefined): unknown[] {
  return sheet.entities.map((entity) => ({
    id: entity.id,
    partId: entity.partId,
    instance: entity.instance,
    contour: entity.contour,
    layer: entity.layer,
    points: entity.polygon.points.map((point, index) => { if ((index & 63) === 0) checkpoint('verify:canonical-point-loop'); return [...point]; }),
  }));
}

function svgEntities(svg: string, checkpoint: PackageCheckpoint = () => undefined): unknown[] {
  checkpoint('verify:svg-scan');
  return [...svg.matchAll(/<g id="layer-([^"]+)"[^>]*>(.*?)<\/g>/gs)].flatMap((group) =>
    [...group[2].matchAll(/<polygon id="([^"]+)"[^>]*data-part-id="([^"]+)" data-instance="(\d+)" data-contour="([^"]+)" points="([^"]+)"\/>/g)].map((match) => ({
      id: match[1], partId: match[2], instance: Number(match[3]), contour: match[4], layer: group[1],
      points: match[5].split(' ').map((point, index) => { if ((index & 63) === 0) checkpoint('verify:svg-point-scan'); return point.split(',').map(Number); }),
    })),
  );
}

function dxfEntities(dxf: string, checkpoint: PackageCheckpoint = () => undefined): unknown[] {
  checkpoint('verify:dxf-scan');
  return [...dxf.matchAll(/999\nENTITY_ID:([^\n]+)\n999\nPART_ID:([^\n]+)\n999\nINSTANCE:(\d+)\n999\nCONTOUR:([^\n]+)\n0\nLWPOLYLINE\n8\n([^\n]+)\n90\n(\d+)\n70\n1\n((?:10\n[^\n]+\n20\n[^\n]+\n)+)/g)].map((match) => {
    const points = [...match[7].matchAll(/10\n([^\n]+)\n20\n([^\n]+)\n/g)].map((point, index) => { if ((index & 63) === 0) checkpoint('verify:dxf-point-scan'); return [Number(point[1]), Number(point[2])]; });
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

export async function verifyLegacyOutlinePackage(output: OutlinePackage, deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs, options: PackageDeadlineInput = {}): Promise<void> {
  const checkpoint = packageCheckpoint(deadline, options);
  checkpoint('verify:start');
  validateOutlineDocument(output.document, checkpoint);
  checkpoint('verify:document:after');
  const expectedManifest = manifestFromDocument(output.document, checkpoint);
  if (exactJson(output.manifest) !== exactJson(expectedManifest)
    || exactJson(JSON.parse(output.manifestJson)) !== exactJson(expectedManifest)) {
    throw new RangeError('Outline manifest reconciliation mismatch');
  }
  const project = JSON.parse(output.projectJson);
  if (exactJson(project) !== exactJson(JSON.parse(writeOutlineProjectJson(output.document)))) {
    throw new RangeError('Outline project JSON reconciliation mismatch');
  }
  const exportSheet = flattenOutlineSheets(output.document, checkpoint);
  const expectedEntities = canonicalEntities(exportSheet, checkpoint);
  if (exactJson(svgEntities(output.cutSvg, checkpoint)) !== exactJson(expectedEntities)
    || exactJson(dxfEntities(output.cutDxf, checkpoint)) !== exactJson(expectedEntities)) {
    throw new RangeError('Outline geometry reconciliation mismatch');
  }
  const metadata = requireMetadata(output.document);
  if (output.cutSvg !== writeOutlineSvg(exportSheet, metadata, checkpoint) || output.cutDxf !== writeOutlineDxf(exportSheet, metadata, checkpoint)) {
    throw new RangeError('Outline metadata reconciliation mismatch');
  }
  const expectedPdf = await writeOutlinePreviewPdf(metadata, output.document.sheets, checkpoint);
  checkpoint('verify:pdf-regenerate:after');
  if (expectedPdf.length !== output.previewPdf.length
    || expectedPdf.some((byte, index) => byte !== output.previewPdf[index])) {
    throw new RangeError('Outline PDF content and CUT geometry reconciliation mismatch');
  }
  const pdf = await PDFDocument.load(output.previewPdf);
  checkpoint('verify:pdf-load:after');
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
  checkpoint('verify:zip-load:after');
  const entries = Object.entries(zip.files).sort(([left], [right]) => left.localeCompare(right));
  for (const [path, entry] of entries) {
    checkpoint(`verify:zip-entry:${path}:metadata`);
    const originalPath = entry.unsafeOriginalName ?? path;
    assertPublicText(path, 'Outline ZIP entry');
    assertPublicText(originalPath, 'Outline ZIP original entry');
    if (originalPath !== path) throw new RangeError('Outline ZIP original entry name is unsafe or was sanitized');
  }
  const paths = entries.map(([path]) => path);
  if (exactJson(paths) !== exactJson(['cut.dxf', 'cut.svg', 'manifest.json', 'preview.pdf', 'project.json'])) {
    throw new RangeError('Outline ZIP entry reconciliation mismatch');
  }
  checkpoint('verify:zip-entry:preview.pdf:before-read');
  const zippedPdf = await zip.file('preview.pdf')!.async('uint8array');
  checkpoint('verify:zip-entry:preview.pdf:after-read');
  checkpoint('verify:zip-entry:cut.svg:before-read');
  const zippedSvg = await zip.file('cut.svg')!.async('string'); checkpoint('verify:zip-entry:cut.svg:after-read');
  checkpoint('verify:zip-entry:cut.dxf:before-read');
  const zippedDxf = await zip.file('cut.dxf')!.async('string'); checkpoint('verify:zip-entry:cut.dxf:after-read');
  checkpoint('verify:zip-entry:project.json:before-read');
  const zippedProject = await zip.file('project.json')!.async('string'); checkpoint('verify:zip-entry:project.json:after-read');
  checkpoint('verify:zip-entry:manifest.json:before-read');
  const zippedManifest = await zip.file('manifest.json')!.async('string'); checkpoint('verify:zip-entry:manifest.json:after-read');
  if (zippedSvg !== output.cutSvg
    || zippedDxf !== output.cutDxf
    || zippedProject !== output.projectJson
    || zippedManifest !== output.manifestJson
    || zippedPdf.length !== output.previewPdf.length
    || zippedPdf.some((byte, index) => byte !== output.previewPdf[index])) {
    throw new RangeError('Outline ZIP package reconciliation mismatch');
  }
  checkpoint('verify:return');
}

function coloredDeadlineOptions(input: PackageDeadlineInput): ColoredDocumentDeadlineOptions {
  return typeof input === 'function' ? { now: input } : input;
}

function bytesEqual(
  left: Uint8Array,
  right: Uint8Array,
  checkpoint: PackageCheckpoint,
  label: string,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if ((index & 4095) === 0) checkpoint(`${label}-byte-loop`);
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const COLORED_ZIP_NAMES = Object.freeze([
  'cut-and-engrave.svg', 'cut-and-engrave.dxf', 'preview.pdf', 'exploded-view.pdf',
  'launcher-fit-coupon.svg', 'project.json', 'manifest.json',
] as const);
const MAX_COLORED_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_COLORED_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const ZIP_NAME_BYTES = Object.freeze(COLORED_ZIP_NAMES.map((name) => ({
  name,
  bytes: new TextEncoder().encode(name),
})));
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

type RawColoredZipRecord = {
  readonly name: typeof COLORED_ZIP_NAMES[number];
  readonly rawName: Uint8Array;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly modifiedTime: number;
  readonly modifiedDate: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly dataStart: number;
  readonly dataEnd: number;
};

function rawBytesEqual(
  left: Uint8Array,
  right: Uint8Array,
  checkpoint: PackageCheckpoint,
  label: string,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if ((index & 255) === 0) checkpoint(`${label}-byte-loop`);
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function canonicalZipName(rawName: Uint8Array, checkpoint: PackageCheckpoint): typeof COLORED_ZIP_NAMES[number] {
  for (const expected of ZIP_NAME_BYTES) {
    if (rawBytesEqual(rawName, expected.bytes, checkpoint, 'colored-package:verify-zip-name')) return expected.name;
  }
  throw new RangeError('Colored ZIP record name bytes are not a canonical allowed filename');
}

function payloadCrc32(bytes: Uint8Array, checkpoint: PackageCheckpoint, label: string): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    if ((index & 4095) === 0) checkpoint(`${label}-byte-loop`);
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseRawColoredZip(bytes: Uint8Array, checkpoint: PackageCheckpoint): RawColoredZipRecord[] {
  if (bytes.length < 22 || bytes.length > MAX_COLORED_ZIP_BYTES) {
    throw new RangeError('Colored ZIP archive size is outside the canonical bound');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  checkpoint('colored-package:verify-zip-central-byte-loop');
  if (view.getUint32(eocd, true) !== 0x06054b50 || view.getUint16(eocd + 20, true) !== 0) {
    throw new RangeError('Colored ZIP must end with one canonical uncommented EOCD record');
  }

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskRecords = view.getUint16(eocd + 8, true);
  const recordCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskRecords !== recordCount || recordCount !== COLORED_ZIP_NAMES.length
    || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new RangeError('Colored ZIP must use one exact seven-record non-ZIP64 central directory');
  }
  const centralEnd = centralOffset + centralSize;
  if (centralOffset > eocd || centralEnd !== eocd) {
    throw new RangeError('Colored ZIP central directory bounds are invalid');
  }

  const records: Omit<RawColoredZipRecord, 'dataStart' | 'dataEnd'>[] = [];
  const names = new Set<string>();
  let totalUncompressedSize = 0;
  let cursor = centralOffset;
  for (let record = 0; record < recordCount; record += 1) {
    checkpoint('colored-package:verify-zip-central-record-loop');
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new RangeError('Colored ZIP central directory record is invalid');
    }
    const versionMadeBy = view.getUint16(cursor + 4, true);
    const versionNeeded = view.getUint16(cursor + 6, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const modifiedTime = view.getUint16(cursor + 12, true);
    const modifiedDate = view.getUint16(cursor + 14, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const internalAttributes = view.getUint16(cursor + 36, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || cursor + recordLength > centralEnd || extraLength !== 0 || commentLength !== 0) {
      throw new RangeError('Colored ZIP central directory record bounds are invalid');
    }
    if (versionMadeBy !== 20 || versionNeeded !== 10 || flags !== 0 || method !== 8
      || diskStart !== 0 || internalAttributes !== 0 || externalAttributes !== 0) {
      throw new RangeError('Colored ZIP central record is encrypted, uses a descriptor, or is not canonical DEFLATE');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff
      || compressedSize > MAX_COLORED_ZIP_BYTES || uncompressedSize > MAX_COLORED_ZIP_UNCOMPRESSED_BYTES) {
      throw new RangeError('Colored ZIP record uses ZIP64 or exceeds the canonical size bound');
    }
    const rawName = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = canonicalZipName(rawName, checkpoint);
    if (names.has(name)) throw new RangeError('Colored ZIP contains a duplicate central record name');
    names.add(name);
    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_COLORED_ZIP_UNCOMPRESSED_BYTES) {
      throw new RangeError('Colored ZIP total uncompressed size exceeds the canonical bound');
    }
    records.push({
      name, rawName, versionNeeded, flags, method, modifiedTime, modifiedDate, crc32,
      compressedSize, uncompressedSize, localOffset,
    });
    cursor += recordLength;
  }
  if (cursor !== centralEnd) throw new RangeError('Colored ZIP central directory record count is inconsistent');
  if (exactJson(records.map(({ name }) => name)) !== exactJson(COLORED_ZIP_NAMES)) {
    throw new RangeError('Colored ZIP central directory records must use the exact writer order');
  }

  const reconciled = new Map<number, RawColoredZipRecord>();
  let expectedLocalOffset = 0;
  for (const record of [...records].sort((left, right) => left.localOffset - right.localOffset)) {
    checkpoint('colored-package:verify-zip-local-record-loop');
    const localOffset = record.localOffset;
    if (localOffset !== expectedLocalOffset || localOffset + 30 > centralOffset
      || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new RangeError('Colored ZIP local record offsets overlap, contain gaps, or are out of range');
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (view.getUint16(localOffset + 4, true) !== record.versionNeeded
      || view.getUint16(localOffset + 6, true) !== record.flags
      || view.getUint16(localOffset + 8, true) !== record.method
      || view.getUint16(localOffset + 10, true) !== record.modifiedTime
      || view.getUint16(localOffset + 12, true) !== record.modifiedDate
      || view.getUint32(localOffset + 14, true) !== record.crc32
      || view.getUint32(localOffset + 18, true) !== record.compressedSize
      || view.getUint32(localOffset + 22, true) !== record.uncompressedSize
      || localNameLength !== record.rawName.length || localExtraLength !== 0) {
      throw new RangeError('Colored ZIP local header does not exactly match its central record');
    }
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd > centralOffset
      || !rawBytesEqual(bytes.subarray(localNameStart, localNameEnd), record.rawName, checkpoint, 'colored-package:verify-zip-local-name')) {
      throw new RangeError('Colored ZIP local filename bytes do not match the central record');
    }
    const dataStart = localNameEnd;
    const dataEnd = dataStart + record.compressedSize;
    if (dataEnd > centralOffset || dataEnd < dataStart) {
      throw new RangeError('Colored ZIP compressed data range is out of bounds');
    }
    reconciled.set(localOffset, { ...record, dataStart, dataEnd });
    expectedLocalOffset = dataEnd;
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new RangeError('Colored ZIP has hidden or trailing local data before the central directory');
  }
  return records.map((record) => {
    const reconciledRecord = reconciled.get(record.localOffset);
    if (!reconciledRecord) throw new RangeError('Colored ZIP local record reconciliation is incomplete');
    return reconciledRecord;
  });
}

function assertColoredPublicText(value: string, label: string): void {
  const decoded = decodePublicTextForScan(value, label);
  const privacyScanText = svgAwarePrivacyScanText(decoded);
  const privateMatch = decoded.match(EMAIL_PATTERN) ?? decoded.match(FILE_URI_PATTERN)
    ?? privacyScanText.match(POSIX_PATH_PATTERN) ?? decoded.match(WINDOWS_PATH_PATTERN)
    ?? decoded.match(FORWARD_UNC_PATH_PATTERN) ?? decoded.match(SOURCE_FILE_PATTERN);
  if (privateMatch) throw new RangeError(`${label} must not contain a private path, source filename, or email address`);
  if (/80\s*%|40\s*%|power|speed|pass(?:es)?|material|\.stl\b|\.json\b|manifest/i.test(decoded.normalize('NFKC'))) {
    throw new RangeError(`${label} must not contain source, JSON, manifest, material, or machine-setting text`);
  }
}

function assertExactColoredOutputKeys(output: ColoredOutlinePackage): void {
  const keys = Object.keys(output).sort();
  if (exactJson(keys) !== exactJson([
    'cutDxf', 'cutSvg', 'explodedViewPdf', 'launcherCouponSvg', 'manifestJson',
    'previewPdf', 'projectJson', 'zip',
  ])) {
    throw new RangeError('Colored outline package must expose exactly eight canonical payloads');
  }
}

function coloredProjectJson(document: ReturnType<typeof createColoredOutlineDocument>): string {
  const project = {
    schemaVersion: document.schemaVersion,
    sourceHash: document.sourceHash,
    featureEvidenceFingerprint: document.featureEvidenceFingerprint,
    diagnosticsFingerprint: document.diagnosticsFingerprint,
    safetyNotes: document.safetyNotes,
    assembly: {
      material: {
        id: document.assembly.material.id,
        thicknessMm: document.assembly.material.thicknessMm,
        kerfMm: document.assembly.material.kerfMm,
        minFeatureMm: document.assembly.material.minFeatureMm,
        minWebMm: document.assembly.material.minWebMm,
        fitAllowanceMm: document.assembly.material.fitAllowanceMm,
      },
      launcher: document.assembly.launcher,
      fastener: document.assembly.fastener,
      topFeatures: document.assembly.topFeatures,
    },
    layers: document.layers.map((layer) => ({
      id: layer.id,
      order: layer.order,
      index: layer.index,
      zStart: layer.zStart,
      zEnd: layer.zEnd,
      members: Object.fromEntries(
        Object.entries(layer.roles).map(([role, contours]) => [
          role,
          contours.map(({ id }) => id),
        ]),
      ),
    })),
  };
  return JSON.stringify(project, null, 2);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function coloredManifestJson(
  document: ReturnType<typeof createColoredOutlineDocument>,
  files: ReadonlyArray<readonly [string, Uint8Array]>,
): Promise<string> {
  const members = await Promise.all(files.map(async ([path, bytes]) => ({
    path,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
  })));
  return JSON.stringify({
    schemaVersion: 1,
    projectPath: 'project.json',
    decisions: {
      sourceHash: document.sourceHash,
      materialId: document.assembly.material.id,
      kerfMm: document.assembly.material.kerfMm,
      launcherTemplateVersion: document.assembly.launcher.templateVersion,
      launcherTemplateFingerprint: document.assembly.launcher.templateFingerprint,
      launcherRotationRad: document.assembly.launcher.rotationRad,
      launcherFitOffsetMm: document.assembly.launcher.fitOffsetMm,
      launcherFinishedAllowanceMm: document.assembly.launcher.finishedAllowanceMm,
      launcherExteriorExpansionMode: document.assembly.launcher.exteriorExpansion.mode,
      launcherExteriorExpansionMm: document.assembly.launcher.exteriorExpansion.offsetMm,
      launcherExteriorExpansionMaxMm: document.assembly.launcher.exteriorExpansion.maxOffsetMm,
      launcherExteriorExpansionLayerIds:
        document.assembly.launcher.exteriorExpansion.affectedLayerIds,
      topFeatures: document.assembly.topFeatures,
    },
    members,
  }, null, 2);
}

export async function createOutlinePackage(
  result: AutomaticOutlineResult,
  deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs,
  options: PackageDeadlineInput = {},
): Promise<ColoredOutlinePackage> {
  const checkpoint = packageCheckpoint(deadline, options), documentOptions = coloredDeadlineOptions(options);
  checkpoint('colored-package:create:start');
  const document = createColoredOutlineDocument(result, deadline, documentOptions);
  checkpoint('colored-package:document:after');
  checkpoint('colored-package:svg:before');
  const cutSvg = writeColoredOutlineSvg(document, checkpoint);
  checkpoint('colored-package:svg:after');
  checkpoint('colored-package:dxf:before');
  const cutDxf = writeColoredOutlineDxf(document, checkpoint);
  checkpoint('colored-package:dxf:after');
  checkpoint('colored-package:preview-pdf:before');
  const previewPdf = await writeColoredPreviewPdf(document, checkpoint);
  checkpoint('colored-package:preview-pdf:after');
  checkpoint('colored-package:exploded-pdf:before');
  const explodedViewPdf = await writeExplodedViewPdf(document, checkpoint);
  checkpoint('colored-package:exploded-pdf:after');
  checkpoint('colored-package:launcher-coupon:before');
  const launcherCouponCheckpoint = (label: string): void => checkpoint(
    `colored-package:launcher-coupon:${label}`,
  );
  const launcherCoupon = createLauncherFitCoupon(
    result.assembly.material,
    deadline,
    launcherCouponCheckpoint,
  );
  const launcherCouponSvg = writeLauncherFitCouponSvg(
    launcherCoupon,
    deadline,
    launcherCouponCheckpoint,
  );
  checkpoint('colored-package:launcher-coupon:after');
  const encoder = new TextEncoder();
  const projectJson = coloredProjectJson(document);
  const manifestJson = await coloredManifestJson(document, [
    ['cut-and-engrave.svg', encoder.encode(cutSvg)],
    ['cut-and-engrave.dxf', encoder.encode(cutDxf)],
    ['preview.pdf', previewPdf],
    ['exploded-view.pdf', explodedViewPdf],
    ['launcher-fit-coupon.svg', encoder.encode(launcherCouponSvg)],
    ['project.json', encoder.encode(projectJson)],
  ]);
  checkpoint('colored-package:zip:before');
  const zip = await writeColoredOutlineZip({
    cutSvg, cutDxf, previewPdf, explodedViewPdf, launcherCouponSvg, projectJson, manifestJson,
  }, checkpoint);
  checkpoint('colored-package:zip:after');
  const output: ColoredOutlinePackage = {
    cutSvg, cutDxf, previewPdf, explodedViewPdf, launcherCouponSvg, projectJson, manifestJson, zip,
  };
  await verifyOutlinePackage(output, result, deadline, options);
  checkpoint('colored-package:create:return');
  return output;
}

export async function verifyOutlinePackage(
  output: ColoredOutlinePackage,
  result: AutomaticOutlineResult,
  deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs,
  options: PackageDeadlineInput = {},
): Promise<void> {
  const checkpoint = packageCheckpoint(deadline, options), documentOptions = coloredDeadlineOptions(options);
  checkpoint('colored-package:verify:start');
  assertExactColoredOutputKeys(output);
  const document = createColoredOutlineDocument(result, deadline, documentOptions);
  validateColoredOutlineDocument(document, result, deadline, documentOptions);
  checkpoint('colored-package:verify-document:after');
  const encoder = new TextEncoder();
  const expectedProjectJson = coloredProjectJson(document);

  const expectedSvg = writeColoredOutlineSvg(document, checkpoint);
  const expectedDxf = writeColoredOutlineDxf(document, checkpoint);
  if (output.cutSvg !== expectedSvg || output.cutDxf !== expectedDxf) {
    throw new RangeError('Colored SVG or DXF canonical geometry, role, color, fingerprint, or entity-count mismatch');
  }
  const expectedEntities = coloredOutlineEntityRecords(document, checkpoint);
  if (exactJson(parseColoredOutlineSvg(output.cutSvg, checkpoint)) !== exactJson(expectedEntities)
    || exactJson(parseColoredOutlineDxf(output.cutDxf, checkpoint)) !== exactJson(expectedEntities)) {
    throw new RangeError('Colored SVG or DXF parsed entities do not match the canonical entity order and counts');
  }
  assertColoredPublicText(output.cutSvg, 'Colored SVG');
  assertColoredPublicText(output.cutDxf, 'Colored DXF');
  const launcherCouponCheckpoint = (label: string): void => checkpoint(
    `colored-package:verify-launcher-coupon:${label}`,
  );
  const expectedLauncherCoupon = createLauncherFitCoupon(
    result.assembly.material,
    deadline,
    launcherCouponCheckpoint,
  );
  verifyLauncherFitCouponSvg(
    output.launcherCouponSvg,
    expectedLauncherCoupon,
    deadline,
    launcherCouponCheckpoint,
  );
  assertColoredPublicText(
    output.launcherCouponSvg.replace(/\sdata-material-id="[^"]*"/, ''),
    'Launcher fit coupon SVG',
  );

  const expectedPreview = await writeColoredPreviewPdf(document, checkpoint);
  checkpoint('colored-package:verify-preview-regenerate:after');
  const expectedExploded = await writeExplodedViewPdf(document, checkpoint);
  checkpoint('colored-package:verify-exploded-regenerate:after');
  if (!bytesEqual(output.previewPdf, expectedPreview, checkpoint, 'colored-package:verify-preview')
    || !bytesEqual(output.explodedViewPdf, expectedExploded, checkpoint, 'colored-package:verify-exploded')) {
    throw new RangeError('Colored PDF content, color, label, dimension, axis, or fingerprint mismatch');
  }
  const expectedManifestJson = await coloredManifestJson(document, [
    ['cut-and-engrave.svg', encoder.encode(output.cutSvg)],
    ['cut-and-engrave.dxf', encoder.encode(output.cutDxf)],
    ['preview.pdf', output.previewPdf],
    ['exploded-view.pdf', output.explodedViewPdf],
    ['launcher-fit-coupon.svg', encoder.encode(output.launcherCouponSvg)],
    ['project.json', encoder.encode(expectedProjectJson)],
  ]);
  if (output.projectJson !== expectedProjectJson || output.manifestJson !== expectedManifestJson) {
    throw new RangeError('Colored project or manifest metadata does not reconcile with canonical decisions and member hashes');
  }
  checkpoint('colored-package:verify-preview-load:before');
  const preview = await PDFDocument.load(output.previewPdf, { updateMetadata: false });
  checkpoint('colored-package:verify-preview-load:after');
  checkpoint('colored-package:verify-exploded-load:before');
  const exploded = await PDFDocument.load(output.explodedViewPdf, { updateMetadata: false });
  checkpoint('colored-package:verify-exploded-load:after');
  for (const [label, pdf] of [['preview', preview], ['exploded', exploded]] as const) {
    const metadata = [
      pdf.getTitle(), pdf.getSubject(), pdf.getAuthor(), pdf.getCreator(), pdf.getProducer(), pdf.getKeywords(),
    ].filter((value): value is string => typeof value === 'string').join('\n');
    assertColoredPublicText(metadata, `Colored ${label} PDF metadata`);
    if (pdf.getCreationDate()?.toISOString() !== '2000-01-01T00:00:00.000Z'
      || pdf.getModificationDate()?.toISOString() !== '2000-01-01T00:00:00.000Z') {
      throw new RangeError(`Colored ${label} PDF dates are not deterministic`);
    }
  }

  const expectedNames = [...COLORED_ZIP_NAMES];
  const rawRecords = parseRawColoredZip(output.zip, checkpoint);
  const rawNames = rawRecords.map(({ name }) => name);
  if (rawRecords.length !== 7 || exactJson(rawNames) !== exactJson(expectedNames)) {
    throw new RangeError('Colored ZIP central directory records must use the exact writer order');
  }
  for (const name of rawNames) {
    if (name !== 'project.json' && name !== 'manifest.json') {
      assertColoredPublicText(name, 'Colored ZIP raw record name');
    }
  }

  checkpoint('colored-package:verify-zip-load:before');
  const zip = await JSZip.loadAsync(output.zip);
  checkpoint('colored-package:verify-zip-load:after');
  const entries = Object.entries(zip.files).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length !== 7 || entries.some(([, entry]) => entry.dir)
    || exactJson(entries.map(([name]) => name)) !== exactJson([...expectedNames].sort((left, right) => left.localeCompare(right)))) {
    throw new RangeError('Colored ZIP must contain exactly seven non-directory records');
  }
  for (const [name, entry] of entries) {
    checkpoint(`colored-package:verify-zip-entry:${name}:metadata`);
    const originalName = entry.unsafeOriginalName ?? name;
    if (originalName !== name) throw new RangeError('Colored ZIP original record name was sanitized');
    if (name !== 'project.json' && name !== 'manifest.json') {
      assertColoredPublicText(name, 'Colored ZIP record name');
      assertColoredPublicText(originalName, 'Colored ZIP original record name');
    }
  }
  checkpoint('colored-package:verify-zip-svg:before-read');
  const zippedSvgBytes = await zip.file('cut-and-engrave.svg')!.async('uint8array');
  checkpoint('colored-package:verify-zip-svg:after-read');
  checkpoint('colored-package:verify-zip-dxf:before-read');
  const zippedDxfBytes = await zip.file('cut-and-engrave.dxf')!.async('uint8array');
  checkpoint('colored-package:verify-zip-dxf:after-read');
  checkpoint('colored-package:verify-zip-preview:before-read');
  const zippedPreview = await zip.file('preview.pdf')!.async('uint8array');
  checkpoint('colored-package:verify-zip-preview:after-read');
  checkpoint('colored-package:verify-zip-exploded:before-read');
  const zippedExploded = await zip.file('exploded-view.pdf')!.async('uint8array');
  checkpoint('colored-package:verify-zip-exploded:after-read');
  checkpoint('colored-package:verify-zip-launcher-coupon:before-read');
  const zippedLauncherCouponBytes = await zip.file('launcher-fit-coupon.svg')!.async('uint8array');
  checkpoint('colored-package:verify-zip-launcher-coupon:after-read');
  const zippedProjectBytes = await zip.file('project.json')!.async('uint8array');
  const zippedManifestBytes = await zip.file('manifest.json')!.async('uint8array');
  const payloads = new Map<string, Uint8Array>([
    ['cut-and-engrave.svg', zippedSvgBytes], ['cut-and-engrave.dxf', zippedDxfBytes],
    ['preview.pdf', zippedPreview], ['exploded-view.pdf', zippedExploded],
    ['launcher-fit-coupon.svg', zippedLauncherCouponBytes],
    ['project.json', zippedProjectBytes], ['manifest.json', zippedManifestBytes],
  ]);
  for (const record of rawRecords) {
    const payload = payloads.get(record.name)!;
    if (payload.length !== record.uncompressedSize
      || payloadCrc32(payload, checkpoint, `colored-package:verify-zip-${record.name === 'cut-and-engrave.svg' ? 'svg' : record.name === 'cut-and-engrave.dxf' ? 'dxf' : record.name === 'preview.pdf' ? 'preview' : record.name === 'exploded-view.pdf' ? 'exploded' : 'launcher-coupon'}-crc`) !== record.crc32) {
      throw new RangeError('Colored ZIP payload size or CRC32 does not match its raw headers');
    }
  }
  let zippedSvg: string, zippedDxf: string, zippedLauncherCoupon: string,
    zippedProject: string, zippedManifest: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    zippedSvg = decoder.decode(zippedSvgBytes);
    zippedDxf = decoder.decode(zippedDxfBytes);
    zippedLauncherCoupon = decoder.decode(zippedLauncherCouponBytes);
    zippedProject = decoder.decode(zippedProjectBytes);
    zippedManifest = decoder.decode(zippedManifestBytes);
  } catch {
    throw new RangeError('Colored ZIP text payload is not canonical UTF-8');
  }
  assertColoredPublicText(zippedSvg, 'Colored ZIP SVG payload');
  assertColoredPublicText(zippedDxf, 'Colored ZIP DXF payload');
  verifyLauncherFitCouponSvg(
    zippedLauncherCoupon,
    expectedLauncherCoupon,
    deadline,
    launcherCouponCheckpoint,
  );
  assertColoredPublicText(
    zippedLauncherCoupon.replace(/\sdata-material-id="[^"]*"/, ''),
    'Colored ZIP launcher fit coupon payload',
  );
  if (!bytesEqual(zippedSvgBytes, new TextEncoder().encode(output.cutSvg), checkpoint, 'colored-package:verify-zipped-svg')
    || !bytesEqual(zippedDxfBytes, new TextEncoder().encode(output.cutDxf), checkpoint, 'colored-package:verify-zipped-dxf')
    || !bytesEqual(zippedPreview, output.previewPdf, checkpoint, 'colored-package:verify-zipped-preview')
    || !bytesEqual(zippedExploded, output.explodedViewPdf, checkpoint, 'colored-package:verify-zipped-exploded')
    || !bytesEqual(
      zippedLauncherCouponBytes,
      new TextEncoder().encode(output.launcherCouponSvg),
      checkpoint,
      'colored-package:verify-zipped-launcher-coupon',
    )
    || zippedProject !== output.projectJson
    || zippedManifest !== output.manifestJson) {
    throw new RangeError('Colored ZIP payloads are not byte-identical to the canonical outputs');
  }
  checkpoint('colored-package:verify:return');
}
