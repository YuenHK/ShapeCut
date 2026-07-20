import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { OutlineLayer } from '../domain/outline-2.5d/extract';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { convertAutomatically, removalEvidenceFingerprint } from '../domain/pipeline/automatic-outline-pipeline';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import { openTetrahedron, separatedClosedCylinders } from '../test/mesh-builders';
import type { TriangleMesh } from '../domain/mesh/types';
import {
  createOutlineDocument,
  createOutlinePackage,
  type OutlinePackage,
  verifyOutlinePackage,
} from './outline-package';
import {
  flattenOutlineSheets,
  writeOutlineDxf,
  writeOutlinePreviewPdf,
  writeOutlineSvg,
  writeOutlineZip,
} from './package';
import { writeOutlineProjectJson } from './project-json';

const SOURCE_HASH = '0123456789abcdef'.repeat(2);
const PROJECTED_WARNINGS = [
  '已簡化模型',
  '原始內部細節、孔洞及細小分離零件已被忽略',
  '不同材料厚度會改變堆疊後高度',
  '輸出不包含雷射功率或速度',
  '正式製作前應先試切少量零件',
  '未找到可信旋轉軸，已使用模型最短包圍盒軸',
] as const;

function layer(
  id: string,
  index: number,
  zStart: number,
  zEnd: number,
  outer: OutlineLayer['contour']['outer'],
  removedComponentCount = 0,
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
    removedComponentCount,
  };
}

function result(overrides: Partial<AutomaticOutlineResult> = {}): AutomaticOutlineResult {
  const value = {
    sourceHash: SOURCE_HASH,
    mode: 'outline-2.5d',
    status: 'warning',
    axis: {
      axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0, confirmed: true },
      source: 'shortest-bounds',
    },
    layers: [
      layer('small-rectangle', 2, 0, 2, [[-5, -3], [-5, 7], [13, 7], [13, -3]]),
      layer('wide-rectangle', 5, 2, 4, [[2, 1], [2, 13], [32, 13], [32, 1]]),
      layer('curved-top', 8, 4, 6, [[0, 0], [0, 20], [12, 24], [24, 20], [24, 0]]),
    ],
    warnings: PROJECTED_WARNINGS,
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
    removedComponentCount: 0,
    ...overrides,
  } as Omit<AutomaticOutlineResult, 'removalEvidenceFingerprint'>;
  return { ...value, removalEvidenceFingerprint: overrides.removalEvidenceFingerprint ?? removalEvidenceFingerprint(value) };
}

function separatedOpenComponents(): TriangleMesh {
  const first = openTetrahedron();
  const transformed = (xOffset: number, zOffset: number, zScale: number, xyScale: number) => Array.from(first.positions, (value, index) => {
    if (index % 3 === 0) return value * xyScale + xOffset;
    if (index % 3 === 1) return value * xyScale;
    return value * zScale + zOffset;
  });
  return {
    positions: new Float64Array([
      ...transformed(0, 0, 12, 30),
      ...transformed(40, 1, 2, 2),
      ...transformed(50, 8, 2, 2),
    ]),
    indices: new Uint32Array([...first.indices, ...Array.from(first.indices, (index) => index + 4), ...Array.from(first.indices, (index) => index + 8)]),
  };
}

async function synchronizedOutput(output: OutlinePackage, document: OutlinePackage['document']): Promise<OutlinePackage> {
  const metadata = document.outline!;
  const manifest = {
    schemaVersion: 1 as const,
    mode: metadata.mode,
    sourceHash: metadata.sourceHash,
    status: metadata.status,
    warnings: [...metadata.warnings],
    repairAccepted: metadata.repairAccepted,
    removedComponentCount: metadata.removedComponentCount,
    removalEvidenceFingerprint: metadata.removalEvidenceFingerprint,
    axisSource: metadata.axisSource,
    layers: metadata.layers.map(({ id, order, index, zStart, zEnd, boundsMm, removedComponentCount }) => ({ id, order, index, zStart, zEnd, boundsMm, removedComponentCount })),
    materialIndependent: true as const,
  };
  const exportSheet = flattenOutlineSheets(document);
  const cutSvg = writeOutlineSvg(exportSheet, metadata);
  const cutDxf = writeOutlineDxf(exportSheet, metadata);
  const previewPdf = await writeOutlinePreviewPdf(metadata, document.sheets);
  const projectJson = writeOutlineProjectJson(document);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const zip = await writeOutlineZip({ cutSvg, cutDxf, previewPdf, projectJson, manifestJson });
  return { ...output, document, manifest, cutSvg, cutDxf, previewPdf, projectJson, manifestJson, zip };
}

function polygonRecords(svg: string) {
  return [...svg.matchAll(/<polygon id="([^"]+)"[^>]*points="([^"]+)"\/>/g)].map((match) => {
    const points = match[2].split(' ').map((point) => point.split(',').map(Number));
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    return { id: match[1], pointCount: points.length, boundsMm: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] };
  });
}

async function pdfKeywords(bytes: Uint8Array): Promise<string[]> {
  return (PDFDocument.load(bytes).then((pdf) => pdf.getKeywords() ?? '')).then((keywords) => keywords.split(/\s+/));
}

describe('material-independent outline package', () => {
  it('reconciles exact-to-projected fallback evidence from disconnected closed slices', async () => {
    const runtime = await convertAutomatically({ bytes: writeBinarySTL(separatedClosedCylinders(), 'safe') });
    expect(runtime).toMatchObject({ mode: 'outline-2.5d', status: 'warning', repairAccepted: true });
    expect(runtime.warnings).toContain('精確切片失敗，已改用 2.5D 外形模式');
    expect(runtime.removedComponentCount).toBeGreaterThan(0);
    expect(runtime.removalEvidenceFingerprint).toBe(removalEvidenceFingerprint(runtime));

    const output = await createOutlinePackage(runtime);
    expect(output.manifest.removalEvidenceFingerprint).toBe(runtime.removalEvidenceFingerprint);
    expect(output.manifest.removedComponentCount).toBe(runtime.removedComponentCount);
    expect(output.manifest.layers.map((item) => item.removedComponentCount))
      .toEqual(runtime.layers.map((item) => item.removedComponentCount));
    await expect(verifyOutlinePackage(output)).resolves.toBeUndefined();
  });

  it('reconciles authentic runtime component-removal evidence and rejects every structured-clone forgery', async () => {
    const runtime = structuredClone(await convertAutomatically({
      bytes: writeBinarySTL(separatedOpenComponents(), 'safe'),
    }));
    expect(runtime.mode).toBe('outline-2.5d');
    expect(runtime.removedComponentCount).toBeGreaterThan(0);
    expect(new Set(runtime.layers.map((item) => item.removedComponentCount)).size).toBeGreaterThan(1);
    expect(runtime.layers.reduce((sum, item) => sum + item.removedComponentCount, 0)).toBe(runtime.removedComponentCount);

    const output = await createOutlinePackage(runtime);
    const project = JSON.parse(output.projectJson);
    expect(output.document.outline?.removedComponentCount).toBe(runtime.removedComponentCount);
    expect(output.document.outline?.layers.map((item) => item.removedComponentCount))
      .toEqual(runtime.layers.map((item) => item.removedComponentCount));
    expect(output.manifest.removedComponentCount).toBe(runtime.removedComponentCount);
    expect(output.manifest.layers.map((item) => item.removedComponentCount))
      .toEqual(runtime.layers.map((item) => item.removedComponentCount));
    expect(project.document.outline.removedComponentCount).toBe(runtime.removedComponentCount);
    const layerEvidence = runtime.layers.map((item, index) => ({
      id: item.id, order: index + 1, index: item.index, zStart: item.zStart, zEnd: item.zEnd,
      removedComponentCount: item.removedComponentCount,
    }));
    expect(project.document.outline.layers.map(({ id, order, index, zStart, zEnd, removedComponentCount }: typeof layerEvidence[number]) => ({ id, order, index, zStart, zEnd, removedComponentCount })))
      .toEqual(layerEvidence);
    for (const layer of layerEvidence) {
      expect(output.cutSvg).toMatch(new RegExp(`<polygon id="${layer.id}"[^>]*data-outline-order="${layer.order}"[^>]*data-outline-index="${layer.index}"[^>]*data-z-start="${layer.zStart}"[^>]*data-z-end="${layer.zEnd}"[^>]*data-removed-component-count="${layer.removedComponentCount}"`));
      expect(output.cutDxf).toMatch(new RegExp(`OUTLINE_LAYER:${layer.id}:${layer.order}:${layer.index}:${layer.zStart}:${layer.zEnd}:[^\\n]*:${layer.removedComponentCount}\\n`));
      await expect(pdfKeywords(output.previewPdf)).resolves.toContain(`outline-layer:${layer.id}:${layer.order}:${layer.index}:${runtime.layers[layer.order - 1].contour.outer.length}:${output.manifest.layers[layer.order - 1].boundsMm[0]}x${output.manifest.layers[layer.order - 1].boundsMm[1]}:${layer.zStart}:${layer.zEnd}:${layer.removedComponentCount}`);
    }
    expect(output.cutSvg).toContain(`data-removed-component-count="${runtime.removedComponentCount}"`);
    expect(output.cutDxf).toContain(`REMOVED_COMPONENT_COUNT:${runtime.removedComponentCount}`);
    const pdf = await PDFDocument.load(output.previewPdf);
    expect(pdf.getKeywords()).toContain(`removed-components:${runtime.removedComponentCount}`);
    const zip = await JSZip.loadAsync(output.zip);
    expect(Object.keys(zip.files).sort()).toEqual(['cut.dxf', 'cut.svg', 'manifest.json', 'preview.pdf', 'project.json']);
    expect(await zip.file('cut.svg')!.async('string')).toBe(output.cutSvg);
    expect(await zip.file('cut.dxf')!.async('string')).toBe(output.cutDxf);
    expect(await zip.file('manifest.json')!.async('string')).toBe(output.manifestJson);
    expect(await zip.file('project.json')!.async('string')).toBe(output.projectJson);
    expect(await zip.file('preview.pdf')!.async('uint8array')).toEqual(output.previewPdf);

    const forgedAggregate = structuredClone(runtime); Object.assign(forgedAggregate, { removedComponentCount: runtime.removedComponentCount + 1 });
    const forgedLayer = structuredClone(runtime); Object.assign(forgedLayer.layers[0], { removedComponentCount: forgedLayer.layers[0].removedComponentCount + 1 });
    const mismatch = structuredClone(runtime); Object.assign(mismatch.layers.at(-1)!, { removedComponentCount: mismatch.layers.at(-1)!.removedComponentCount + 2 });
    const sumPreservingSwap = structuredClone(runtime);
    const distinct = sumPreservingSwap.layers.findIndex((item) => item.removedComponentCount !== sumPreservingSwap.layers[0].removedComponentCount);
    const firstCount = sumPreservingSwap.layers[0].removedComponentCount;
    Object.assign(sumPreservingSwap.layers[0], { removedComponentCount: sumPreservingSwap.layers[distinct].removedComponentCount });
    Object.assign(sumPreservingSwap.layers[distinct], { removedComponentCount: firstCount });
    const identitySwap = structuredClone(runtime);
    const swappedLayers = [...identitySwap.layers];
    [swappedLayers[0], swappedLayers[distinct]] = [swappedLayers[distinct], swappedLayers[0]];
    Object.assign(identitySwap, { layers: swappedLayers });
    const forgedExact = structuredClone(runtime);
    Object.assign(forgedExact, { mode: 'exact', status: 'success', warnings: [], repairAccepted: true });
    Object.assign(forgedExact.axis, { source: 'candidate' }); Object.assign(forgedExact.axis.axis, { confidence: 1 });
    for (const forged of [forgedAggregate, forgedLayer, mismatch, sumPreservingSwap, identitySwap, forgedExact]) {
      await expect(createOutlinePackage(forged)).rejects.toThrow();
    }
  });
  it('rejects forged aggregate, per-layer mismatch, and exact removal evidence', async () => {
    await expect(createOutlinePackage(result({ removedComponentCount: 7 }))).rejects.toThrow(/removed-component/i);
    const projectedLayer = layer('removed', 0, 0, 1, [[0, 0], [0, 3], [3, 3], [3, 0]], 2);
    await expect(createOutlinePackage(result({ layers: [projectedLayer], removedComponentCount: 1 }))).rejects.toThrow(/removed-component/i);
    await expect(createOutlinePackage(result({
      mode: 'exact', status: 'success', warnings: [], repairAccepted: true,
      axis: { axis: { ...result().axis.axis, confidence: 1 }, source: 'candidate' },
      layers: [projectedLayer], removedComponentCount: 2,
    }))).rejects.toThrow(/removed-component/i);
  });
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
    expect(preview.getKeywords()).toContain('outline-layer:small-rectangle:1:2:4:18x10:0:2:0');

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

  it('enforces the pipeline safety relationships for exact and projected results', async () => {
    expect(() => createOutlineDocument(result({ status: 'success' }))).toThrow(/status|warning|2\.5D|provenance/i);
    expect(() => createOutlineDocument(result({ warnings: [] }))).toThrow(/warning|simplif|provenance/i);
    expect(() => createOutlineDocument(result({ repairAccepted: true }))).toThrow(/repair|fallback|warning|provenance/i);
    expect(() => createOutlineDocument(result({ mode: 'exact', status: 'success', warnings: [], repairAccepted: false })))
      .toThrow(/repair|exact|provenance/i);
    expect(() => createOutlineDocument(result({
      mode: 'exact',
      status: 'warning',
      warnings: ['forged warning'],
      repairAccepted: true,
      axis: { axis: { ...result().axis.axis, confidence: 1 }, source: 'candidate' },
    }))).toThrow(/status|warning|exact|provenance/i);
    expect(() => createOutlineDocument(result({
      mode: 'exact',
      status: 'success',
      warnings: [],
      repairAccepted: true,
      axis: { axis: { ...result().axis.axis, confidence: 1 }, source: 'candidate' },
    }))).not.toThrow();
  });

  it('rejects empty or internally mismatched axis provenance', () => {
    expect(() => createOutlineDocument(result({ axis: undefined as unknown as AutomaticOutlineResult['axis'] })))
      .toThrow(/axis|provenance/i);
    expect(() => createOutlineDocument(result({
      mode: 'exact', status: 'success', warnings: [], repairAccepted: true,
      axis: { axis: { ...result().axis.axis, confidence: 0 }, source: 'candidate' },
    }))).toThrow(/axis|confidence|provenance/i);
    expect(() => createOutlineDocument(result({
      axis: { axis: { ...result().axis.axis, confidence: 1, direction: [0, 0, 2] }, source: 'shortest-bounds' },
    }))).toThrow(/axis|confidence|direction|provenance/i);
  });

  it('rejects synchronized empty safety provenance in the canonical document and every output', async () => {
    const output = await createOutlinePackage(result());
    const document = structuredClone(output.document) as any;
    document.outline.warnings = [];
    const mutated = await synchronizedOutput(output, document);

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/warning|simplif|provenance/i);
  });

  it('rejects a synchronized forged canonical axis source', async () => {
    const exact = result({
      mode: 'exact', status: 'success', warnings: [], repairAccepted: true,
      axis: { axis: { ...result().axis.axis, confidence: 1 }, source: 'candidate' },
    });
    const output = await createOutlinePackage(exact);
    const document = structuredClone(output.document) as any;
    document.outline.axisSource = 'forged';
    const mutated = await synchronizedOutput(output, document);

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/axis|provenance/i);
  });

  it('rejects extra bounds tuple values even when every output is synchronized', async () => {
    const output = await createOutlinePackage(result());
    const document = structuredClone(output.document) as any;
    document.outline.layers[0].boundsMm = [18, 10, 999];
    const mutated = await synchronizedOutput(output, document);

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/bounds|tuple|provenance/i);
  });

  it('enforces the 24-layer pipeline budget at input and canonical document boundaries', async () => {
    const layers = Array.from({ length: 25 }, (_, index) => layer(
      `budget-${index}`, index, index, index + 1,
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    ));
    expect(() => createOutlineDocument(result({ layers }))).toThrow(/24|layer|budget|limit/i);

    const output = await createOutlinePackage(result({ layers: layers.slice(0, 24) }));
    const document = structuredClone(output.document) as any;
    document.outline.layers.push({
      id: 'budget-24', order: 25, zStart: 24, zEnd: 25, boundsMm: [1, 1],
      sourceBoundsMm: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, pointCount: 4, sheetIndex: 0,
    });
    document.manifest.push({ partId: 'budget-24', quantity: 1, assemblyOrder: 25 });
    document.sheets[0].entities.push({
      id: 'budget-24', partId: 'budget-24', instance: 0, contour: 'outline', layer: 'CUT',
      polygon: { points: [[149, 5], [149, 6], [150, 6], [150, 5]] },
    });
    const mutated = await synchronizedOutput(output, document);
    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/24|layer|budget|limit/i);
  });

  it('starts another bounded sheet when the next shelf cannot keep 5 mm margins', async () => {
    const first = layer('full-sheet-a', 0, 0, 1, [[0, 0], [0, 990], [990, 990], [990, 0]]);
    const second = layer('full-sheet-b', 1, 1, 2, [[0, 0], [0, 990], [990, 990], [990, 0]]);
    const document = createOutlineDocument(result({ layers: [first, second] }));

    expect(document.sheets).toHaveLength(2);
    expect(document.sheets.map(({ width, height }) => [width, height])).toEqual([[1000, 1000], [1000, 1000]]);
    expect(document.sheets.map(({ entities }) => entities.map(({ id }) => id))).toEqual([['full-sheet-a'], ['full-sheet-b']]);
    const output = await createOutlinePackage(result({ layers: [first, second] }));
    expect(output).toMatchObject({
      manifest: { layers: [{ id: 'full-sheet-a' }, { id: 'full-sheet-b' }] },
    });
    const pdf = await PDFDocument.load(output.previewPdf);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPages().every((page) => page.getWidth() <= 1000 * 72 / 25.4 && page.getHeight() <= 1000 * 72 / 25.4)).toBe(true);
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

  it('rejects an exact bow-tie mutation even when document, SVG, DXF, PDF, JSON, manifest, and ZIP agree', async () => {
    const output = await createOutlinePackage(result());
    const document = structuredClone(output.document) as any;
    document.sheets[0].entities[0].polygon.points = [[5, 5], [23, 15], [5, 15], [23, 5]];
    const mutated = await synchronizedOutput(output, document);

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/polygon|self-intersect|geometry|canonical/i);
  });

  it('validates canonical winding, duplicate points, 5 mm margins, source bounds, overlap, and deterministic placement', async () => {
    const output = await createOutlinePackage(result());
    const mutations: ((document: any) => void)[] = [
      (document) => { document.sheets[0].entities[0].polygon.points.reverse(); },
      (document) => { document.sheets[0].entities[0].polygon.points = [[5, 5], [5, 15], [5, 15], [23, 5]]; },
      (document) => { document.sheets[0].entities[0].polygon.points = document.sheets[0].entities[0].polygon.points.map(([x, y]: number[]) => [x - 1, y]); },
      (document) => { document.outline.layers[0].sourceBoundsMm.maxX += 5; },
      (document) => { document.sheets[0].entities[1].polygon.points = document.sheets[0].entities[1].polygon.points.map(([x, y]: number[]) => [x - 23, y]); },
      (document) => { document.sheets[0].width += 1; },
    ];
    for (const mutate of mutations) {
      const document = structuredClone(output.document) as any;
      mutate(document);
      const synchronized = await synchronizedOutput(output, document);
      await expect(verifyOutlinePackage(synchronized)).rejects.toThrow(/geometry|polygon|margin|bounds|overlap|placement|sheet|canonical/i);
    }
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

  it('rejects private or process text injected into a PDF page even when metadata and ZIP agree', async () => {
    const output = await createOutlinePackage(result());
    const pdf = await PDFDocument.load(output.previewPdf);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.getPages()[0].drawText('source=/Users/private/model.stl laserPower=100 cut_speed=20 passes:2', { x: 10, y: 10, font });
    const previewPdf = await pdf.save();
    const zip = await JSZip.loadAsync(output.zip);
    zip.file('preview.pdf', previewPdf);
    const mutated = { ...output, previewPdf, zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) };

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/PDF|content|private|process|reconcil/i);
  });

  it.each([
    'extra/',
    'owner@example.com/',
    '/Users/private+alias/model/',
    'laserpower=80/',
    'press-fit tolerance 0.2mm/',
    'production ready for acrylic/',
    'press%2Dfit tolerance/',
    'ready for production with acrylic/',
    'source.stl/',
  ])('rejects every extra ZIP record and scans directory names: %s', async (entryName) => {
    const output = await createOutlinePackage(result());
    const zip = await JSZip.loadAsync(output.zip);
    zip.file(entryName, '', { dir: true });
    const mutated = { ...output, zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) };

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/ZIP|entry|private|path|email|process|STL|source/i);
  });

  it.each([
    'press%2Dfit tolerance/',
    'ready for production with acrylic/',
    'source=%2/',
  ])('rejects encoded fabrication claims and malformed encoding while scanning ZIP names: %s', async (entryName) => {
    const output = await createOutlinePackage(result());
    const zip = await JSZip.loadAsync(output.zip);
    zip.file(entryName, '', { dir: true });
    const mutated = { ...output, zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) };

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/process|setting|percent|encoding/i);
  });

  it('rejects an unsafe original ZIP record name that JSZip sanitizes to an allowed key', async () => {
    const output = await createOutlinePackage(result());
    const zip = await JSZip.loadAsync(output.zip);
    zip.remove('cut.svg');
    zip.file('../cut.svg', output.cutSvg);
    delete zip.files['../'];
    const mutated = {
      ...output,
      zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    };
    const reparsed = await JSZip.loadAsync(mutated.zip);
    expect(Object.keys(reparsed.files).sort()).toEqual(['cut.dxf', 'cut.svg', 'manifest.json', 'preview.pdf', 'project.json']);
    expect(reparsed.file('cut.svg')!.unsafeOriginalName).toBe('../cut.svg');
    expect(await reparsed.file('cut.svg')!.async('string')).toBe(output.cutSvg);

    await expect(verifyOutlinePackage(mutated)).rejects.toThrow(/ZIP|entry|original|unsafe|travers|path/i);
  });

  it.each([
    'source=/Users/private/model.stl',
    'source=/Users/private+alias/model.stl',
    'source=/Users/private@alias/model.obj',
    'source=/Users/private%20alias/model.obj',
    'source="/Users/private alias/model.obj"',
    'source: /Users/alias!#$&()*+,;=@[]^_`{}~/model.obj',
    'source;/Users/private/model.obj',
    'source|/etc/passwd',
    'source->/var/tmp/model.obj',
    'source href="/Users/private/model.obj"',
    'source=href="/etc/passwd"',
    '<svg><use href="/etc/passwd" /></svg>',
    '<svg><use href="/Volumes/School/private/model.obj" /></svg>',
    '<svg><use href="/mnt/private/model.obj" /></svg>',
    '<svg><use href="/srv/private/model.obj" /></svg>',
    '<svg><use href="/Users%2Fprivate/model.obj" /></svg>',
    '<svg><use href="/assets/../../Users/private/model.obj" /></svg>',
    '<svg><use href="/assets/%2e%2e/%2e%2e/Users/private/model.obj" /></svg>',
    '<svg><use href="/assets%2F..%2FUsers%2Fprivate/model.obj" /></svg>',
    '<svg><use href="/assets/icon.svg?source=/Users/private/model.obj" /></svg>',
    '<svg><use href="/assets/icon.svg%3Fsource=%2FUsers%2Fprivate%2Fmodel.obj" /></svg>',
    'source=</Users/private/model.obj',
    '</Users/private/model.obj>',
    'source=</Users>',
    'source=</etc>',
    'source=</home>',
    'source: file:///Users/private/model.stl',
    String.raw`source=\\server\share\model.stl`,
    String.raw`source=C:\Users\private\model.stl`,
    String.raw`source->C:\Users\private\model.obj`,
    String.raw`source|D:\private alias\model.obj`,
    String.raw`source;\\server\share\model.obj`,
    String.raw`source@\\server-name\share name\model.obj`,
    String.raw`source;\\\\\server\share\model.obj`,
    String.raw`source;\\server\\\share\model.obj`,
    'source=//Users/private/model.obj',
    'source;//server/share/model.obj',
    'source;//server//share/model.obj',
    ...Array.from({ length: 11 }, (_, leadingIndex) => Array.from({ length: 12 }, (_, separatorIndex) => separatorIndex + 1).map((separatorCount) =>
      `source;${'\\'.repeat(leadingIndex + 2)}server${'\\'.repeat(separatorCount)}share\\model.obj`)).flat(),
    ...Array.from({ length: 11 }, (_, leadingIndex) => Array.from({ length: 12 }, (_, separatorIndex) => separatorIndex + 1).map((separatorCount) =>
      `source;${'/'.repeat(leadingIndex + 2)}server${'/'.repeat(separatorCount)}share/model.obj`)).flat(),
    'source=%2FUsers%2Fprivate%2Fmodel.obj',
    'source=%252FUsers%252Fprivate%252Fmodel.obj',
    'source=%252525252FUsers%252525252Fprivate',
    'source=%2',
    'contact=owner@example.com',
    'contact=owner%40example.com',
    'laserPower=80',
    'laserpower=80',
    'machinepower=80',
    'machine-power=80',
    'machine_power=80',
    'cut_speed=20',
    'cutspeed=20',
    'machinespeed=20',
    'machine.speed=20',
    'laserpasses=2',
    'machinepasses=2',
    'machine-pass-es=2',
    'passes:2',
    'press-fit tolerance 0.2mm',
    'pressfit tolerance 0.2mm',
    'press_fit tolerance 0.2mm',
    'press\u2010fit tolerance 0.2mm',
    'press%2Dfit tolerance 0.2mm',
    'press-to-fit tolerance 0.2mm',
    'production ready for acrylic',
    'production-ready for generic material',
    'PRODUCTION_READY plywood',
    'production\u2014ready for PMMA',
    'cardboard is production.ready',
    'acrylic is ready for production',
    'ready for production with acrylic',
  ])('rejects embedded privacy or process provenance: %s', async (warning) => {
    await expect(createOutlinePackage(result({ warnings: [...PROJECTED_WARNINGS, warning] })))
      .rejects.toThrow(/private|path|email|process|setting|warning/i);
  });

  it.each([
    'outline path uses fill="none" and stroke="#000"; source=outline.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0L1 1"/></g></svg>',
    '<svg><use href="#shape" /></svg>',
    '<svg><use href="/assets/icon.svg" /></svg>',
    '<svg><use href="/assets/icon%20one.svg" /></svg>',
    '<svg><image href="/assets/icon.svg"></image></svg>',
    '<svg><a><style></style><metadata></metadata><switch><animate></animate></switch></a></svg>',
    String.raw`<svg><style>.icon::before { content: "\\26"; }</style></svg>`,
    'background-image: url(https://example.com/icon.svg)',
    'source=https://example.com/Users/private/model.obj',
    'source=https://example.com/assets/icon%20one.svg',
    'Preview is ready; choose a material only after a physical test cut.',
    'Pressure-fit preview geometry was removed from this outline.',
  ])('allows ordinary SVG vocabulary without privacy/process false positives: %s', async (warning) => {
    await expect(createOutlinePackage(result({
      warnings: [...PROJECTED_WARNINGS, warning],
    }))).resolves.toBeDefined();
  });
});
