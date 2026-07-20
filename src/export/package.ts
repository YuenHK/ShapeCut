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

export type ManufacturingPackage = {
  readonly sheets: readonly { readonly svg: string; readonly dxf: string }[];
  readonly assemblyPdf: Uint8Array;
  readonly projectJson: string;
  readonly zip: Uint8Array;
};

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

export function writeOutlineSvg(sheet: ManufacturingSheet, metadata: OutlineDocumentMetadata): string {
  const layers = new Map(metadata.layers.map((layer) => [layer.id, layer]));
  return writeSheetSvg(sheet)
    .replace('<svg ', `<svg data-outline-source-hash="${metadata.sourceHash}" data-outline-mode="${metadata.mode}" data-outline-status="${metadata.status}" data-repair-accepted="${metadata.repairAccepted}" data-removed-component-count="${metadata.removedComponentCount}" data-removal-evidence-fingerprint="${metadata.removalEvidenceFingerprint}" data-axis-source="${metadata.axisSource}" data-material-independent="true" `)
    .replace(/<polygon id="([^"]+)"/g, (match, id: string) => {
      const layer = layers.get(id);
      if (!layer) throw new RangeError(`SVG entity ${id} is missing outline metadata`);
      return `${match} data-outline-order="${layer.order}" data-outline-index="${layer.index}" data-z-start="${layer.zStart}" data-z-end="${layer.zEnd}" data-bounds-mm="${layer.boundsMm[0]}x${layer.boundsMm[1]}" data-removed-component-count="${layer.removedComponentCount}"`;
    });
}

export function writeOutlineDxf(sheet: ManufacturingSheet, metadata: OutlineDocumentMetadata): string {
  const comments = [
    `999\nOUTLINE_SOURCE_HASH:${metadata.sourceHash}\n`,
    `999\nOUTLINE_MODE:${metadata.mode}\n`,
    `999\nOUTLINE_STATUS:${metadata.status}\n`,
    `999\nREPAIR_ACCEPTED:${metadata.repairAccepted}\n`,
    `999\nREMOVED_COMPONENT_COUNT:${metadata.removedComponentCount}\n`,
    `999\nREMOVAL_EVIDENCE_FINGERPRINT:${metadata.removalEvidenceFingerprint}\n`,
    `999\nAXIS_SOURCE:${metadata.axisSource}\n`,
    '999\nMATERIAL_INDEPENDENT:true\n',
    ...metadata.layers.map((layer) => `999\nOUTLINE_LAYER:${layer.id}:${layer.order}:${layer.index}:${layer.zStart}:${layer.zEnd}:${layer.pointCount}:${layer.boundsMm[0]}x${layer.boundsMm[1]}:${layer.removedComponentCount}\n`),
  ].join('');
  return writeSheetDxf(sheet).replace('0\nEOF\n', `${comments}0\nEOF\n`);
}

export async function writeOutlinePreviewPdf(
  metadata: OutlineDocumentMetadata,
  sheets: readonly ManufacturingSheet[],
): Promise<Uint8Array> {
  const pointsPerMm = 72 / 25.4;
  const pdf = await PDFDocument.create({ updateMetadata: false });
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
    `axis-source:${metadata.axisSource}`,
    'material-independent:true',
    ...metadata.layers.map((layer) => `outline-layer:${layer.id}:${layer.order}:${layer.index}:${layer.pointCount}:${layer.boundsMm[0]}x${layer.boundsMm[1]}:${layer.zStart}:${layer.zEnd}:${layer.removedComponentCount}`),
  ]);
  for (const sheet of sheets) {
    const page = pdf.addPage([sheet.width * pointsPerMm, sheet.height * pointsPerMm]);
    for (const entity of sheet.entities) {
      for (let index = 0; index < entity.polygon.points.length; index += 1) {
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
  return pdf.save({ useObjectStreams: false });
}

export async function writeOutlineZip(files: {
  readonly cutSvg: string;
  readonly cutDxf: string;
  readonly previewPdf: Uint8Array;
  readonly projectJson: string;
  readonly manifestJson: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('cut.svg', files.cutSvg);
  zip.file('cut.dxf', files.cutDxf);
  zip.file('preview.pdf', files.previewPdf);
  zip.file('project.json', files.projectJson);
  zip.file('manifest.json', files.manifestJson);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export function flattenOutlineSheets(document: ManufacturingDocument): ManufacturingSheet {
  const gap = 5;
  const width = Math.max(...document.sheets.map((sheet) => sheet.width));
  let yOffset = 0;
  const entities = document.sheets.flatMap((sheet) => {
    const translated = sheet.entities.map((entity) => ({
      ...entity,
      polygon: { points: entity.polygon.points.map(([x, y]) => [x, y + yOffset] as const) },
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
