import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ManufacturingProject } from './layers';

const MM_TO_POINTS = 72 / 25.4;

export async function writeAssemblyPdf(project: ManufacturingProject): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${project.name} assembly guide`);
  pdf.setKeywords(project.document.manifest.flatMap(({ partId, quantity, assemblyOrder }) => [
    `${partId}:${quantity}`,
    `assembly-order:${assemblyOrder}:${partId}`,
  ]));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([210 * MM_TO_POINTS, 297 * MM_TO_POINTS]);
  page.drawText(`${project.name} - Assembly guide`, { x: 30, y: page.getHeight() - 40, size: 16, font });
  for (const [index, item] of [...project.document.manifest].sort((a, b) => a.assemblyOrder - b.assemblyOrder).entries()) {
    page.drawText(`${item.assemblyOrder}. ${item.partId} x ${item.quantity}`, { x: 30, y: page.getHeight() - 75 - index * 18, size: 11, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return pdf.save();
}

export async function writeTextPdf(title: string, lines: readonly string[], keywords: readonly string[] = []): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  if (keywords.length > 0) pdf.setKeywords([...keywords]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([210 * MM_TO_POINTS, 297 * MM_TO_POINTS]);
  page.drawText(title, { x: 30, y: page.getHeight() - 40, size: 16, font });
  lines.forEach((line, index) => page.drawText(line.replace(/[^ -~]/g, '?'), { x: 30, y: page.getHeight() - 70 - index * 16, size: 10, font }));
  return pdf.save();
}
