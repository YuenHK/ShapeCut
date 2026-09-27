import { decodePDFRawStream, PDFArray, PDFDocument, PDFPage, PDFRawStream, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import { createColoredOutlineDocument } from './colored-outline-document';
import { coloredResult } from './colored-outline-test-fixture';
import { writeColoredPreviewPdf, writeExplodedViewPdf } from './exploded-pdf';
import { writeColoredOutlineSvg } from './package';
import * as packageExport from './package';
import { BoxGeometry } from 'three';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import { convertAutomatically } from '../domain/pipeline/automatic-outline-pipeline';
import { GEOMETRY_ESTIMATE_MATERIALS } from '../domain/materials/geometry-estimates';

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
  it('fits engraved sidebar labels without shrinking and includes the engraving legend swatch', async () => {
    const base = createColoredOutlineDocument(coloredResult());
    const document = { ...base, engraving: {
      settings: {name:'A',workName:''},fontId:'test',fontSha256:'test',emMm:3 as const,clearanceMm:1 as const,parts:[],
    }, layers: base.layers.map(layer => ({...layer,id:'layer-'+'a'.repeat(72),roles:{...layer.roles,
      CUT_BLACK:layer.roles.CUT_BLACK.map((contour,index)=>index ? contour : {...contour,boundsMm:{...contour.boundsMm,maxX:15.527344519674074,maxY:16.67188670033627}}),
    }})) };
    const drawText=vi.spyOn(PDFPage.prototype,'drawText');
    try {
      const pdf=await PDFDocument.load(await writeExplodedViewPdf(document));
      const visible=visiblePdfContent(pdf);
      expect(visible).toContain('ENGRAVE_TEXT #008080');
      expect(visible).toContain('X 45.53 Y 46.67');
      expect(visible).not.toContain('527344519674074');
      const labelCalls=drawText.mock.calls.filter(([,options])=>options?.x===184*MM_TO_POINTS && options.y! < 180*MM_TO_POINTS);
      expect(labelCalls.length).toBeGreaterThan(document.layers.length);
      for (const [text,options] of labelCalls) {
        expect(options!.size).toBe(7);
        expect(options!.font!.widthOfTextAtSize(text,7)).toBeLessThanOrEqual(103*MM_TO_POINTS);
      }
    } finally { drawText.mockRestore(); }
  });
  it.each([3, 6])('exports three named layers using %i mm material thickness', async (thickness) => {
    const box = new BoxGeometry(60, 60, 30);
    const bytes = writeBinarySTL({
      positions: new Float64Array(box.getAttribute('position').array),
      indices: new Uint32Array(box.index!.array),
    }, 'safe');
    box.dispose();
    const material = GEOMETRY_ESTIMATE_MATERIALS.find((profile) => profile.id === `acrylic-${thickness}`)!;
    const result = await convertAutomatically({ bytes, material, launcherFitOffsetMm: 0 });
    expect(result.layers).toHaveLength(3);
    const document = createColoredOutlineDocument(result);
    const pdf = await PDFDocument.load(await writeExplodedViewPdf(document));
    expect(pdf.getKeywords()).toContain(`assembled-thickness-mm:${3 * thickness}`);
    const text = visiblePdfContent(pdf);
    expect(text).toContain(`Assembled thickness: ${3 * thickness} mm`);
    for (const name of ['Bottom', 'Middle', 'Top']) expect(text).toContain(name);
    expect(text.match(new RegExp(`thickness ${thickness} X`, 'g'))).toHaveLength(3);
    const preview = await PDFDocument.load(await writeColoredPreviewPdf(document));
    const previewText = visiblePdfContent(preview);
    for (const name of ['Bottom', 'Middle', 'Top']) expect(previewText).toContain(name);
  }, 30_000);

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
  }, 15_000);

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
    expect(content).toContain('Assembled thickness: 18 mm');
    expect(content).toContain('Red and blue are relative processing levels, not literal machine settings.');
    expect(content).toContain('Assign machine-specific settings after material test cuts.');
    expect(content).toContain('3 mm fastener holes omitted because no all-layer pattern was safe.');
  });
});
