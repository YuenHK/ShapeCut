import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import { createColoredOutlineDocument } from './colored-outline-document';
import { coloredResult } from './colored-outline-test-fixture';
import { writeColoredPreviewPdf, writeExplodedViewPdf } from './exploded-pdf';
import { writeColoredOutlineSvg } from './package';

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
    featureWarnings: [CENTRAL_HOLE_OMISSION_WARNING],
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...omitted, featureEvidenceFingerprint: featureEvidenceFingerprint(omitted) };
}

function compactAllLayerHoleOmissionResult() {
  const result = allLayerHoleOmissionResult();
  const coloredLayers = result.coloredLayers.map((layer, index) => {
    const centerX = index * 6;
    const outer = [
      [centerX - 2, -2], [centerX - 2, 2], [centerX + 2, 2], [centerX + 2, -2],
    ] as const;
    return {
      ...layer,
      exterior: {
        ...layer.exterior,
        outer,
        boundsMm: { minX: centerX - 2, minY: -2, maxX: centerX + 2, maxY: 2 },
        areaMm2: 16,
      },
      centralHole: undefined,
      deepFeature: undefined,
      lightFeature: undefined,
      diagnostics: {
        ...layer.diagnostics,
        hole: { status: 'omitted' as const },
        depth: { ...layer.diagnostics.depth, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
      },
    };
  });
  const layers = result.layers.map((layer, index) => ({
    ...layer,
    contour: { outer: coloredLayers[index].exterior.outer, holes: [] as const },
    sourceAreaMm2: 16,
    simplifiedAreaMm2: 16,
    sourceBoundsMm: { ...coloredLayers[index].exterior.boundsMm },
  }));
  const changed = {
    ...result,
    layers,
    coloredLayers,
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
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

  it('reserves enough preview page width for the omission warning on compact six-layer layouts', async () => {
    const document = createColoredOutlineDocument(compactAllLayerHoleOmissionResult());
    const preview = await writeColoredPreviewPdf(document);
    const pdf = await PDFDocument.load(preview, { updateMetadata: false });
    const measuringPdf = await PDFDocument.create({ updateMetadata: false });
    const font = await measuringPdf.embedFont(StandardFonts.Helvetica);
    const minimumWidthMm = 10 + font.widthOfTextAtSize(CENTRAL_HOLE_OMISSION_WARNING, 7) / MM_TO_POINTS;

    expect(pdf.getPage(0).getWidth()).toBeGreaterThanOrEqual(minimumWidthMm * MM_TO_POINTS);
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
    expect(keywords).toContain('layer:3:layer-3:order=3:thickness=2:X=20:Y=20:hole-diameter=4.514');
    expect(keywords).toContain('layer:1:layer-1:order=1:thickness=2:X=20:Y=20:hole-diameter=—');
    expect(content).toContain('Red and blue are relative processing levels, not literal machine settings.');
    expect(content).toContain('Assign machine-specific settings after material test cuts.');
  });
});
