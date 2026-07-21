import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';
import { classifyMaterialReadiness } from '../domain/materials/schema';
import { writeSheetDxf } from './dxf';
import {
  validateProject,
  type ManufacturingDocument,
  type ManufacturingProject,
  type ManufacturingSheet,
  type OutlineDocumentMetadata,
} from './layers';
import { writeAssemblyPdf, writeTextPdf } from './pdf';
import { writeProjectJson } from './project-json';
import { writePartsMapSvg, writeSheetSvg } from './svg';
import {
  COLORED_ROLE_COLORS,
  type ColoredDocumentCheckpoint,
  type ColoredOutlineDocument,
  type ColoredOutlineRole,
} from './colored-outline-document';

export type ManufacturingPackage = {
  readonly sheets: readonly { readonly svg: string; readonly dxf: string }[];
  readonly assemblyPdf: Uint8Array;
  readonly projectJson: string;
  readonly zip: Uint8Array;
};

type ColoredExportEntity = {
  readonly physicalLayerId: string;
  readonly order: number;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly role: ColoredOutlineRole;
  readonly id: string;
  readonly points: readonly (readonly [number, number])[];
};

type ColoredExportLayout = {
  readonly width: number;
  readonly height: number;
  readonly entities: readonly ColoredExportEntity[];
};

export type ColoredOutlineEntityRecord = {
  readonly physicalLayerId: string;
  readonly order: number;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly role: ColoredOutlineRole;
  readonly id: string;
  readonly points: readonly (readonly number[])[];
};

const COLORED_ACI = Object.freeze({ CUT_BLACK: 7, DEEP_RED: 1, LIGHT_BLUE: 5 } as const);
const COLORED_TRUE_COLOR = Object.freeze({ CUT_BLACK: 0, DEEP_RED: 0xE5484D, LIGHT_BLUE: 0x3A78D4 } as const);
const COLORED_ROLES = Object.freeze(Object.keys(COLORED_ROLE_COLORS) as ColoredOutlineRole[]);

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function dxfComment(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}

function coloredLayout(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint,
): ColoredExportLayout {
  const margin = 5, gap = 5, maximumRowWidth = 1000;
  let cursorX = margin, cursorY = margin, rowHeight = 0, maximumX = margin, maximumY = margin;
  const entities: ColoredExportEntity[] = [];
  for (const layer of document.layers) {
    checkpoint('colored-layout:layer-loop');
    const exterior = layer.roles.CUT_BLACK[0], bounds = exterior.boundsMm;
    const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
    if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 990 || height > 990) {
      throw new RangeError('Colored outline part exceeds the 990 mm export limit');
    }
    if (cursorX + width > maximumRowWidth - margin && cursorX > margin) {
      cursorX = margin;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    for (const role of COLORED_ROLES) for (const contour of layer.roles[role]) {
      checkpoint('colored-layout:contour-loop');
      entities.push({
        physicalLayerId: layer.id,
        order: layer.order,
        index: layer.index,
        zStart: layer.zStart,
        zEnd: layer.zEnd,
        role,
        id: contour.id,
        points: contour.outer.map(([x, y], pointIndex) => {
          if ((pointIndex & 63) === 0) checkpoint('colored-layout:point-loop');
          return [x - bounds.minX + cursorX, y - bounds.minY + cursorY] as const;
        }),
      });
    }
    maximumX = Math.max(maximumX, cursorX + width);
    maximumY = Math.max(maximumY, cursorY + height);
    cursorX += width + gap;
    rowHeight = Math.max(rowHeight, height);
  }
  return { width: Math.ceil(maximumX + margin), height: Math.ceil(maximumY + margin), entities };
}

function coloredEntityCounts(layout: ColoredExportLayout): string {
  return COLORED_ROLES.map((role) => `${role}:${layout.entities.filter((entity) => entity.role === role).length}`).join(',');
}

function entityRecords(layout: ColoredExportLayout): ColoredOutlineEntityRecord[] {
  return layout.entities.map(({ physicalLayerId, order, index, zStart, zEnd, role, id, points }) => ({
    physicalLayerId, order, index, zStart, zEnd, role, id,
    points: points.map(([x, y]) => [x, y]),
  }));
}

export function coloredOutlineEntityRecords(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): ColoredOutlineEntityRecord[] {
  return entityRecords(coloredLayout(document, checkpoint));
}

export function writeColoredOutlineSvg(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): string {
  const layout = coloredLayout(document, checkpoint), counts = coloredEntityCounts(layout);
  const physicalGroups = document.layers.map((layer) => {
    checkpoint('svg:physical-layer-loop');
    const roleGroups = COLORED_ROLES.map((role) => {
      const contours = layout.entities.filter((entity) => entity.order === layer.order && entity.role === role);
      const polygons = contours.map((entity) => {
        checkpoint('svg:entity-loop');
        const points = entity.points.map(([x, y], index) => {
          if ((index & 63) === 0) checkpoint('svg:point-loop');
          return `${x},${y}`;
        }).join(' ');
        return `<polygon id="${xmlEscape(entity.id)}" data-physical-layer="${xmlEscape(entity.physicalLayerId)}" data-order="${entity.order}" data-index="${entity.index}" data-z-start="${entity.zStart}" data-z-end="${entity.zEnd}" data-role="${role}" points="${points}" fill="none" stroke="${COLORED_ROLE_COLORS[role]}"/>`;
      }).join('');
      return `<g id="${role}" data-role="${role}" data-color="${COLORED_ROLE_COLORS[role]}" data-entity-count="${contours.length}">${polygons}</g>`;
    }).join('');
    return `<g id="physical-layer-${layer.order}" data-layer-id="${xmlEscape(layer.id)}" data-order="${layer.order}" data-index="${layer.index}" data-z-start="${layer.zStart}" data-z-end="${layer.zEnd}">${roleGroups}</g>`;
  }).join('');
  checkpoint('svg:return');
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}mm" height="${layout.height}mm" viewBox="0 0 ${layout.width} ${layout.height}" data-outline-source-hash="${document.sourceHash}" data-feature-evidence-fingerprint="${document.featureEvidenceFingerprint}" data-diagnostics-fingerprint="${document.diagnosticsFingerprint}" data-entity-counts="${counts}">${physicalGroups}</svg>`;
}

export function parseColoredOutlineSvg(
  svg: string,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): ColoredOutlineEntityRecord[] {
  checkpoint('svg-parse:start');
  const rootCounts = svg.match(/\bdata-entity-counts="([^"]+)"/i)?.[1];
  if (!rootCounts) throw new RangeError('Colored SVG is missing exact entity counts');
  const records = [...svg.matchAll(/<polygon id="([^"]+)" data-physical-layer="([^"]+)" data-order="(\d+)" data-index="(\d+)" data-z-start="([^"]+)" data-z-end="([^"]+)" data-role="(CUT_BLACK|DEEP_RED|LIGHT_BLUE)" points="([^"]+)" fill="none" stroke="(#[0-9A-F]{6})"\/>/g)].map((match) => {
    checkpoint('svg-parse:entity-loop');
    const role = match[7] as ColoredOutlineRole;
    if (match[9] !== COLORED_ROLE_COLORS[role]) throw new RangeError('Colored SVG role color is inconsistent');
    const points = match[8].split(' ').map((pair, index) => {
      if ((index & 63) === 0) checkpoint('svg-parse:point-loop');
      const point = pair.split(',').map(Number);
      if (point.length !== 2 || !point.every(Number.isFinite)) throw new RangeError('Colored SVG point geometry is invalid');
      return point;
    });
    return {
      physicalLayerId: match[2], order: Number(match[3]), index: Number(match[4]),
      zStart: Number(match[5]), zEnd: Number(match[6]), role, id: match[1], points,
    };
  });
  const counts = COLORED_ROLES.map((role) => `${role}:${records.filter((record) => record.role === role).length}`).join(',');
  if (records.length === 0 || counts !== rootCounts) throw new RangeError('Colored SVG entity counts are inconsistent');
  checkpoint('svg-parse:return');
  return records;
}

export function writeColoredOutlineDxf(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): string {
  const layout = coloredLayout(document, checkpoint), counts = coloredEntityCounts(layout);
  const layerTable = COLORED_ROLES.map((role) => `0\nLAYER\n2\n${role}\n70\n0\n62\n${COLORED_ACI[role]}\n420\n${COLORED_TRUE_COLOR[role]}\n6\nCONTINUOUS\n`).join('');
  const entities = layout.entities.map((entity) => {
    checkpoint('dxf:entity-loop');
    const vertices = entity.points.map(([x, y], index) => {
      if ((index & 63) === 0) checkpoint('dxf:point-loop');
      return `10\n${x}\n20\n${y}\n`;
    }).join('');
    return `999\nENTITY_ID:${dxfComment(entity.id)}\n999\nPHYSICAL_LAYER:${dxfComment(entity.physicalLayerId)}:${entity.order}:${entity.index}:${entity.zStart}:${entity.zEnd}\n0\nLWPOLYLINE\n8\n${entity.role}\n62\n${COLORED_ACI[entity.role]}\n420\n${COLORED_TRUE_COLOR[entity.role]}\n90\n${entity.points.length}\n70\n1\n${vertices}`;
  }).join('');
  checkpoint('dxf:return');
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n9\n$EXTMIN\n10\n0\n20\n0\n30\n0\n9\n$EXTMAX\n10\n${layout.width}\n20\n${layout.height}\n30\n0\n999\nOUTLINE_SOURCE_HASH:${document.sourceHash}\n999\nFEATURE_EVIDENCE_FINGERPRINT:${document.featureEvidenceFingerprint}\n999\nDIAGNOSTICS_FINGERPRINT:${document.diagnosticsFingerprint}\n999\nENTITY_COUNTS:${counts}\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n3\n${layerTable}0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}

export function parseColoredOutlineDxf(
  dxf: string,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): ColoredOutlineEntityRecord[] {
  checkpoint('dxf-parse:start');
  const declaredCounts = dxf.match(/999\nENTITY_COUNTS:([^\n]+)\n/)?.[1];
  if (!declaredCounts) throw new RangeError('Colored DXF is missing exact entity counts');
  const records = [...dxf.matchAll(/999\nENTITY_ID:([^\n]+)\n999\nPHYSICAL_LAYER:([^:\n]+):(\d+):(\d+):([^:\n]+):([^\n]+)\n0\nLWPOLYLINE\n8\n(CUT_BLACK|DEEP_RED|LIGHT_BLUE)\n62\n(\d+)\n420\n(\d+)\n90\n(\d+)\n70\n1\n((?:10\n[^\n]+\n20\n[^\n]+\n)+)/g)].map((match) => {
    checkpoint('dxf-parse:entity-loop');
    const role = match[7] as ColoredOutlineRole;
    if (Number(match[8]) !== COLORED_ACI[role] || Number(match[9]) !== COLORED_TRUE_COLOR[role]) {
      throw new RangeError('Colored DXF ACI or true-color role is inconsistent');
    }
    const points = [...match[11].matchAll(/10\n([^\n]+)\n20\n([^\n]+)\n/g)].map((point, index) => {
      if ((index & 63) === 0) checkpoint('dxf-parse:point-loop');
      const value = [Number(point[1]), Number(point[2])];
      if (!value.every(Number.isFinite)) throw new RangeError('Colored DXF point geometry is invalid');
      return value;
    });
    if (points.length !== Number(match[10])) throw new RangeError('Colored DXF point count is inconsistent');
    return {
      physicalLayerId: match[2], order: Number(match[3]), index: Number(match[4]),
      zStart: Number(match[5]), zEnd: Number(match[6]), role, id: match[1], points,
    };
  });
  const counts = COLORED_ROLES.map((role) => `${role}:${records.filter((record) => record.role === role).length}`).join(',');
  if (records.length === 0 || counts !== declaredCounts) throw new RangeError('Colored DXF entity counts are inconsistent');
  checkpoint('dxf-parse:return');
  return records;
}

export async function writeColoredOutlineZip(files: {
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly explodedViewPdf: Uint8Array;
}, checkpoint: ColoredDocumentCheckpoint = () => undefined): Promise<Uint8Array> {
  const zip = new JSZip(), fixedDate = new Date('2000-01-01T00:00:00.000Z');
  zip.file('cut-and-engrave.svg', files.cutSvg, { date: fixedDate });
  zip.file('cut-and-engrave.dxf', files.cutDxf, { date: fixedDate });
  zip.file('preview.pdf', files.previewPdf, { date: fixedDate });
  zip.file('exploded-view.pdf', files.explodedViewPdf, { date: fixedDate });
  checkpoint('zip:generate:before');
  const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  checkpoint('zip:generate:after');
  return output;
}

export async function buildPackage(project: ManufacturingProject): Promise<ManufacturingPackage> {
  validateProject(project);
  const materialReadiness = classifyMaterialReadiness(project.preflight.materialProfile);
  if (!project.preflight.canExport
    || materialReadiness.status !== 'ready'
    || project.preflight.materialReadiness.status !== materialReadiness.status
    || project.preflight.physicalApproval !== 'approved'
    || project.preflight.issues.some(({ severity }) => severity === 'blocking')
    || project.preflight.issues.some(({ severity, code }) => severity === 'confirm' && !project.preflight.acceptedConfirmations.includes(code))) {
    throw new Error('Production package blocked: preflight, material identity, physical coupon, or signed operator approval is pending');
  }
  const sheets = project.document.sheets.map((sheet) => ({ svg: writeSheetSvg(sheet), dxf: writeSheetDxf(sheet) }));
  const assemblyPdf = await writeAssemblyPdf(project);
  const projectJson = writeProjectJson(project);
  const materialPdf = await writeTextPdf('Material recipe', Object.entries(project.settings).map(([key, value]) => `${key}: ${String(value)}`));
  const preflightLines = preflightReportLines(project);
  const blockingCount = project.preflight.issues.filter(({ severity }) => severity === 'blocking').length;
  const confirmCount = project.preflight.issues.filter(({ severity }) => severity === 'confirm').length;
  const preflightPdf = await writeTextPdf('Preflight report', preflightLines, [
    'production-approved',
    `material-readiness:${project.preflight.materialReadiness.status}`,
    `physical-approval:${project.preflight.physicalApproval}`,
    `blocking:${blockingCount}`,
    `confirm:${confirmCount}`,
  ]);
  const zip = new JSZip();
  sheets.forEach((sheet, index) => {
    const number = String(index + 1).padStart(2, '0');
    zip.file(`01-cut-files/material-sheet-${number}.svg`, sheet.svg);
    zip.file(`01-cut-files/material-sheet-${number}.dxf`, sheet.dxf);
  });
  zip.file('02-instructions/assembly-guide.pdf', assemblyPdf);
  zip.file('02-instructions/parts-map.svg', writePartsMapSvg(project.document));
  zip.file('03-settings/material-recipe.pdf', materialPdf);
  zip.file('03-settings/project-settings.json', projectJson);
  zip.file('preflight-report.pdf', preflightPdf);
  return { sheets, assemblyPdf, projectJson, zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) };
}

export function writeOutlineSvg(sheet: ManufacturingSheet, metadata: OutlineDocumentMetadata, checkpoint: (label: string) => void = () => undefined): string {
  const layers = new Map(metadata.layers.map((layer) => [layer.id, layer]));
  return writeSheetSvg(sheet, () => checkpoint('svg:polygon-loop'))
    .replace('<svg ', `<svg data-outline-source-hash="${metadata.sourceHash}" data-outline-mode="${metadata.mode}" data-outline-status="${metadata.status}" data-repair-accepted="${metadata.repairAccepted}" data-removed-component-count="${metadata.removedComponentCount}" data-removal-evidence-fingerprint="${metadata.removalEvidenceFingerprint}" data-diagnostics-fingerprint="${metadata.diagnosticsFingerprint}" data-axis-source="${metadata.axisSource}" data-material-independent="true" `)
    .replace(/<polygon id="([^"]+)"/g, (match, id: string) => {
      const layer = layers.get(id);
      if (!layer) throw new RangeError(`SVG entity ${id} is missing outline metadata`);
      return `${match} data-outline-order="${layer.order}" data-outline-index="${layer.index}" data-z-start="${layer.zStart}" data-z-end="${layer.zEnd}" data-bounds-mm="${layer.boundsMm[0]}x${layer.boundsMm[1]}" data-removed-component-count="${layer.removedComponentCount}"`;
    });
}

export function writeOutlineDxf(sheet: ManufacturingSheet, metadata: OutlineDocumentMetadata, checkpoint: (label: string) => void = () => undefined): string {
  const comments = [
    `999\nOUTLINE_SOURCE_HASH:${metadata.sourceHash}\n`,
    `999\nOUTLINE_MODE:${metadata.mode}\n`,
    `999\nOUTLINE_STATUS:${metadata.status}\n`,
    `999\nREPAIR_ACCEPTED:${metadata.repairAccepted}\n`,
    `999\nREMOVED_COMPONENT_COUNT:${metadata.removedComponentCount}\n`,
    `999\nREMOVAL_EVIDENCE_FINGERPRINT:${metadata.removalEvidenceFingerprint}\n`,
    `999\nDIAGNOSTICS_FINGERPRINT:${metadata.diagnosticsFingerprint}\n`,
    `999\nAXIS_SOURCE:${metadata.axisSource}\n`,
    '999\nMATERIAL_INDEPENDENT:true\n',
    ...metadata.layers.map((layer) => `999\nOUTLINE_LAYER:${layer.id}:${layer.order}:${layer.index}:${layer.zStart}:${layer.zEnd}:${layer.pointCount}:${layer.boundsMm[0]}x${layer.boundsMm[1]}:${layer.removedComponentCount}\n`),
  ].join('');
  return writeSheetDxf(sheet, () => checkpoint('dxf:polygon-loop')).replace('0\nEOF\n', `${comments}0\nEOF\n`);
}

export async function writeOutlinePreviewPdf(
  metadata: OutlineDocumentMetadata,
  sheets: readonly ManufacturingSheet[],
  checkpoint: (label: string) => void = () => undefined,
): Promise<Uint8Array> {
  const pointsPerMm = 72 / 25.4;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  checkpoint('pdf:create:after');
  const fixedDate = new Date('2000-01-01T00:00:00.000Z');
  pdf.setTitle('Universal outline preview');
  pdf.setSubject('Canonical CUT contour preview');
  pdf.setAuthor('spinner-laser-kit');
  pdf.setCreator('spinner-laser-kit');
  pdf.setProducer('spinner-laser-kit');
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  pdf.setKeywords([
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
  ]);
  for (const sheet of sheets) {
    checkpoint('pdf:sheet-loop');
    const page = pdf.addPage([sheet.width * pointsPerMm, sheet.height * pointsPerMm]);
    for (const entity of sheet.entities) {
      checkpoint('pdf:entity-loop');
      for (let index = 0; index < entity.polygon.points.length; index += 1) {
        if ((index & 127) === 0) checkpoint('pdf:point-loop');
        const start = entity.polygon.points[index];
        const end = entity.polygon.points[(index + 1) % entity.polygon.points.length];
        page.drawLine({
          start: { x: start[0] * pointsPerMm, y: (sheet.height - start[1]) * pointsPerMm },
          end: { x: end[0] * pointsPerMm, y: (sheet.height - end[1]) * pointsPerMm },
          thickness: 0.25,
          color: rgb(0, 0, 0),
        });
      }
    }
  }
  const output = await pdf.save({ useObjectStreams: false });
  checkpoint('pdf:save:after');
  return output;
}

export async function writeOutlineZip(files: {
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly projectJson: string;
  readonly manifestJson: string;
}, checkpoint: (label: string) => void = () => undefined): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('cut.svg', files.cutSvg);
  zip.file('cut.dxf', files.cutDxf);
  zip.file('preview.pdf', files.previewPdf);
  zip.file('project.json', files.projectJson);
  zip.file('manifest.json', files.manifestJson);
  const output = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  checkpoint('zip:generate:after');
  return output;
}

export function flattenOutlineSheets(document: ManufacturingDocument, checkpoint: (label: string) => void = () => undefined): ManufacturingSheet {
  const gap = 5;
  const width = Math.max(...document.sheets.map((sheet) => sheet.width));
  let yOffset = 0;
  const entities = document.sheets.flatMap((sheet) => {
    checkpoint('flatten:sheet-loop');
    const translated = sheet.entities.map((entity) => ({
      ...entity,
      polygon: { points: entity.polygon.points.map(([x, y], index) => {
        if ((index & 63) === 0) checkpoint('flatten:point-loop');
        return [x, y + yOffset] as const;
      }) },
    }));
    yOffset += sheet.height + gap;
    return translated;
  });
  return { width, height: yOffset - gap, entities };
}

export function preflightReportLines(project: ManufacturingProject): string[] {
  const blocking = project.preflight.issues.filter(({ severity }) => severity === 'blocking');
  const confirmations = project.preflight.issues.filter(({ severity }) => severity === 'confirm');
  const accepted = new Set(project.preflight.acceptedConfirmations);
  return [
    `Production status: ${project.preflight.canExport ? 'approved' : 'blocked'}`,
    `Artifact fingerprint: ${project.preflight.inputFingerprint}`,
    `Material readiness: ${project.preflight.materialReadiness.status}`,
    `Material profile: ${project.preflight.materialProfile.machine} / ${project.preflight.materialProfile.materialCode} / ${project.preflight.materialProfile.safetyEvidence.productId}`,
    `Physical coupon: ${project.preflight.materialProfile.physicalCouponVerified ? 'verified' : 'pending'} (${project.preflight.materialProfile.operatorApproval?.couponId ?? 'no coupon ID'})`,
    `Qualified operator approval: ${project.preflight.materialProfile.operatorApproval ? `signed by ${project.preflight.materialProfile.operatorApproval.operatorName} at ${project.preflight.materialProfile.operatorApproval.signedAt}` : 'pending'}`,
    `Physical coupon/operator approval: ${project.preflight.physicalApproval}`,
    `Blocking issues: ${blocking.length}`,
    ...blocking.map(({ code, message }) => `BLOCKING ${code}: ${message}`),
    `Confirmation issues: ${confirmations.length}`,
    ...confirmations.map(({ code, message }) => `${accepted.has(code) ? 'ACCEPTED' : 'PENDING'} CONFIRM ${code}: ${message}`),
    ...project.preflight.materialReadiness.reasons.map(({ code, message }) => `MATERIAL ${code}: ${message}`),
  ];
}
