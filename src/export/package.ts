import JSZip from 'jszip';
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
  const sheets = project.document.sheets.map((sheet) => ({ svg: writeSheetSvg(sheet), dxf: writeSheetDxf(sheet) }));
  const assemblyPdf = await writeAssemblyPdf(project);
  const projectJson = writeProjectJson(project);
  const materialPdf = await writeTextPdf('Material recipe', Object.entries(project.settings).map(([key, value]) => `${key}: ${String(value)}`));
  const preflightPdf = await writeTextPdf('Preflight report', ['Geometry and material checks passed before package generation.']);
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
