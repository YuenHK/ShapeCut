import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createColoredOutlineDocument } from './colored-outline-document';
import { coloredResult } from './colored-outline-test-fixture';
import { writeColoredPreviewPdf, writeExplodedViewPdf } from './exploded-pdf';

describe('deterministic colored PDFs', () => {
  it('renders a byte-identical flat preview with exact role colors, labels, scale, and disclaimer', async () => {
    const document = createColoredOutlineDocument(coloredResult());
    const first = await writeColoredPreviewPdf(document);
    const second = await writeColoredPreviewPdf(document);
    const pdf = await PDFDocument.load(first, { updateMetadata: false });

    expect(first).toEqual(second);
    expect(pdf.getCreationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(pdf.getModificationDate()?.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(pdf.getKeywords()).toContain('roles:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3E63DD');
    expect(pdf.getKeywords()).toContain('scale:1:1');
    expect(pdf.getKeywords()).toContain('disclaimer:verify-fit-before-fabrication');
    expect(pdf.getKeywords()).toContain('layer:3:layer-3');
  });

  it('renders one deterministic exploded assembly with axis and complete dimensions', async () => {
    const document = createColoredOutlineDocument(coloredResult());
    const first = await writeExplodedViewPdf(document);
    const second = await writeExplodedViewPdf(document);
    const pdf = await PDFDocument.load(first, { updateMetadata: false });
    const keywords = pdf.getKeywords() ?? '';

    expect(first).toEqual(second);
    expect(pdf.getPageCount()).toBe(1);
    expect(keywords).toContain('view:isometric-exploded');
    expect(keywords).toContain('axis:central');
    expect(keywords).toContain('legend:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3E63DD');
    expect(keywords).toContain('layer:3:layer-3:order=3:thickness=2:X=20:Y=20:hole-diameter=4.514');
    expect(keywords).toContain('layer:1:layer-1:order=1:thickness=2:X=20:Y=20:hole-diameter=—');
  });
});
