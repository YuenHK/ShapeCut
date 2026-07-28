import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { OutlineLayer } from '../domain/outline-2.5d/extract';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { convertAutomatically as convertAutomaticOutline, removalEvidenceFingerprint } from '../domain/pipeline/automatic-outline-pipeline';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import { openTetrahedron } from '../test/mesh-builders';
import type { TriangleMesh } from '../domain/mesh/types';
import {
  createOutlineDocument,
  createLegacyOutlinePackage as createOutlinePackage,
  createOutlinePackage as createColoredOutlinePackage,
  type OutlinePackage,
  verifyLegacyOutlinePackage as verifyOutlinePackage,
  verifyOutlinePackage as verifyColoredOutlinePackage,
} from './outline-package';
import {
  flattenOutlineSheets,
  writeOutlineDxf,
  writeOutlinePreviewPdf,
  writeOutlineSvg,
  writeOutlineZip,
} from './package';
import { writeOutlineProjectJson } from './project-json';
import { coloredResult } from './colored-outline-test-fixture';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import { createColoredOutlineDocument } from './colored-outline-document';
import { expandLauncherExterior } from '../domain/outline-assembly/launcher-exterior-expansion';

const testMaterial = { id: 'test-material', name: 'Test material', thicknessMm: 3, kerfMm: 0.1, minFeatureMm: 0.8, minWebMm: 0.5, fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 } } as const;
function convertAutomatically(request: { readonly bytes: ArrayBuffer }, onProgress?: Parameters<typeof convertAutomaticOutline>[1]) {
  return convertAutomaticOutline({ ...request, material: testMaterial, launcherFitOffsetMm: 0 }, onProgress);
}

const SOURCE_HASH = '0123456789abcdef'.repeat(2);
const PROJECTED_WARNINGS = [
  '已簡化模型',
  '原始內部細節、孔洞及細小分離零件已被忽略',
  '不同材料厚度會改變堆疊後高度',
  '輸出不包含雷射功率或速度',
  '正式製作前應先試切少量零件',
  '未找到可信旋轉軸，已使用模型最短包圍盒軸',
] as const;

function coloredResultMissingCentralHoleOmissionWarning(): AutomaticOutlineResult {
  const result = coloredResult();
  const coloredLayers = result.coloredLayers.map((layer) => ({
    ...layer,
    centralHole: undefined,
    diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
  }));
  const missing = {
    ...result,
    status: 'warning' as const,
    coloredLayers,
    featureWarnings: [],
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...missing, featureEvidenceFingerprint: featureEvidenceFingerprint(missing) };
}

function coloredResultWithSharedHoleMutation(
  mutate: (layers: AutomaticOutlineResult['coloredLayers']) => AutomaticOutlineResult['coloredLayers'],
): AutomaticOutlineResult {
  const result = coloredResult();
  const coloredLayers = mutate(result.coloredLayers);
  const changed = {
    ...result,
    coloredLayers,
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...changed, featureEvidenceFingerprint: featureEvidenceFingerprint(changed) };
}

function coloredResultWithExteriorExpansion(offsetMm = 2.35): AutomaticOutlineResult {
  const result = coloredResult();
  const expandedLayerIds = result.assembly.launcher.exteriorExpansion.affectedLayerIds;
  const coloredLayers = result.coloredLayers.map((layer) => (
    expandedLayerIds.includes(layer.id)
      ? { ...layer, exterior: expandLauncherExterior(layer.exterior, offsetMm) }
      : layer
  ));
  const changed = {
    ...result,
    coloredLayers,
    assembly: {
      ...result.assembly,
      launcher: {
        ...result.assembly.launcher,
        exteriorExpansion: {
          ...result.assembly.launcher.exteriorExpansion,
          offsetMm,
        },
      },
    },
    preview: { ...result.preview, layers: coloredLayers },
  };
  return {
    ...changed,
    featureEvidenceFingerprint: featureEvidenceFingerprint(
      changed,
      undefined,
      undefined,
      result.assembly.material,
    ),
  };
}

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
    simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0,
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
  if (!overrides.diagnostics) Object.assign(value, { diagnostics: {
    topology: { triangleCount: 1, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true },
    repairDecision: value.repairAccepted ? 'accepted' : 'projected-original',
    rasterCellSizeMm: value.mode === 'exact' ? null : 0.05,
    layers: value.layers.map(({ id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio }) => ({ id, simplificationToleranceMm, boundsDriftRatio, areaDriftRatio, areaEvidenceBasis: value.mode === 'exact' ? 'exact-slice-pre-simplification' as const : 'retained-raster-pre-simplification' as const })),
  } });
  return { ...value, removalEvidenceFingerprint: overrides.removalEvidenceFingerprint ?? removalEvidenceFingerprint(value) };
}

function cylinder(
  radius = 30,
  centerX = 0,
  zStart = -1,
  zEnd = 1,
  segments = 32,
): TriangleMesh {
  const positions: number[] = [centerX, 0, zStart, centerX, 0, zEnd];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(centerX + radius * Math.cos(angle), radius * Math.sin(angle), zStart);
    positions.push(centerX + radius * Math.cos(angle), radius * Math.sin(angle), zEnd);
  }
  const indices: number[] = [];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottom = 2 + index * 2, top = bottom + 1;
    const nextBottom = 2 + next * 2, nextTop = nextBottom + 1;
    indices.push(0, bottom, nextBottom, 1, nextTop, top);
    indices.push(bottom, top, nextTop, bottom, nextTop, nextBottom);
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function mergeMeshes(meshes: readonly TriangleMesh[]): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    positions.push(...mesh.positions);
    indices.push(...Array.from(mesh.indices, (index) => index + vertexOffset));
    vertexOffset += mesh.positions.length / 3;
  }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function launcherCompatibleSeparatedClosedCylinders(): TriangleMesh {
  return mergeMeshes([
    cylinder(),
    cylinder(5, 40, -1, 1, 16),
    cylinder(5, -40, -1, 1, 16),
  ]);
}

function separatedOpenComponents(): TriangleMesh {
  const dominantClosed = cylinder(30, 0, 0, 12);
  const dominant: TriangleMesh = {
    positions: dominantClosed.positions,
    indices: dominantClosed.indices.slice(0, -3),
  };
  const small = openTetrahedron();
  const transformed = (xOffset: number, zOffset: number, zScale: number, xyScale: number): TriangleMesh => ({
    positions: new Float64Array(Array.from(small.positions, (value, index) => {
      if (index % 3 === 0) return value * xyScale + xOffset;
      if (index % 3 === 1) return value * xyScale;
      return value * zScale + zOffset;
    })),
    indices: small.indices,
  });
  return mergeMeshes([
    dominant,
    transformed(40, 1, 2, 2),
    transformed(-42, 8, 2, 2),
  ]);
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
    diagnostics: structuredClone(metadata.diagnostics),
    diagnosticsFingerprint: metadata.diagnosticsFingerprint,
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

function duplicateFirstCentralDirectoryRecord(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('Fixture ZIP has no EOCD');
  const centralOffset = view.getUint32(eocd + 16, true);
  if (view.getUint32(centralOffset, true) !== 0x02014b50) throw new Error('Fixture ZIP has no central record');
  const recordLength = 46
    + view.getUint16(centralOffset + 28, true)
    + view.getUint16(centralOffset + 30, true)
    + view.getUint16(centralOffset + 32, true);
  const forged = new Uint8Array(bytes.length + recordLength);
  forged.set(bytes.subarray(0, eocd), 0);
  forged.set(bytes.subarray(centralOffset, centralOffset + recordLength), eocd);
  forged.set(bytes.subarray(eocd), eocd + recordLength);
  const forgedView = new DataView(forged.buffer);
  const forgedEocd = eocd + recordLength;
  forgedView.setUint16(forgedEocd + 8, view.getUint16(eocd + 8, true) + 1, true);
  forgedView.setUint16(forgedEocd + 10, view.getUint16(eocd + 10, true) + 1, true);
  forgedView.setUint32(forgedEocd + 12, view.getUint32(eocd + 12, true) + recordLength, true);
  return forged;
}

type RawZipFixtureRecord = {
  readonly centralOffset: number;
  readonly localOffset: number;
  readonly nameLength: number;
};

function rawZipFixtureLayout(bytes: Uint8Array): {
  readonly eocdOffset: number;
  readonly centralOffset: number;
  readonly records: readonly RawZipFixtureRecord[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  if (view.getUint32(eocdOffset, true) !== 0x06054b50) throw new Error('Fixture ZIP has no canonical EOCD');
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const recordCount = view.getUint16(eocdOffset + 10, true);
  const records: RawZipFixtureRecord[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < recordCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Fixture ZIP has no central record');
    const nameLength = view.getUint16(cursor + 28, true);
    records.push({
      centralOffset: cursor,
      localOffset: view.getUint32(cursor + 42, true),
      nameLength,
    });
    cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return { eocdOffset, centralOffset, records };
}

function mutateRawZip(
  bytes: Uint8Array,
  mutate: (copy: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => void,
): Uint8Array {
  const copy = bytes.slice();
  mutate(copy, new DataView(copy.buffer, copy.byteOffset, copy.byteLength), rawZipFixtureLayout(copy));
  return copy;
}

function reorderCentralDirectoryRecords(bytes: Uint8Array, order: readonly number[]): Uint8Array {
  const layout = rawZipFixtureLayout(bytes);
  if (order.length !== layout.records.length || new Set(order).size !== layout.records.length
    || order.some((index) => index < 0 || index >= layout.records.length)) {
    throw new Error('Fixture central-directory order is invalid');
  }
  const reordered = bytes.slice();
  let destination = layout.centralOffset;
  for (const index of order) {
    const start = layout.records[index].centralOffset;
    const end = layout.records[index + 1]?.centralOffset ?? layout.eocdOffset;
    reordered.set(bytes.subarray(start, end), destination);
    destination += end - start;
  }
  return reordered;
}

const STRICT_RAW_ZIP_MUTATIONS = [
  ['central filename BOM', (bytes: Uint8Array, _view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    bytes.set([0xef, 0xbb, 0xbf], layout.records[0].centralOffset + 46);
  }],
  ['central filename NUL', (bytes: Uint8Array, _view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    bytes[layout.records[0].centralOffset + 46] = 0;
  }],
  ['central filename invalid UTF-8', (bytes: Uint8Array, _view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    bytes[layout.records[0].centralOffset + 46] = 0xff;
  }],
  ['central directory filename', (bytes: Uint8Array, _view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    const record = layout.records[0];
    bytes[record.centralOffset + 46 + record.nameLength - 1] = 0x2f;
  }],
  ['local encryption flag', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    const offset = layout.records[0].localOffset + 6;
    view.setUint16(offset, view.getUint16(offset, true) | 1, true);
  }],
  ['local zero sizes', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    view.setUint32(layout.records[0].localOffset + 18, 0, true);
    view.setUint32(layout.records[0].localOffset + 22, 0, true);
  }],
  ['CRC mismatch against payload', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    const record = layout.records[0], forged = (view.getUint32(record.centralOffset + 16, true) ^ 0xffffffff) >>> 0;
    view.setUint32(record.centralOffset + 16, forged, true);
    view.setUint32(record.localOffset + 14, forged, true);
  }],
  ['local filename mismatch', (bytes: Uint8Array, _view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    bytes[layout.records[0].localOffset + 30] ^= 1;
  }],
  ['overlapping local offset', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    view.setUint32(layout.records[1].centralOffset + 42, layout.records[0].localOffset, true);
  }],
  ['out-of-range local offset', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    view.setUint32(layout.records[0].centralOffset + 42, layout.centralOffset + 1, true);
  }],
  ['ZIP64 size marker', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    view.setUint32(layout.records[0].centralOffset + 20, 0xffffffff, true);
  }],
  ['data-descriptor flag without descriptor', (_bytes: Uint8Array, view: DataView, layout: ReturnType<typeof rawZipFixtureLayout>) => {
    const record = layout.records[0];
    view.setUint16(record.centralOffset + 8, view.getUint16(record.centralOffset + 8, true) | 8, true);
    view.setUint16(record.localOffset + 6, view.getUint16(record.localOffset + 6, true) | 8, true);
  }],
] as const;

describe('material-independent outline package', () => {
  it('packages a real material-bound pipeline result', async () => {
    const runtime = await convertAutomatically({ bytes: writeBinarySTL(cylinder(), 'safe') });

    await expect(createColoredOutlinePackage(runtime)).resolves.toMatchObject({
      cutSvg: expect.stringContaining('<svg'),
      cutDxf: expect.stringContaining('SECTION'),
    });
  });

  it('adds sanitized canonical project and manifest metadata to the release ZIP', async () => {
    const runtime = coloredResultWithExteriorExpansion();
    const output = await createColoredOutlinePackage(runtime);
    const zip = await JSZip.loadAsync(output.zip);

    expect(Object.keys(output).sort()).toEqual([
      'cutDxf', 'cutSvg', 'explodedViewPdf', 'launcherCouponSvg', 'manifestJson',
      'previewPdf', 'projectJson', 'zip',
    ]);
    expect(Object.keys(zip.files).sort()).toEqual([
      'cut-and-engrave.dxf', 'cut-and-engrave.svg', 'exploded-view.pdf',
      'launcher-fit-coupon.svg', 'manifest.json', 'preview.pdf', 'project.json',
    ]);
    expect(await zip.file('cut-and-engrave.svg')!.async('string')).toBe(output.cutSvg);
    expect(await zip.file('cut-and-engrave.dxf')!.async('string')).toBe(output.cutDxf);
    expect(await zip.file('preview.pdf')!.async('uint8array')).toEqual(output.previewPdf);
    expect(await zip.file('exploded-view.pdf')!.async('uint8array')).toEqual(output.explodedViewPdf);
    expect(await zip.file('launcher-fit-coupon.svg')!.async('string')).toBe(output.launcherCouponSvg);
    expect(await zip.file('project.json')!.async('string')).toBe(output.projectJson);
    expect(await zip.file('manifest.json')!.async('string')).toBe(output.manifestJson);
    const project = JSON.parse(output.projectJson);
    const manifest = JSON.parse(output.manifestJson);
    expect(project).toMatchObject({
      schemaVersion: 2,
      sourceHash: runtime.sourceHash,
      assembly: {
        material: { id: runtime.assembly.material.id, kerfMm: runtime.assembly.material.kerfMm },
        launcher: {
          templateVersion: runtime.assembly.launcher.templateVersion,
          templateFingerprint: runtime.assembly.launcher.templateFingerprint,
          rotationRad: runtime.assembly.launcher.rotationRad,
          fitOffsetMm: runtime.assembly.launcher.fitOffsetMm,
          exteriorExpansion: {
            mode: 'shared-uniform',
            offsetMm: 2.35,
            maxOffsetMm: 6,
            affectedLayerIds: ['layer-5', 'layer-6'],
          },
        },
      },
    });
    expect(manifest.decisions).toMatchObject({
      launcherExteriorExpansionMode: 'shared-uniform',
      launcherExteriorExpansionMm: 2.35,
      launcherExteriorExpansionMaxMm: 6,
      launcherExteriorExpansionLayerIds: ['layer-5', 'layer-6'],
    });
    expect(manifest.members).toHaveLength(6);
    expect(manifest.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'project.json',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        byteLength: new TextEncoder().encode(output.projectJson).length,
      }),
    ]));
    expect(JSON.stringify({ project, manifest })).not.toMatch(/private|provisional|validationEvidence|\.stl|file:/i);
    await expect(verifyColoredOutlinePackage(output, runtime)).resolves.toBeUndefined();
  });

  it.each([
    ['mode', (manifest: any) => { manifest.decisions.launcherExteriorExpansionMode = 'independent'; }],
    ['offset', (manifest: any) => { manifest.decisions.launcherExteriorExpansionMm = 2.36; }],
    ['maximum', (manifest: any) => { manifest.decisions.launcherExteriorExpansionMaxMm = 7; }],
    ['affected layer order', (manifest: any) => {
      manifest.decisions.launcherExteriorExpansionLayerIds.reverse();
    }],
    ['missing decision member', (manifest: any) => {
      delete manifest.decisions.launcherExteriorExpansionLayerIds;
    }],
  ])('rejects a forged manifest exterior-expansion %s decision', async (_label, mutate) => {
    const runtime = coloredResultWithExteriorExpansion();
    const output = await createColoredOutlinePackage(runtime);
    const manifest = JSON.parse(output.manifestJson);
    mutate(manifest);

    await expect(verifyColoredOutlinePackage({
      ...output,
      manifestJson: JSON.stringify(manifest, null, 2),
    }, runtime)).rejects.toThrow(/project|manifest|metadata|reconcile|mismatch/i);
  });

  it('rejects a replaced expanded exterior path', async () => {
    const runtime = coloredResultWithExteriorExpansion();
    const output = await createColoredOutlinePackage(runtime);
    const mutatedSvg = output.cutSvg.replace(
      /(<polygon id="layer-6-exterior"[^>]*points=")([^"]+)/,
      (_match, prefix: string, points: string) => `${prefix}99,99 ${points}`,
    );
    expect(mutatedSvg).not.toBe(output.cutSvg);

    await expect(verifyColoredOutlinePackage({
      ...output,
      cutSvg: mutatedSvg,
    }, runtime)).rejects.toThrow(/SVG|geometry|canonical|mismatch/i);
  });

  it('carries expansion only as geometry and machine metadata, never as fabrication labels', async () => {
    const output = await createColoredOutlinePackage(coloredResultWithExteriorExpansion());
    const fabricationText = [
      output.cutSvg,
      output.cutDxf,
      new TextDecoder('latin1').decode(output.previewPdf),
      new TextDecoder('latin1').decode(output.explodedViewPdf),
    ].join('\n');

    expect(fabricationText).not.toMatch(
      /頂部兩層外框已共同擴大|launcherExteriorExpansion|shared-uniform|exterior expansion/i,
    );
  });

  it.each([
    ['path', (svg: string) => svg.replace(/points="([^"])/, 'points="9$1')],
    ['label', (svg: string) => svg.replace('-0.10 mm</text>', '-0.11 mm</text>')],
    ['fit offset', (svg: string) => svg.replace('data-fit-offset-mm="-0.1"', 'data-fit-offset-mm="-0.11"')],
    ['template fingerprint', (svg: string) => svg.replace(/data-template-fingerprint="[0-9a-f]+"/, `data-template-fingerprint="${'f'.repeat(32)}"`)],
    ['material ID', (svg: string) => svg.replace(/data-material-id="[^"]+"/, 'data-material-id="forged"')],
    ['kerf', (svg: string) => svg.replace(/data-kerf-mm="[^"]+"/, 'data-kerf-mm="0.99"')],
    ['trailing root-external token', (svg: string) => `${svg}<text>hidden</text>`],
  ])('rejects launcher coupon %s mutation', async (_label, mutate) => {
    const runtime = coloredResult();
    const output = await createColoredOutlinePackage(runtime);
    const launcherCouponSvg = mutate(output.launcherCouponSvg);

    await expect(verifyColoredOutlinePackage({ ...output, launcherCouponSvg }, runtime))
      .rejects.toThrow(/coupon|SVG|canonical|reconcil|mismatch/i);
  });

  it('rejects a ZIP-only launcher coupon mutation instead of accepting non-identical bytes', async () => {
    const runtime = coloredResult();
    const output = await createColoredOutlinePackage(runtime);
    const zip = await JSZip.loadAsync(output.zip);
    zip.file('launcher-fit-coupon.svg', output.launcherCouponSvg.replace('+0.10 mm', '+0.11 mm'));
    const mutated = {
      ...output,
      zip: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    };

    await expect(verifyColoredOutlinePackage(mutated, runtime))
      .rejects.toThrow(/coupon|ZIP|byte-identical|canonical/i);
  });

  it.each([
    ['project decision', 'projectJson', (value: string) => value.replace('"fitOffsetMm": 0', '"fitOffsetMm": 0.1')],
    ['manifest hash', 'manifestJson', (value: string) => value.replace(/[0-9a-f]{64}/, 'f'.repeat(64))],
  ] as const)('rejects a forged %s even when it remains valid JSON', async (_label, key, mutate) => {
    const runtime = coloredResult();
    const output = await createColoredOutlinePackage(runtime);

    await expect(verifyColoredOutlinePackage({ ...output, [key]: mutate(output[key]) }, runtime))
      .rejects.toThrow(/project|manifest|metadata|reconcile|hash/i);
  });

  it('rejects an all-layer central-hole omission without the canonical safety warning', async () => {
    await expect(createColoredOutlinePackage(coloredResultMissingCentralHoleOmissionWarning()))
      .rejects.toThrow(/central.*hole.*omission.*warning/i);
  });

  it('rejects mixed and shifted shared-hole evidence before packaging any artifact', async () => {
    const mixed = coloredResultWithSharedHoleMutation((layers) => layers.map((layer, index) => index === 0 ? {
      ...layer,
      centralHole: undefined,
      diagnostics: { ...layer.diagnostics, hole: { status: 'omitted' as const } },
    } : layer));
    await expect(createColoredOutlinePackage(mixed))
      .rejects.toThrow(/shared central hole.*(?:every layer|mixed|retain.*omit)/i);

    const shifted = coloredResultWithSharedHoleMutation((layers) => layers.map((layer, index) => {
      if (index !== 2 || !layer.centralHole) return layer;
      return {
        ...layer,
        centralHole: {
          ...layer.centralHole,
          outer: layer.centralHole.outer.map(([x, y]) => [x + 0.25, y] as const),
          boundsMm: {
            ...layer.centralHole.boundsMm,
            minX: layer.centralHole.boundsMm.minX + 0.25,
            maxX: layer.centralHole.boundsMm.maxX + 0.25,
          },
        },
      };
    }));
    await expect(createColoredOutlinePackage(shifted))
      .rejects.toThrow(/shared central holes.*identical.*model space/i);
  });

  it('uses exact SVG hex roles and DXF ACI plus true-color roles without private process text', async () => {
    const output = await createColoredOutlinePackage(coloredResult());
    expect(output.cutSvg).toContain('id="CUT_BLACK"');
    expect(output.cutSvg).toContain('stroke="#000000"');
    expect(output.cutSvg).toContain('stroke="#E5484D"');
    expect(output.cutSvg).toContain('stroke="#3A78D4"');
    expect(output.cutDxf).toContain('DEEP_RED');
    expect(output.cutDxf).toMatch(/2\nDEEP_RED\n[\s\S]*62\n1\n420\n15026253\n/);
    expect(output.cutDxf).toMatch(/2\nLIGHT_BLUE\n[\s\S]*62\n5\n420\n3832020\n/);
    const text = `${output.cutSvg}\n${output.cutDxf}`;
    expect(text).not.toMatch(/80%|40%|power|speed|passes|material|acrylic|plywood|\.stl|manifest|\.json|@|\/Users\//i);
  });

  it.each([
    'svg-parse:point-loop',
    'dxf-parse:point-loop',
    'colored-package:verify-preview-load:after',
    'colored-package:verify-exploded-load:after',
    'colored-package:verify-preview-byte-loop',
    'colored-package:verify-zip-central-record-loop',
    'colored-package:verify-zip-local-record-loop',
    'colored-package:verify-zip-load:after',
    'colored-package:verify-zip-svg:after-read',
    'colored-package:verify-zip-svg-crc-byte-loop',
    'colored-package:verify-zip-dxf:after-read',
    'colored-package:verify-zip-preview:after-read',
    'colored-package:verify-zip-exploded:after-read',
  ])('checks the one absolute deadline at %s', async (expiryLabel) => {
    let time = 0;
    const labels: string[] = [];
    await expect(createColoredOutlinePackage(coloredResult(), 5, {
      now: () => time,
      onCheckpoint: (label) => {
        labels.push(label);
        if (label === expiryLabel) time = 6;
      },
    })).rejects.toThrow(/shared deadline/i);
    expect(labels).toContain(expiryLabel);
  });

  it('rejects an eighth raw ZIP record even when JSZip collapses its duplicate name', async () => {
    const runtime = coloredResult();
    const output = await createColoredOutlinePackage(runtime);
    const duplicateZip = duplicateFirstCentralDirectoryRecord(output.zip);
    expect(Object.keys((await JSZip.loadAsync(duplicateZip)).files)).toHaveLength(7);

    await expect(verifyColoredOutlinePackage({ ...output, zip: duplicateZip }, runtime))
      .rejects.toThrow(/four|record|duplicate|central/i);
  });

  it('rejects central-directory records reordered without changing local records or payloads', async () => {
    const runtime = coloredResult();
    const output = await createColoredOutlinePackage(runtime);
    const reordered = reorderCentralDirectoryRecords(output.zip, [1, 0, 2, 3, 4, 5, 6]);

    await expect(verifyColoredOutlinePackage({ ...output, zip: reordered }, runtime))
      .rejects.toThrow(/writer|order|central/i);
  });

  it.each(STRICT_RAW_ZIP_MUTATIONS)('strictly rejects raw ZIP mutation: %s', async (_label, mutate) => {
    const runtime = coloredResult();
    const output = await createColoredOutlinePackage(runtime);
    const forged = mutateRawZip(output.zip, mutate);

    await expect(verifyColoredOutlinePackage({ ...output, zip: forged }, runtime))
      .rejects.toThrow(/ZIP|archive|central|local|CRC|descriptor|encrypted|canonical/i);
  });

  it('fails a package deterministically when its shared deadline is already exhausted', async () => {
    await expect(createOutlinePackage(result(), 0)).rejects.toThrow(/shared deadline/i);
  });
  it('preserves the legacy third-argument now function', async () => {
    await expect(createOutlinePackage(result(), 5, () => 6)).rejects.toThrow(/shared deadline/i);
    const output = await createOutlinePackage(result());
    await expect(verifyOutlinePackage(output, 5, () => 6)).rejects.toThrow(/shared deadline/i);
  });
  it('fails immediately after an awaited ZIP read crosses a valid shared deadline', async () => {
    const output = await createOutlinePackage(result());
    let time = 0;
    const labels: string[] = [];
    const options = {
      now: () => time,
      onCheckpoint: (label: string) => {
        labels.push(label);
        if (label === 'verify:zip-entry:cut.svg:after-read') time = 6;
      },
    };

    await expect(verifyOutlinePackage(output, 5, options)).rejects.toThrow(/shared deadline/i);
    expect(labels).toContain('verify:zip-entry:cut.svg:before-read');
    expect(labels.at(-1)).toBe('verify:zip-entry:cut.svg:after-read');
  });
  it.each([
    ['create:document-point-loop', 'create'],
    ['create:outline-validation-loop', 'create'],
    ['verify:polygon-validation-loop', 'verify'],
    ['verify:metadata-layer-loop', 'verify'],
  ])('fails inside the labeled %s heavy loop during %s', async (expiryLabel, phase) => {
    const output = phase === 'verify' ? await createOutlinePackage(result()) : undefined;
    let time = 0;
    const options = { now: () => time, onCheckpoint: (label: string) => { if (label === expiryLabel) time = 6; } };
    const operation = phase === 'verify'
      ? verifyOutlinePackage(output!, 5, options)
      : createOutlinePackage(result(), 5, options);
    await expect(operation).rejects.toThrow(/shared deadline/i);
  });
  it('requires and reconciles sanitized diagnostics across canonical outputs', async () => {
    const missing = structuredClone(result());
    delete (missing as unknown as { diagnostics?: AutomaticOutlineResult['diagnostics'] }).diagnostics;
    await expect(createOutlinePackage(missing)).rejects.toThrow(/diagnostic/i);
    const mismatched = structuredClone(result());
    Object.assign(mismatched.diagnostics.layers[0], { boundsDriftRatio: 0.02 });
    await expect(createOutlinePackage(mismatched)).rejects.toThrow(/diagnostic/i);

    const output = await createOutlinePackage(result());
    expect(output.manifest.diagnostics).toEqual(output.document.outline!.diagnostics);
    expect(output.projectJson).toContain('simplificationToleranceMm');
    expect(output.cutSvg).toContain(`data-diagnostics-fingerprint="${output.manifest.diagnosticsFingerprint}"`);
    expect(output.cutDxf).toContain(`DIAGNOSTICS_FINGERPRINT:${output.manifest.diagnosticsFingerprint}`);
    await expect(pdfKeywords(output.previewPdf)).resolves.toContain(`diagnostics-evidence:${output.manifest.diagnosticsFingerprint}`);
    const forged = structuredClone(output);
    Object.assign(forged.document.outline!.diagnostics.layers[0], { areaDriftRatio: 0.04 });
    await expect(verifyOutlinePackage(forged)).rejects.toThrow(/diagnostic|provenance/i);
  });

  it('reconciles exact-to-projected fallback evidence from disconnected closed slices', async () => {
    const runtime = await convertAutomatically({
      bytes: writeBinarySTL(launcherCompatibleSeparatedClosedCylinders(), 'safe'),
    });
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

  it('never discloses internal provisional launcher evidence to documents or any artifact', async () => {
    const sentinelId = 'INTERNAL_PROVISIONAL_SENTINEL_7f2b';
    const sentinelCoordinate = -27.314159;
    const internalContour = {
      id: sentinelId,
      role: 'DEEP_RED' as const,
      outer: [
        [sentinelCoordinate, -28] as const,
        [sentinelCoordinate, -27] as const,
        [-26.314159, -27] as const,
        [-26.314159, -28] as const,
      ],
      boundsMm: {
        minX: sentinelCoordinate, minY: -28,
        maxX: -26.314159, maxY: -27,
      },
      areaMm2: 1,
    };
    const colored = coloredResult();
    const privateColored = {
      ...colored,
      internalValidationEvidence: {
        launcherDecoration: {
          provisional: { red: [internalContour], blue: [] },
          protectedCutClearanceMm: colored.material!.minWebMm,
        },
      },
    };
    const coloredDocument = createColoredOutlineDocument(privateColored);
    const coloredPackage = await createColoredOutlinePackage(privateColored);
    const coloredZip = await JSZip.loadAsync(coloredPackage.zip);
    const coloredZipPayloads = await Promise.all(Object.values(coloredZip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.async('uint8array')));

    const legacy = await createOutlinePackage(result({
      internalValidationEvidence: privateColored.internalValidationEvidence,
    }));
    const legacyZip = await JSZip.loadAsync(legacy.zip);
    const legacyZipPayloads = await Promise.all(Object.values(legacyZip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.async('uint8array')));
    const textPayloads = [
      JSON.stringify(coloredDocument),
      coloredPackage.cutSvg,
      coloredPackage.cutDxf,
      legacy.cutSvg,
      legacy.cutDxf,
      legacy.projectJson,
      legacy.manifestJson,
      JSON.stringify(legacy.document),
      JSON.stringify(legacy.manifest),
    ];
    const binaryPayloads = [
      coloredPackage.previewPdf,
      coloredPackage.explodedViewPdf,
      coloredPackage.zip,
      ...coloredZipPayloads,
      legacy.previewPdf,
      legacy.zip,
      ...legacyZipPayloads,
    ];

    for (const payload of textPayloads) {
      expect(payload).not.toContain(sentinelId);
      expect(payload).not.toContain(String(sentinelCoordinate));
    }
    for (const payload of binaryPayloads) {
      const decoded = new TextDecoder('latin1').decode(payload);
      expect(decoded).not.toContain(sentinelId);
      expect(decoded).not.toContain(String(sentinelCoordinate));
    }
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
