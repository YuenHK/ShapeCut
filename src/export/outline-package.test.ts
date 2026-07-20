import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { OutlineLayer } from '../domain/outline-2.5d/extract';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import {
  createOutlineDocument,
  createOutlinePackage,
  verifyOutlinePackage,
} from './outline-package';

const SOURCE_HASH = '0123456789abcdef'.repeat(2);

function layer(
  id: string,
  index: number,
  zStart: number,
  zEnd: number,
  outer: OutlineLayer['contour']['outer'],
): OutlineLayer {
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  const sourceAreaMm2 = Math.abs(outer.reduce((sum, point, pointIndex) => {
    const next = outer[(pointIndex + 1) % outer.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2);
  return {
    id,
    index,
    zStart,
    zEnd,
    contour: { outer, holes: [] },
    sourceAreaMm2,
    simplifiedAreaMm2: sourceAreaMm2,
    sourceBoundsMm: {
      minX: Math.min(...xs), minY: Math.min(...ys),
      maxX: Math.max(...xs), maxY: Math.max(...ys),
    },
  };
}

function result(overrides: Partial<AutomaticOutlineResult> = {}): AutomaticOutlineResult {
  return {
    sourceHash: SOURCE_HASH,
    mode: 'outline-2.5d',
    status: 'warning',
    axis: {
      axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0, confirmed: true },
      source: 'shortest-bounds',
    },
    layers: [
      layer('curved-top', 8, 4, 6, [[0, 0], [0, 20], [12, 24], [24, 20], [24, 0]]),
      layer('small-rectangle', 2, 0, 2, [[-5, -3], [-5, 7], [13, 7], [13, -3]]),
      layer('wide-rectangle', 5, 2, 4, [[2, 1], [2, 13], [32, 13], [32, 1]]),
    ],
    warnings: ['已簡化模型'],
    originalReport: {
      inspection: {
        triangleCount: 1, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0,
        degenerateTriangleCount: 0, invertedVolume: false,
      },
      duplicateTriangleCount: 0,
      inconsistentWindingEdgeCount: 0,
      selfIntersectionCount: 0,
      selfIntersectionAnalysisComplete: true,
      boundaryEdges: [], nonManifoldEdges: [], degenerateTriangles: [],
      duplicateTriangles: [], inconsistentWindingEdges: [], selfIntersections: [],
      markersTruncated: {
        boundaryEdges: false, nonManifoldEdges: false, degenerateTriangles: false,
        duplicateTriangles: false, inconsistentWindingEdges: false, selfIntersections: false,
      },
    },
    repairAccepted: false,
    ...overrides,
  };
}

function polygonRecords(svg: string) {
  return [...svg.matchAll(/<polygon id="([^"]+)"[^>]*points="([^"]+)"\/>/g)].map((match) => {
    const points = match[2].split(' ').map((point) => point.split(',').map(Number));
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    return { id: match[1], pointCount: points.length, boundsMm: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
  });
}

describe('material-independent outline package', () => {
  it('lays out one CUT part per layer in increasing Z order with tight deterministic bounds', () => {
    const document = createOutlineDocument(result());

    expect(document.provenance.inputFingerprint).toBe(SOURCE_HASH);
    expect(document.manifest).toEqual([
      { partId: 'small-rectangle', quantity: 1, assemblyOrder: 1 },
      { partId: 'wide-rectangle', quantity: 1, assemblyOrder: 2 },
      { partId: 'curved-top', quantity: 1, assemblyOrder: 3 },
    ]);
    expect(document.sheets).toHaveLength(1);
    expect(document.sheets[0].width).toBe(300);
    expect(document.sheets[0].height).toBe(34);
    expect(document.sheets[0].entities.every(({ layer, contour }) => layer === 'CUT' && contour === 'outline')).toBe(true);
    expect(document.sheets[0].entities.map(({ id }) => id)).toEqual(['small-rectangle', 'wide-rectangle', 'curved-top']);
    expect(createOutlineDocument(result())).toEqual(document);
  });

  it('reconciles fingerprint, identity, order, counts, and bounds across every format and ZIP entry', async () => {
    const output = await createOutlinePackage(result());
    await expect(verifyOutlinePackage(output)).resolves.toBeUndefined();

    const project = JSON.parse(output.projectJson);
    const manifest = JSON.parse(output.manifestJson);
    expect(manifest).toMatchObject({ schemaVersion: 1, sourceHash: SOURCE_HASH, materialIndependent: true });
    expect(project.sourceHash).toBe(SOURCE_HASH);
    expect(project.document.provenance.inputFingerprint).toBe(SOURCE_HASH);
    expect(project.document.outline.layers.map((item: { id: string; order: number; pointCount: number; boundsMm: number[] }) => ({
      id: item.id, order: item.order, pointCount: item.pointCount, boundsMm: item.boundsMm,
    }))).toEqual([
      { id: 'small-rectangle', order: 1, pointCount: 4, boundsMm: [18, 10] },
      { id: 'wide-rectangle', order: 2, pointCount: 4, boundsMm: [30, 12] },
      { id: 'curved-top', order: 3, pointCount: 5, boundsMm: [24, 24] },
    ]);
    expect(project.document.outline.layers.map((item: { sourceBoundsMm: unknown }) => item.sourceBoundsMm)).toEqual([
      { minX: -5, minY: -3, maxX: 13, maxY: 7 },
      { minX: 2, minY: 1, maxX: 32, maxY: 13 },
      { minX: 0, minY: 0, maxX: 24, maxY: 24 },
    ]);
    expect(polygonRecords(output.cutSvg)).toEqual([
      { id: 'small-rectangle', pointCount: 4, boundsMm: [18, 10] },
      { id: 'wide-rectangle', pointCount: 4, boundsMm: [30, 12] },
      { id: 'curved-top', pointCount: 5, boundsMm: [24, 24] },
    ]);
    expect(output.cutDxf).toContain(`OUTLINE_SOURCE_HASH:${SOURCE_HASH}`);
    for (const item of manifest.layers) {
      expect(output.cutSvg).toContain(`data-outline-order="${item.order}"`);
      expect(output.cutDxf).toContain(`OUTLINE_LAYER:${item.id}:${item.order}`);
    }
    const preview = await PDFDocument.load(output.previewPdf);
    expect(preview.getKeywords()).toContain(`outline-source:${SOURCE_HASH}`);
    expect(preview.getKeywords()).toContain('outline-layer:small-rectangle:1:4:18x10');

    const zip = await JSZip.loadAsync(output.zip);
    const paths = Object.keys(zip.files).filter((path) => !zip.files[path].dir).sort();
    expect(paths).toEqual(['cut.dxf', 'cut.svg', 'manifest.json', 'preview.pdf', 'project.json']);
    expect(await zip.file('cut.svg')!.async('string')).toBe(output.cutSvg);
    expect(await zip.file('cut.dxf')!.async('string')).toBe(output.cutDxf);
    expect(await zip.file('project.json')!.async('string')).toBe(output.projectJson);
    expect(await zip.file('manifest.json')!.async('string')).toBe(output.manifestJson);
    expect(await zip.file('preview.pdf')!.async('uint8array')).toEqual(output.previewPdf);
  });

  it('contains no manufacturing processes, settings, material claims, source files, paths, or emails', async () => {
    const output = await createOutlinePackage(result());
    const zip = await JSZip.loadAsync(output.zip);
    const publicText = [output.cutSvg, output.cutDxf, output.projectJson, output.manifestJson].join('\n');

    expect(publicText).not.toMatch(/slot|hole|engrave|power|speed|passes|material(?:Profile|Code|Name)|\/Users\/|[A-Z]:\\|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/i);
    expect(Object.keys(zip.files).some((path) => /\.stl$/i.test(path))).toBe(false);
    expect(JSON.parse(output.projectJson)).not.toHaveProperty('settings');
  });

  it('rejects oversize geometry and privacy-bearing provenance instead of rescaling or leaking it', async () => {
    const oversized = layer('oversized', 0, 0, 1, [[0, 0], [0, 20], [991, 20], [991, 0]]);
    expect(() => createOutlineDocument(result({ layers: [oversized] }))).toThrow(/990|rescal|size/i);
    await expect(createOutlinePackage(result({ warnings: ['contact person@example.com at /Users/private/model.stl'] })))
      .rejects.toThrow(/private|path|email|warning/i);
    await expect(createOutlinePackage(result({ warnings: ['input was /private-model.stl'] })))
      .rejects.toThrow(/private|path|email|warning/i);
  });

  it('rejects forged mode/status provenance at the runtime boundary', async () => {
    await expect(createOutlinePackage(result({ mode: 'production' as AutomaticOutlineResult['mode'] })))
      .rejects.toThrow(/mode|provenance|outline/i);
    await expect(createOutlinePackage(result({ status: 'approved' as AutomaticOutlineResult['status'] })))
      .rejects.toThrow(/status|provenance|outline/i);
  });

  it('starts another bounded sheet when the next shelf cannot keep 5 mm margins', async () => {
    const first = layer('full-sheet-a', 0, 0, 1, [[0, 0], [0, 990], [990, 990], [990, 0]]);
    const second = layer('full-sheet-b', 1, 1, 2, [[0, 0], [0, 990], [990, 990], [990, 0]]);
    const document = createOutlineDocument(result({ layers: [first, second] }));

    expect(document.sheets).toHaveLength(2);
    expect(document.sheets.map(({ width, height }) => [width, height])).toEqual([[1000, 1000], [1000, 1000]]);
    expect(document.sheets.map(({ entities }) => entities.map(({ id }) => id))).toEqual([['full-sheet-a'], ['full-sheet-b']]);
    await expect(createOutlinePackage(result({ layers: [first, second] }))).resolves.toMatchObject({
      manifest: { layers: [{ id: 'full-sheet-a' }, { id: 'full-sheet-b' }] },
    });
  });

  it('keeps valid fractional-millimetre bounds through layout translation', () => {
    const fractional = layer('fractional', 0, 0, 1, [[0.1, 0.1], [0.1, 0.3], [0.3, 0.3], [0.3, 0.1]]);

    expect(() => createOutlineDocument(result({ layers: [fractional] }))).not.toThrow();
  });

  it('rejects an exported contour mutation during package verification', async () => {
    const output = await createOutlinePackage(result());
    const mutated = {
      ...output,
      cutSvg: output.cutSvg.replace('5,5 5,15 23,15 23,5', '5,5 5,15 22,15 23,5'),
    };
    expect(mutated.cutSvg).not.toBe(output.cutSvg);

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/mismatch|reconcil|geometry|package/i);
  });

  it('rejects a provenance mutation instead of trusting a forged manifest fingerprint', async () => {
    const output = await createOutlinePackage(result());
    const mutated = {
      ...output,
      manifest: { ...output.manifest, sourceHash: 'f'.repeat(32) },
    };

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/manifest|provenance|reconcil|mismatch/i);
  });

  it('rejects extra private or process-bearing PDF metadata even when expected records remain', async () => {
    const output = await createOutlinePackage(result());
    const pdf = await PDFDocument.load(output.previewPdf);
    const expectedKeywords = (pdf.getKeywords() ?? '').split(/,\s*/);
    pdf.setKeywords([...expectedKeywords, 'power:100', 'owner@example.com', '/private-model.stl']);
    const previewPdf = await pdf.save();
    const zip = await JSZip.loadAsync(output.zip);
    zip.file('preview.pdf', previewPdf);
    const mutated = {
      ...output,
      previewPdf,
      zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    };

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/PDF|metadata|private|email|process|reconcil/i);
  });
});
