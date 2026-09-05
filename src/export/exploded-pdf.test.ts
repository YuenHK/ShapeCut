import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import { createColoredOutlineDocument } from './colored-outline-document';
import { coloredResult } from './colored-outline-test-fixture';
import { writeColoredPreviewPdf, writeExplodedViewPdf } from './exploded-pdf';
import { writeColoredOutlineSvg } from './package';
import * as packageExport from './package';

const MM_TO_POINTS = 72 / 25.4;

function allLayerHoleOmissionResult() {
  const result = coloredResult();
  const coloredLayers = result.coloredLayers.map((layer) => ({
    ...layer,
    centralHole: undefined,
    diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
  }));
  const omitted = {
    ...result,
    status: 'warning' as const,
    coloredLayers,
    centralHoleSourceEvidence: result.centralHoleSourceEvidence.map(() => ({
      status: 'omitted' as const,
    })),
    featureWarnings: [...result.featureWarnings, CENTRAL_HOLE_OMISSION_WARNING],
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...omitted, featureEvidenceFingerprint: featureEvidenceFingerprint(omitted) };
}

function compactAllLayerHoleOmissionResult() {
  return allLayerHoleOmissionResult();
}

function visiblePdfContent(pdf: PDFDocument): string {
  const contents = pdf.getPage(0).node.Contents();
  const values = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return values.map((value) => {
    const stream = pdf.context.lookup(value);
    if (!(stream instanceof PDFRawStream)) throw new Error('expected raw PDF content stream');
    const decoded = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
    return [...decoded.matchAll(/<([0-9A-F]+)> Tj/g)].map((match) => (
      new TextDecoder('latin1').decode(Uint8Array.from(match[1].match(/../g)!.map((pair) => Number.parseInt(pair, 16))))
    )).join('\n');
  }).join('\n');
}

function svgDimensions(svg: string): readonly [number, number] {
  const match = svg.match(/width="(\d+)mm" height="(\d+)mm"/);
  if (!match) throw new Error('expected canonical SVG dimensions');
  return [Number(match[1]), Number(match[2])];
}

describe('deterministic colored PDFs', () => {
  it('renders the all-layer central-hole omission as readable sanitized text in both PDFs', async () => {
    const document = createColoredOutlineDocument(allLayerHoleOmissionResult());
    const [preview, exploded] = await Promise.all([
      writeColoredPreviewPdf(document),
      writeExplodedViewPdf(document),
    ]);
    const contents = await Promise.all([preview, exploded].map(async (bytes) => (
      visiblePdfContent(await PDFDocument.load(bytes, { updateMetadata: false }))
    )));

    for (const content of contents) {
      expect(content.split(CENTRAL_HOLE_OMISSION_WARNING)).toHaveLength(2);
      expect(content).not.toMatch(/[\\/@\0]|[\w.+-]+@[\w.-]+/);
    }
  });

  it('uses one canonical central-then-fastener omission order in both PDFs', async () => {
    const document = createColoredOutlineDocument(allLayerHoleOmissionResult());
    const [preview, exploded] = await Promise.all([
      writeColoredPreviewPdf(document),
      writeExplodedViewPdf(document),
    ]);
    const contents = await Promise.all([preview, exploded].map(async (bytes) => (
      visiblePdfContent(await PDFDocument.load(bytes, { updateMetadata: false }))
    )));
    for (const content of contents) {
      const central = content.indexOf(CENTRAL_HOLE_OMISSION_WARNING);
      const fastener = content.indexOf('3 mm fastener holes omitted because no all-layer pattern was safe.');
      expect(central).toBeGreaterThanOrEqual(0);
      expect(fastener).toBeGreaterThan(central);
    }
  });

  it('reserves enough preview page width for the omission warning when the fabrication layout is compact', async () => {
    const document = createColoredOutlineDocument(compactAllLayerHoleOmissionResult());
    const createLayout = packageExport.createColoredExportLayout;
    const compactLayout = vi.spyOn(packageExport, 'createColoredExportLayout')
      .mockImplementation((...args) => ({ ...createLayout(...args), width: 1 }));
    try {
      const preview = await writeColoredPreviewPdf(document);
      const pdf = await PDFDocument.load(preview, { updateMetadata: false });
      const measuringPdf = await PDFDocument.create({ updateMetadata: false });
      const font = await measuringPdf.embedFont(StandardFonts.Helvetica);
      const minimumWidthMm = 10 + font.widthOfTextAtSize(CENTRAL_HOLE_OMISSION_WARNING, 7) / MM_TO_POINTS;

      expect(pdf.getPage(0).getWidth()).toBeGreaterThanOrEqual(minimumWidthMm * MM_TO_POINTS);
      expect(pdf.getPage(0).getWidth()).toBeGreaterThan(1 * MM_TO_POINTS);
    } finally {
      compactLayout.mockRestore();
    }
  });

  it('renders a byte-identical flat preview on the canonical fabrication sheet with visible relative-level guidance', async () => {
    const document = createColoredOutlineDocument(coloredResult());
    const first = await writeColoredPreviewPdf(document);
    const second = await writeColoredPreviewPdf(document);
    const pdf = await PDFDocument.load(first, { updateMetadata: false });
    const [width, height] = svgDimensions(writeColoredOutlineSvg(document));
    const content = visiblePdfContent(pdf);

    expect(first).toEqual(second);
    expect(pdf.getCreationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(pdf.getModificationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(pdf.getKeywords()).toContain('roles:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3A78D4');
    expect(pdf.getKeywords()).toContain('scale:1:1');
    expect(pdf.getKeywords()).toContain('disclaimer:verify-fit-before-fabrication');
    expect(pdf.getKeywords()).toContain('layer:3:layer-3');
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(width * MM_TO_POINTS);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo((height + 24) * MM_TO_POINTS);
    expect(content).toContain('Layer 3');
    expect(content).toContain('Scale 1:1');
    expect(content).toContain('BLACK CUT | RED DEEP | BLUE LIGHT');
    expect(content).toContain('Red and blue are relative processing levels, not literal machine settings.');
    expect(content).toContain('Assign machine-specific settings after material test cuts.');
    expect(content).toContain('3 mm fastener holes omitted because no all-layer pattern was safe.');
  });

  it('renders one deterministic exploded assembly with axis and complete dimensions', async () => {
    const document = createColoredOutlineDocument(coloredResult());
    const first = await writeExplodedViewPdf(document);
    const second = await writeExplodedViewPdf(document);
    const pdf = await PDFDocument.load(first, { updateMetadata: false });
    const keywords = pdf.getKeywords() ?? '';
    const content = visiblePdfContent(pdf);

    expect(first).toEqual(second);
    expect(pdf.getPageCount()).toBe(1);
    expect(keywords).toContain('view:isometric-exploded');
    expect(keywords).toContain('axis:central');
    expect(keywords).toContain('legend:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3A78D4');
    expect(keywords).toContain('layer:3:layer-3:order=3:thickness=3:X=60:Y=60:hole-diameter=4.514');
    expect(keywords).toContain('layer:1:layer-1:order=1:thickness=3:X=60:Y=60:hole-diameter=4.514');
    expect(keywords).toContain('assembled-thickness-mm:18');
    expect(content).toContain('thickness 3');
    expect(content).toContain('Red and blue are relative processing levels, not literal machine settings.');
    expect(content).toContain('Assign machine-specific settings after material test cuts.');
    expect(content).toContain('3 mm fastener holes omitted because no all-layer pattern was safe.');
  });
});
