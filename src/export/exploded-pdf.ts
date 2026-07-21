import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import {
  COLORED_ROLE_COLORS,
  type ColoredDocumentCheckpoint,
  type ColoredOutlineDocument,
  type ColoredOutlineRole,
} from './colored-outline-document';

const MM_TO_POINTS = 72 / 25.4;
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');
const ROLE_RGB = Object.freeze({
  CUT_BLACK: rgb(0, 0, 0),
  DEEP_RED: rgb(0xe5 / 255, 0x48 / 255, 0x4d / 255),
  LIGHT_BLUE: rgb(0x3e / 255, 0x63 / 255, 0xdd / 255),
});

function configure(pdf: PDFDocument, title: string, keywords: readonly string[]): void {
  pdf.setTitle(title);
  pdf.setSubject('Canonical colored outline');
  pdf.setAuthor('ShapeCut');
  pdf.setCreator('ShapeCut');
  pdf.setProducer('ShapeCut');
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  pdf.setKeywords([...keywords]);
}

function layerDimensionKeyword(layer: ColoredOutlineDocument['layers'][number]): string {
  const exterior = layer.roles.CUT_BLACK[0], exteriorBounds = exterior.boundsMm;
  const width = exteriorBounds.maxX - exteriorBounds.minX;
  const height = exteriorBounds.maxY - exteriorBounds.minY;
  const central = layer.roles.CUT_BLACK[1];
  const diameter = central
    ? Number((2 * Math.sqrt(central.areaMm2 / Math.PI)).toFixed(3))
    : '—';
  return `layer:${layer.order}:${layer.id}:order=${layer.order}:thickness=${layer.zEnd - layer.zStart}:X=${width}:Y=${height}:hole-diameter=${diameter}`;
}

function drawLoop(
  page: PDFPage,
  points: readonly (readonly [number, number])[],
  map: (point: readonly [number, number]) => readonly [number, number],
  role: ColoredOutlineRole,
  checkpoint: ColoredDocumentCheckpoint,
): void {
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkpoint('pdf:polygon-loop');
    const [x1, y1] = map(points[index]), [x2, y2] = map(points[(index + 1) % points.length]);
    page.drawLine({
      start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      thickness: role === 'CUT_BLACK' ? 0.8 : 1.2,
      color: ROLE_RGB[role],
    });
  }
}

async function createPdf(
  title: string,
  keywords: readonly string[],
  draw: (pdf: PDFDocument, font: PDFFont, checkpoint: ColoredDocumentCheckpoint) => void,
  checkpoint: ColoredDocumentCheckpoint,
): Promise<Uint8Array> {
  checkpoint('pdf:create:before');
  const pdf = await PDFDocument.create({ updateMetadata: false });
  checkpoint('pdf:create:after');
  configure(pdf, title, keywords);
  checkpoint('pdf:font:before');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  checkpoint('pdf:font:after');
  draw(pdf, font, checkpoint);
  // pdf-lib may lazily initialize its Info dictionary while drawing/embedding.
  // Reapply both dates immediately before serialization for byte determinism.
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  checkpoint('pdf:save:before');
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  checkpoint('pdf:save:after');
  return bytes;
}

export async function writeColoredPreviewPdf(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): Promise<Uint8Array> {
  const roleKeyword = 'roles:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3E63DD';
  return createPdf('ShapeCut colored preview', [
    `outline-source:${document.sourceHash}`,
    `feature-evidence:${document.featureEvidenceFingerprint}`,
    `diagnostics-evidence:${document.diagnosticsFingerprint}`,
    roleKeyword,
    'scale:1:1',
    'disclaimer:verify-fit-before-fabrication',
    ...document.layers.map((layer) => `layer:${layer.order}:${layer.id}`),
  ], (pdf, font, drawCheckpoint) => {
    const maximumWidth = Math.max(...document.layers.map((layer) => {
      const box = layer.roles.CUT_BLACK[0].boundsMm;
      return box.maxX - box.minX;
    }));
    const totalHeight = document.layers.reduce((sum, layer) => {
      const box = layer.roles.CUT_BLACK[0].boundsMm;
      return sum + box.maxY - box.minY + 12;
    }, 16);
    const page = pdf.addPage([(maximumWidth + 34) * MM_TO_POINTS, totalHeight * MM_TO_POINTS]);
    let cursorY = page.getHeight() - 12 * MM_TO_POINTS;
    for (const layer of document.layers) {
      drawCheckpoint('pdf:preview-layer-loop');
      const exterior = layer.roles.CUT_BLACK[0], box = exterior.boundsMm;
      const height = box.maxY - box.minY;
      const originX = 12 * MM_TO_POINTS, originY = cursorY - height * MM_TO_POINTS;
      page.drawText(`${layer.order}. ${layer.id}  1:1`, {
        x: originX, y: cursorY + 2 * MM_TO_POINTS, size: 8, font,
      });
      for (const role of Object.keys(COLORED_ROLE_COLORS) as ColoredOutlineRole[]) {
        for (const contour of layer.roles[role]) drawLoop(
          page,
          contour.outer,
          ([x, y]) => [originX + (x - box.minX) * MM_TO_POINTS, originY + (y - box.minY) * MM_TO_POINTS],
          role,
          drawCheckpoint,
        );
      }
      cursorY = originY - 12 * MM_TO_POINTS;
    }
    page.drawText('Verify fit and dimensions before fabrication.', { x: 12 * MM_TO_POINTS, y: 5 * MM_TO_POINTS, size: 7, font });
  }, checkpoint);
}

export async function writeExplodedViewPdf(
  document: ColoredOutlineDocument,
  checkpoint: ColoredDocumentCheckpoint = () => undefined,
): Promise<Uint8Array> {
  return createPdf('ShapeCut exploded view', [
    `outline-source:${document.sourceHash}`,
    `feature-evidence:${document.featureEvidenceFingerprint}`,
    `diagnostics-evidence:${document.diagnosticsFingerprint}`,
    'view:isometric-exploded',
    'axis:central',
    'legend:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3E63DD',
    ...document.layers.map(layerDimensionKeyword),
  ], (pdf, font, drawCheckpoint) => {
    const page = pdf.addPage([297 * MM_TO_POINTS, 210 * MM_TO_POINTS]);
    const centerX = 120 * MM_TO_POINTS, baseY = 36 * MM_TO_POINTS;
    const gapMm = document.layers.length <= 1 ? 0 : Math.min(20, 120 / (document.layers.length - 1));
    const maximumWidth = Math.max(...document.layers.map((layer) => {
      const box = layer.roles.CUT_BLACK[0].boundsMm;
      return box.maxX - box.minX;
    }));
    const maximumHeight = Math.max(...document.layers.map((layer) => {
      const box = layer.roles.CUT_BLACK[0].boundsMm;
      return box.maxY - box.minY;
    }));
    const drawingScale = Math.min(1, 95 / maximumWidth, 58 / maximumHeight);
    const topY = baseY + (document.layers.length - 1) * gapMm * MM_TO_POINTS + 40 * MM_TO_POINTS;
    page.drawLine({
      start: { x: centerX, y: baseY - 8 * MM_TO_POINTS },
      end: { x: centerX, y: topY },
      thickness: 0.6, color: rgb(0.35, 0.35, 0.35), dashArray: [3, 3],
    });
    page.drawText('Central axis', { x: centerX + 3 * MM_TO_POINTS, y: topY - 6, size: 8, font });
    for (const [layerIndex, layer] of document.layers.entries()) {
      drawCheckpoint('pdf:exploded-layer-loop');
      const exterior = layer.roles.CUT_BLACK[0], box = exterior.boundsMm;
      const offsetX = centerX - ((box.maxX - box.minX) / 2) * drawingScale * MM_TO_POINTS
        + layerIndex * Math.min(4, 22 / Math.max(1, document.layers.length - 1)) * MM_TO_POINTS;
      const offsetY = baseY + layerIndex * gapMm * MM_TO_POINTS;
      const project = ([x, y]: readonly [number, number]) => [
        offsetX + (x - box.minX) * drawingScale * MM_TO_POINTS
          + (y - box.minY) * 0.28 * drawingScale * MM_TO_POINTS,
        offsetY + (y - box.minY) * 0.5 * drawingScale * MM_TO_POINTS,
      ] as const;
      for (const role of Object.keys(COLORED_ROLE_COLORS) as ColoredOutlineRole[]) {
        for (const contour of layer.roles[role]) drawLoop(page, contour.outer, project, role, drawCheckpoint);
      }
      const dimensions = layerDimensionKeyword(layer).split(':').at(-1)!.replaceAll('=', ' ');
      page.drawText(`${layer.order}. ${layer.id}  ${dimensions.replace('hole-diameter', 'hole diameter')}`, {
        x: 184 * MM_TO_POINTS, y: offsetY + 4, size: 7, font,
      });
    }
    const legend = [
      ['CUT_BLACK', '#000000'], ['DEEP_RED', '#E5484D'], ['LIGHT_BLUE', '#3E63DD'],
    ] as const;
    for (const [index, [role, hex]] of legend.entries()) {
      page.drawLine({
        start: { x: 18 * MM_TO_POINTS, y: (192 - index * 7) * MM_TO_POINTS },
        end: { x: 28 * MM_TO_POINTS, y: (192 - index * 7) * MM_TO_POINTS },
        thickness: 1.2, color: ROLE_RGB[role],
      });
      page.drawText(`${role} ${hex}`, { x: 31 * MM_TO_POINTS, y: (192 - index * 7) * MM_TO_POINTS - 3, size: 7, font });
    }
  }, checkpoint);
}
