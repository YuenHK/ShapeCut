import JSZip from 'jszip';
import { classifyMaterialReadiness } from '../domain/materials/schema';
import { writeSheetDxf } from './dxf';
import { validateProject, type ManufacturingProject } from './layers';
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
