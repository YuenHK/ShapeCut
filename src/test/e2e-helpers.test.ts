import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, rgb } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compareDownloadedOutlineBytes,
  expectReleaseAssemblyGeometry,
  expectSharedCentralHoleGeometry,
  inspectColoredArtifacts,
  installWorkerResultProbe,
  measureCompleteReleaseRun,
  parseColoredOutlineDxfArtifact,
  parseColoredOutlinePdf,
  parseColoredOutlineSvgArtifact,
  parseColoredZipRecords,
  parseLauncherFitCouponArtifact,
  validateColoredEntityRecords,
  type ColoredArtifactPayloads,
  type ColoredEntityRecord,
  type WorkerResultSummary,
} from '../../e2e/helpers';
import { coloredResult, nearLimitColoredResult } from '../export/colored-outline-test-fixture';
import { createOutlinePackage, type ColoredOutlinePackage } from '../export/outline-package';
import { featureEvidenceFingerprint } from '../domain/outline-features/types';
import {
  convertAutomatically,
  stripAutomaticOutlineInternalEvidence,
} from '../domain/pipeline/automatic-outline-pipeline';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { writeBinarySTL } from '../domain/mesh/write-stl';
import type { TriangleMesh } from '../domain/mesh/types';

let output: ColoredOutlinePackage;
let artifacts: ColoredArtifactPayloads;

const integrationMaterial = {
  id: 'e2e-assembly', name: 'E2E assembly', thicknessMm: 3, kerfMm: 0.1,
  minFeatureMm: 0.8, minWebMm: 0.5,
  fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 },
} as const;

function assemblyCylinder(segments = 32): TriangleMesh {
  const positions: number[] = [0, 0, -1, 0, 0, 1];
  for (let index = 0; index < segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    positions.push(40 * Math.cos(angle), 40 * Math.sin(angle), -1);
    positions.push(40 * Math.cos(angle), 40 * Math.sin(angle), 1);
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

function releaseSummary(result: AutomaticOutlineResult): WorkerResultSummary {
  if (result.status !== 'success' && result.status !== 'warning') {
    throw new Error('Release fixture must produce a downloadable result');
  }
  return {
    mode: result.mode,
    status: result.status,
    removedComponentCount: result.removedComponentCount,
    featureWarnings: [...result.featureWarnings],
    material: structuredClone(result.material),
    assembly: structuredClone(result.assembly),
    coloredLayers: result.coloredLayers.map((layer) => ({
      id: layer.id,
      widthMm: layer.exterior.boundsMm.maxX - layer.exterior.boundsMm.minX,
      planarDiameterMm: Math.hypot(
        layer.exterior.boundsMm.maxX - layer.exterior.boundsMm.minX,
        layer.exterior.boundsMm.maxY - layer.exterior.boundsMm.minY,
      ),
      cellSizeMm: layer.diagnostics.depth.cellSizeMm,
      exteriorPoints: layer.exterior.outer,
      hole: layer.centralHole && layer.diagnostics.hole.status === 'retained' ? {
        status: 'retained',
        id: layer.centralHole.id,
        equivalentDiameterMm: layer.diagnostics.hole.equivalentDiameterMm,
        axisDistanceMm: layer.diagnostics.hole.axisDistanceMm,
        areaMm2: layer.centralHole.areaMm2,
        points: layer.centralHole.outer,
      } : { status: 'omitted' },
      launcherCuts: layer.launcherCuts.map(({ outer }) => outer),
      fastenerHoles: layer.fastenerHoles.map(({ outer }) => outer),
      deepFeatures: layer.deepFeatures.map(({ outer }) => outer),
      lightFeatures: layer.lightFeatures.map(({ outer }) => outer),
      hasDeep: layer.deepFeatures.length > 0,
      hasLight: layer.lightFeatures.length > 0,
    })),
  };
}

it('executes the worker probe init callback after serialization without module-scope closures', async () => {
  type Listener = (event: { data: unknown }) => void;
  class IsolatedWorker {
    private readonly listeners: Listener[] = [];
    constructor(_url: string | URL, _options?: WorkerOptions) {}
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'message') this.listeners.push(listener as unknown as Listener);
    }
    postMessage(_message: unknown): void {}
    terminate(): void {}
    emit(data: unknown): void {
      for (const listener of this.listeners) listener({ data });
    }
  }
  const originalWorker = window.Worker;
  Object.defineProperty(window, 'Worker', { configurable: true, value: IsolatedWorker });
  try {
    const page = {
      addInitScript: async (callback: (...args: unknown[]) => unknown, argument: unknown) => {
        expect(callback.toString()).not.toMatch(
          /OFFICIAL_THREE_PRONG_TEMPLATE|LAUNCHER_ASSEMBLY_ALLOWANCE|LAUNCHER_FIT_OFFSET_/,
        );
        const isolated = Function(`return (${callback.toString()})`)() as (value: unknown) => unknown;
        isolated(argument);
      },
    };
    await installWorkerResultProbe(page as never);
    const worker = new window.Worker('/geometry.worker.js') as unknown as IsolatedWorker;
    expect(() => worker.emit(releaseSummary(coloredResult()))).not.toThrow();
    const sourceResult = coloredResult();
    const physicalOrderResult = stripAutomaticOutlineInternalEvidence({
      ...sourceResult,
      assembly: {
        ...sourceResult.assembly,
        decorationOmissions: [
          {
            layerId: 'layer-2',
            reason: 'protected-cut-work-budget',
            roles: ['DEEP_RED', 'LIGHT_BLUE'],
          },
          {
            layerId: 'layer-10',
            reason: 'protected-cut-work-budget',
            roles: ['DEEP_RED', 'LIGHT_BLUE'],
          },
        ],
      },
    });
    expect(() => worker.emit(physicalOrderResult)).not.toThrow();
    expect((window as unknown as {
      __shapeCutWorkerProbe: { results: WorkerResultSummary[] };
    }).__shapeCutWorkerProbe.results.at(-1)?.assembly?.decorationOmissions)
      .toEqual(physicalOrderResult.assembly.decorationOmissions);
  } finally {
    Object.defineProperty(window, 'Worker', { configurable: true, value: originalWorker });
  }
});

beforeAll(async () => {
  output = await createOutlinePackage(coloredResult());
  artifacts = {
    zip: output.zip,
    svg: output.cutSvg,
    dxf: output.cutDxf,
    previewPdf: output.previewPdf,
    explodedPdf: output.explodedViewPdf,
    launcherCouponSvg: output.launcherCouponSvg,
  };
});

function mutateSvgEntity(
  svg: string,
  role: 'CUT_BLACK' | 'DEEP_RED' | 'LIGHT_BLUE',
  mutate: (tag: string) => string,
): string {
  const pattern = new RegExp(`<polygon\\b[^>]*data-role="${role}"[^>]*/>`);
  const entity = svg.match(pattern)?.[0];
  if (!entity) throw new Error(`Fixture has no ${role} entity`);
  return svg.replace(entity, mutate(entity));
}

function duplicateFirstCentralDirectoryRecord(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error('Fixture ZIP has no canonical EOCD');
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

function insertOrphanLocalRecord(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const centralOffset = view.getUint32(eocd + 16, true);
  const localOffset = view.getUint32(centralOffset + 42, true);
  const localLength = 30
    + view.getUint16(localOffset + 26, true)
    + view.getUint16(localOffset + 28, true)
    + view.getUint32(centralOffset + 20, true);
  const forged = new Uint8Array(bytes.length + localLength);
  forged.set(bytes.subarray(0, centralOffset));
  forged.set(bytes.subarray(localOffset, localOffset + localLength), centralOffset);
  forged.set(bytes.subarray(centralOffset), centralOffset + localLength);
  new DataView(forged.buffer).setUint32(eocd + localLength + 16, centralOffset + localLength, true);
  return forged;
}

async function mutatePdfContent(bytes: Uint8Array, mutate: (content: string) => string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPage(0), contents = page.node.Contents();
  const values = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  if (values.length !== 1) throw new Error('Fixture PDF must have one content stream');
  const stream = pdf.context.lookup(values[0]);
  if (!(stream instanceof PDFRawStream)) throw new Error('Fixture PDF content must be raw');
  const decoded = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
  const mutated = mutate(decoded);
  if (mutated === decoded) throw new Error('PDF content mutation made no change');
  const replacement = pdf.context.register(pdf.context.flateStream(mutated));
  page.node.set(PDFName.of('Contents'), pdf.context.obj([replacement]));
  values.forEach((value) => {
    if (value instanceof PDFRef) pdf.context.delete(value);
  });
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function mutatePdfEndpoint(bytes: Uint8Array, lineIndex: number): Promise<Uint8Array> {
  let encounter = -1;
  return mutatePdfContent(bytes, (decoded) => decoded.replace(/(-?(?:\d+(?:\.\d*)?|\.\d+)) (-?(?:\d+(?:\.\d*)?|\.\d+)) l/g, (line, x: string, y: string) => {
    encounter += 1;
    return encounter === lineIndex ? `${Number(x) + 1} ${y} l` : line;
  }));
}

async function mutatePdfPage(
  bytes: Uint8Array,
  mutate: (pdf: PDFDocument) => void,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  mutate(pdf);
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function encodedPdfText(value: string): string {
  return [...value].map((character) => character.codePointAt(0)!.toString(16).padStart(2, '0').toUpperCase()).join('');
}

async function mutatePdfRawInfoWithOctalPath(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) throw new Error('Fixture PDF has no Info dictionary');
  const placeholder = 'XXXXprivateXXXXvarXXXXsecret';
  info.set(PDFName.of('Private'), PDFString.of(placeholder));
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const saved = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  const encoded = '\\057private\\057var\\057secret';
  const needle = new TextEncoder().encode(`(${placeholder})`);
  const replacement = new TextEncoder().encode(`(${encoded})`);
  const offset = saved.findIndex((_value, index) => needle.every((value, inner) => saved[index + inner] === value));
  if (placeholder.length !== encoded.length || offset < 0) {
    throw new Error('Fixture PDF raw Info placeholder is unavailable');
  }
  const mutated = saved.slice();
  mutated.set(replacement, offset);
  return mutated;
}

async function mutatePdfRawInfoWithWhitespaceAndOddNibbleHexPath(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) throw new Error('Fixture PDF has no Info dictionary');
  const encoded = '2 F707269766174652F7661722F736563726574F';
  const placeholder = 'A'.repeat(encoded.length);
  info.set(PDFName.of('Private'), PDFHexString.of(placeholder));
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  const saved = await pdf.save({ useObjectStreams: false, addDefaultPage: false });
  const needle = new TextEncoder().encode(`<${placeholder}>`);
  const replacement = new TextEncoder().encode(`<${encoded}>`);
  const offset = saved.findIndex((_value, index) => needle.every((value, inner) => saved[index + inner] === value));
  if (needle.length !== replacement.length || offset < 0) throw new Error('Fixture PDF raw hex placeholder is unavailable');
  const mutated = saved.slice();
  mutated.set(replacement, offset);
  return mutated;
}

async function mutatePdfInfoWithStreamLikeLiteralPath(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) throw new Error('Fixture PDF has no Info dictionary');
  info.set(PDFName.of('Private'), PDFString.of([
    'stream', ['', 'private', 'var', 'secret'].join('/'), 'endstream',
  ].join('\n')));
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function mutatePdfInfoWithEncodedNamePath(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) throw new Error('Fixture PDF has no Info dictionary');
  info.set(PDFName.of(['Private', '', 'private', 'var', 'secret'].join('/')), PDFString.of('hidden'));
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

async function mutatePdfWithOrphanPrivateStream(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  pdf.context.register(pdf.context.flateStream(['', 'private', 'var', 'secret'].join('/')));
  pdf.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}

function mutatePdfWithPostEofPrivatePath(bytes: Uint8Array): Uint8Array {
  const suffix = new TextEncoder().encode(`% ${['', 'private', 'var', 'secret'].join('/')}\n`);
  const mutated = new Uint8Array(bytes.length + suffix.length);
  mutated.set(bytes);
  mutated.set(suffix, bytes.length);
  return mutated;
}

async function zipWithArtifacts(value: ColoredArtifactPayloads): Promise<Uint8Array> {
  const zip = new JSZip(), date = new Date('2000-01-01T00:00:00.000Z');
  zip.file('cut-and-engrave.svg', value.svg, { date });
  zip.file('cut-and-engrave.dxf', value.dxf, { date });
  zip.file('preview.pdf', value.previewPdf, { date });
  zip.file('exploded-view.pdf', value.explodedPdf, { date });
  zip.file('launcher-fit-coupon.svg', value.launcherCouponSvg!, { date });
  zip.file('project.json', output.projectJson, { date });
  zip.file('manifest.json', output.manifestJson, { date });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function zipWithMutatedMetadata(
  mutate: (
    project: Record<string, unknown>,
    manifest: Record<string, unknown>,
  ) => void,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const project = JSON.parse(output.projectJson) as Record<string, unknown>;
  const manifest = JSON.parse(output.manifestJson) as Record<string, unknown>;
  mutate(project, manifest);
  const projectJson = JSON.stringify(project, null, 2);
  const payloads = [
    ['cut-and-engrave.svg', encoder.encode(output.cutSvg)],
    ['cut-and-engrave.dxf', encoder.encode(output.cutDxf)],
    ['preview.pdf', output.previewPdf],
    ['exploded-view.pdf', output.explodedViewPdf],
    ['launcher-fit-coupon.svg', encoder.encode(output.launcherCouponSvg)],
    ['project.json', encoder.encode(projectJson)],
  ] as const;
  manifest.members = payloads.map(([path, payload]) => ({
    path,
    byteLength: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
  }));
  const manifestJson = JSON.stringify(manifest, null, 2);
  const zip = new JSZip(), date = new Date('2000-01-01T00:00:00.000Z');
  payloads.forEach(([path, payload]) => zip.file(path, Buffer.from(payload), { date }));
  zip.file('manifest.json', manifestJson, { date });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const CENTRAL_HOLE_OMISSION_WARNING = 'No reliable central axle hole was found; the hole was omitted.';

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
    featureWarnings: [CENTRAL_HOLE_OMISSION_WARNING, ...result.featureWarnings],
    preview: { ...result.preview, layers: coloredLayers },
  };
  return { ...omitted, featureEvidenceFingerprint: featureEvidenceFingerprint(omitted) };
}

function sharedHoleSummary(): WorkerResultSummary {
  const points = [[-2, -2], [2, -2], [2, 2], [-2, 2]] as const;
  return {
    mode: 'exact',
    status: 'success',
    removedComponentCount: 0,
    featureWarnings: [],
    coloredLayers: Array.from({ length: 6 }, (_, index) => ({
      id: `layer-${index + 1}`,
      widthMm: 20,
      planarDiameterMm: Math.hypot(20, 20),
      cellSizeMm: 0.25,
      exteriorPoints: [[-10, -10], [-10, 10], [10, 10], [10, -10]] as const,
      hole: { status: 'retained' as const, points },
      hasDeep: false,
      hasLight: false,
    })),
  };
}

describe('release E2E colored artifact parsers', () => {
  it('keeps the near-limit fixture assembly summary aligned with its top feature arrays', () => {
    const result = nearLimitColoredResult();
    const top = result.coloredLayers.at(-1)!;
    expect(result.assembly.topFeatures.retained).toEqual({
      red: top.deepFeatures.length,
      blue: top.lightFeatures.length,
    });
  });

  it('accepts exact maximum canonical role arrays and rejects lower/top overflow or black subrole reordering', () => {
    const polygon = [[0, 0], [1, 0], [1, 1]] as const;
    const record = (layer: number, role: ColoredEntityRecord['role'], id: string): ColoredEntityRecord => ({
      physicalLayerId: `layer-${layer}`, order: layer, index: layer - 1,
      zStart: layer - 1, zEnd: layer, role, id, points: polygon,
    });
    const entities = Array.from({ length: 6 }, (_, position) => {
      const layer = position + 1, top = layer === 6;
      return [
        record(layer, 'CUT_BLACK', `layer-${layer}-exterior`),
        record(layer, 'CUT_BLACK', `layer-${layer}-central-hole`),
        ...(layer >= 5 ? [1, 2, 3].map((index) => record(
          layer, 'CUT_BLACK', `layer-${layer}-launcher-clearance-${index}`,
        )) : []),
        ...[1, 2, 3].map((index) => record(layer, 'CUT_BLACK', `layer-${layer}-fastener-hole-${index}`)),
        ...Array.from({ length: top ? 12 : 1 }, (_, index) => record(layer, 'DEEP_RED', `layer-${layer}-red-${index}`)),
        ...Array.from({ length: top ? 12 : 1 }, (_, index) => record(layer, 'LIGHT_BLUE', `layer-${layer}-blue-${index}`)),
      ];
    }).flat();
    expect(() => validateColoredEntityRecords(entities, 'maximum fixture')).not.toThrow();

    const lowerRedIndex = entities.findIndex(({ physicalLayerId, role }) => physicalLayerId === 'layer-1' && role === 'DEEP_RED');
    const lowerOverflow = [...entities];
    lowerOverflow.splice(lowerRedIndex + 1, 0, record(1, 'DEEP_RED', 'layer-1-red-extra'));
    expect(() => validateColoredEntityRecords(lowerOverflow, 'lower overflow')).toThrow(/cardinality|role/i);

    const topBlueIndex = entities.length - 1;
    const topOverflow = [...entities];
    topOverflow.splice(topBlueIndex + 1, 0, record(6, 'LIGHT_BLUE', 'layer-6-blue-extra'));
    expect(() => validateColoredEntityRecords(topOverflow, 'top overflow')).toThrow(/cardinality|role/i);

    const reordered = [...entities];
    const launcherIndex = reordered.findIndex(({ id }) => id === 'layer-6-launcher-clearance-1');
    const fastenerIndex = reordered.findIndex(({ id }) => id === 'layer-6-fastener-hole-1');
    [reordered[launcherIndex], reordered[fastenerIndex]] = [reordered[fastenerIndex], reordered[launcherIndex]];
    expect(() => validateColoredEntityRecords(reordered, 'black reorder')).toThrow(/canonical|array/i);

    const renamed = structuredClone(entities);
    renamed[launcherIndex] = {
      ...renamed[launcherIndex],
      id: 'renamed-layer-6-launcher-clearance-1',
    };
    expect(() => validateColoredEntityRecords(renamed, 'launcher rename')).toThrow(/canonical|identity|launcher/i);

    const swappedOwnership = structuredClone(entities);
    const layerFiveLauncher = swappedOwnership.findIndex(({ id }) => id === 'layer-5-launcher-clearance-1');
    const layerFiveId = swappedOwnership[layerFiveLauncher].id;
    const layerSixId = swappedOwnership[launcherIndex].id;
    swappedOwnership[layerFiveLauncher] = { ...swappedOwnership[layerFiveLauncher], id: layerSixId };
    swappedOwnership[launcherIndex] = { ...swappedOwnership[launcherIndex], id: layerFiveId };
    expect(() => validateColoredEntityRecords(swappedOwnership, 'launcher ownership')).toThrow(/canonical|identity|launcher/i);
  });

  it('reconciles a genuine converted package with fixed launcher and three shared fasteners', async () => {
    const result = await convertAutomatically({
      bytes: writeBinarySTL(assemblyCylinder(), 'safe'),
      material: integrationMaterial,
      launcherFitOffsetMm: 0,
    });
    expect(result.assembly.launcher.status).toBe('fixed');
    expect(result.assembly.fastener.count).toBe(3);
    const packaged = await createOutlinePackage(result);
    const inspected = await inspectColoredArtifacts({
      zip: packaged.zip,
      svg: packaged.cutSvg,
      dxf: packaged.cutDxf,
      previewPdf: packaged.previewPdf,
      explodedPdf: packaged.explodedViewPdf,
      launcherCouponSvg: packaged.launcherCouponSvg,
    });
    const summary = releaseSummary(result);
    expect(() => expectReleaseAssemblyGeometry(summary, inspected)).not.toThrow();
    const shiftedCenter: WorkerResultSummary = {
      ...summary,
      assembly: {
        ...summary.assembly!,
        fastener: {
          ...summary.assembly!.fastener,
          centers: summary.assembly!.fastener.centers.map(([x, y], index) => (
            index === 0 ? [x + 0.5, y] as const : [x, y] as const
          )),
        },
      },
    };
    expect(() => expectReleaseAssemblyGeometry(shiftedCenter, inspected))
      .toThrow(/fastener.*(?:center|decision)/i);
    expect(inspected.entities.filter(({ id }) => id.includes('-launcher-clearance-'))).toHaveLength(6);
    expect(inspected.entities.filter(({ id }) => id.includes('-fastener-hole-'))).toHaveLength(18);
  }, 30_000);

  it('reconciles readable PDF safety notes for a warned all-layer hole omission', async () => {
    const omitted = await createOutlinePackage(allLayerHoleOmissionResult());
    const payloads: ColoredArtifactPayloads = {
      zip: omitted.zip,
      svg: omitted.cutSvg,
      dxf: omitted.cutDxf,
      previewPdf: omitted.previewPdf,
      explodedPdf: omitted.explodedViewPdf,
      launcherCouponSvg: omitted.launcherCouponSvg,
    };

    const inspected = await inspectColoredArtifacts(payloads);
    for (const pdf of [inspected.previewPdf, inspected.explodedPdf]) {
      expect(pdf.textRecords.map(({ text }) => text)).toContain(CENTRAL_HOLE_OMISSION_WARNING);
    }
  });

  it('accepts six identical retained central holes in bounded model-space evidence', () => {
    expect(() => expectSharedCentralHoleGeometry(sharedHoleSummary())).not.toThrow();
  });

  it('accepts a warned all-layer central-hole omission', () => {
    const summary = sharedHoleSummary();
    const omitted: WorkerResultSummary = {
      ...summary,
      status: 'warning',
      featureWarnings: [CENTRAL_HOLE_OMISSION_WARNING],
      coloredLayers: summary.coloredLayers.map((layer) => ({
        ...layer,
        hole: { status: 'omitted' as const },
      })),
    };
    expect(() => expectSharedCentralHoleGeometry(omitted)).not.toThrow();
  });

  it('rejects all-layer central-hole omission without the canonical warning', () => {
    const summary = sharedHoleSummary();
    const missingWarning: WorkerResultSummary = {
      ...summary,
      status: 'warning',
      coloredLayers: summary.coloredLayers.map((layer) => ({
        ...layer,
        hole: { status: 'omitted' as const },
      })),
    };
    expect(() => expectSharedCentralHoleGeometry(missingWarning)).toThrow(/omission warning|required/i);
  });

  it('rejects a mixed retained and omitted central-hole decision', () => {
    const summary = sharedHoleSummary();
    const mixed: WorkerResultSummary = {
      ...summary,
      coloredLayers: summary.coloredLayers.map((layer, index) => index === summary.coloredLayers.length - 1 ? {
        ...layer,
        hole: { status: 'omitted' as const },
      } : layer),
    };
    expect(() => expectSharedCentralHoleGeometry(mixed)).toThrow(/retain every layer|omit every layer|shared/i);
  });

  it('rejects one shifted retained central hole before artifact layout', () => {
    const summary = sharedHoleSummary();
    const shifted: WorkerResultSummary = {
      ...summary,
      coloredLayers: summary.coloredLayers.map((layer, index) => index === summary.coloredLayers.length - 1 ? {
        ...layer,
        hole: {
          ...layer.hole,
          points: layer.hole.points?.map(([x, y]) => [x + 1, y] as const),
        },
      } : layer),
    };

    expect(() => expectSharedCentralHoleGeometry(shifted))
      .toThrow(/central hole.*identical|shared/i);
  });

  it('parses every SVG role group/entity and every DXF layer/entity in encounter order', () => {
    const svg = parseColoredOutlineSvgArtifact(output.cutSvg);
    const dxf = parseColoredOutlineDxfArtifact(output.cutDxf);

    expect(svg.layers.map(({ order }) => order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(svg.entities.map(({ id }) => id)).toEqual(dxf.entities.map(({ id }) => id));
    expect(svg.entities).toEqual(dxf.entities);
    expect(svg.entityCounts).toEqual({ CUT_BLACK: 18, DEEP_RED: 1, LIGHT_BLUE: 1 });
    expect(svg.layers.flatMap(({ roleGroups }) => roleGroups.map(({ role }) => role)))
      .toEqual(Array.from({ length: 6 }, () => ['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE']).flat());
  });

  it.each([
    ['width drift', (svg: string) => svg.replace(/width="(\d+)mm"/, (_match, width: string) => `width="${Number(width) + 1}mm"`)],
    ['viewBox extent drift', (svg: string) => svg.replace(/viewBox="0 0 (\d+) (\d+)"/, (_match, width: string, height: string) => `viewBox="0 0 ${Number(width) + 1} ${height}"`)],
    ['wrong namespace', (svg: string) => svg.replace('xmlns="http://www.w3.org/2000/svg"', 'xmlns="https://www.w3.org/2000/svg"')],
    ['wrong physical unit', (svg: string) => svg.replace(/width="(\d+)mm"/, 'width="$1px"')],
    ['non-zero viewBox origin', (svg: string) => svg.replace('viewBox="0 0 ', 'viewBox="1 0 ')],
  ] as const)('rejects non-canonical SVG document dimensions: %s', (_label, mutate) => {
    expect(() => parseColoredOutlineSvgArtifact(mutate(output.cutSvg))).toThrow(/SVG|dimension|extent|namespace|unit|viewBox|canonical/i);
  });

  it('rejects DXF EXTMAX values that do not match the canonical entity layout', () => {
    const mutated = output.cutDxf.replace(/9\n\$EXTMAX\n10\n[^\n]+\n20\n[^\n]+\n30\n0/, '9\n$EXTMAX\n10\n1\n20\n1\n30\n0');
    expect(() => parseColoredOutlineDxfArtifact(mutated)).toThrow(/DXF|extent|layout|canonical/i);
  });

  it('parses all PDF metadata and colored geometry records', async () => {
    const svg = parseColoredOutlineSvgArtifact(output.cutSvg);
    const preview = await parseColoredOutlinePdf(output.previewPdf, 'preview');
    const exploded = await parseColoredOutlinePdf(output.explodedViewPdf, 'exploded');

    expect(preview.layerRecords.map(({ id }) => id)).toEqual(svg.layers.map(({ id }) => id));
    expect(exploded.layerRecords.map(({ id }) => id)).toEqual(svg.layers.map(({ id }) => id));
    expect(preview.geometryRecords).toHaveLength(svg.entities.reduce((sum, entity) => sum + entity.points.length, 0));
    expect(exploded.geometryRecords).toHaveLength(preview.geometryRecords.length + 3);
    expect(preview.fingerprints).toEqual(exploded.fingerprints);
    for (const pdf of [preview, exploded]) {
      expect(pdf.textRecords.map(({ text }) => text)).toEqual(expect.arrayContaining([
        'Red and blue are relative processing levels, not literal machine settings.',
        'Assign machine-specific settings after material test cuts.',
      ]));
    }
    expect(preview.textRecords.map(({ text }) => text)).toEqual(expect.arrayContaining([
      'Scale 1:1 | BLACK CUT | RED DEEP | BLUE LIGHT', 'Layer 3',
    ]));
  });

  it('enumerates the exact seven ZIP records in encounter order and reconciles byte identity', async () => {
    const zip = await parseColoredZipRecords(output.zip);
    expect(zip.map(({ name }) => name)).toEqual([
      'cut-and-engrave.svg',
      'cut-and-engrave.dxf',
      'preview.pdf',
      'exploded-view.pdf',
      'launcher-fit-coupon.svg',
      'project.json',
      'manifest.json',
    ]);

    const inspected = await inspectColoredArtifacts(artifacts);
    expect(inspected.entities).toEqual(parseColoredOutlineSvgArtifact(output.cutSvg).entities);
    expect(inspected.zipRecords.every(({ byteIdentical }) => byteIdentical)).toBe(true);
  });

  it('rejects a synchronized project material forgery after updating the manifest project hash', async () => {
    const zip = await zipWithMutatedMetadata((project) => {
      const assembly = project.assembly as Record<string, unknown>;
      const material = assembly.material as Record<string, unknown>;
      material.minWebMm = (material.minWebMm as number) + 0.1;
    });
    const inspected = await inspectColoredArtifacts({ ...artifacts, zip });

    expect(() => expectReleaseAssemblyGeometry(releaseSummary(coloredResult()), inspected))
      .toThrow(/material.*reconcile/i);
  });

  it('rejects synchronized project fastener and top-feature forgeries with fresh metadata hashes', async () => {
    const fastenerZip = await zipWithMutatedMetadata((project) => {
      const assembly = project.assembly as Record<string, unknown>;
      const fastener = assembly.fastener as Record<string, unknown>;
      fastener.pathDiameterMm = (fastener.pathDiameterMm as number) + 0.1;
    });
    const fastenerOutput = await inspectColoredArtifacts({ ...artifacts, zip: fastenerZip });
    expect(() => expectReleaseAssemblyGeometry(releaseSummary(coloredResult()), fastenerOutput))
      .toThrow(/fastener.*reconcile/i);

    const topZip = await zipWithMutatedMetadata((project, manifest) => {
      const assembly = project.assembly as Record<string, unknown>;
      const top = structuredClone(assembly.topFeatures) as Record<string, unknown>;
      const retained = top.retained as Record<string, unknown>;
      retained.red = (retained.red as number) + 1;
      assembly.topFeatures = top;
      (manifest.decisions as Record<string, unknown>).topFeatures = structuredClone(top);
    });
    const topOutput = await inspectColoredArtifacts({ ...artifacts, zip: topZip });
    expect(() => expectReleaseAssemblyGeometry(releaseSummary(coloredResult()), topOutput))
      .toThrow(/top.*feature|reconcile/i);
  });

  it('rejects ignored manifest decisions and private project notes even with fresh member hashes', async () => {
    const manifestZip = await zipWithMutatedMetadata((_project, manifest) => {
      const decisions = manifest.decisions as Record<string, unknown>;
      decisions.launcherTemplateVersion = 999;
    });
    await expect(inspectColoredArtifacts({ ...artifacts, zip: manifestZip }))
      .rejects.toThrow(/manifest.*decision|template|release/i);

    const privateZip = await zipWithMutatedMetadata((project) => {
      project.safetyNotes = [['', 'private', 'var', 'secret.stl'].join('/')];
    });
    await expect(inspectColoredArtifacts({ ...artifacts, zip: privateZip }))
      .rejects.toThrow(/private|path|source/i);

    const privateFilenameZip = await zipWithMutatedMetadata((project) => {
      project.safetyNotes = ['private model (copy).stl'];
    });
    await expect(inspectColoredArtifacts({ ...artifacts, zip: privateFilenameZip }))
      .rejects.toThrow(/private|filename|source/i);

    const forwardUncZip = await zipWithMutatedMetadata((project) => {
      project.safetyNotes = [['', '', 'server', 'share', 'notes.txt'].join('/')];
    });
    await expect(inspectColoredArtifacts({ ...artifacts, zip: forwardUncZip }))
      .rejects.toThrow(/private|path|source/i);
  });

  it('requires a distinct standalone launcher coupon instead of counting the ZIP member twice', async () => {
    await expect(inspectColoredArtifacts({
      ...artifacts,
      launcherCouponSvg: undefined as unknown as string,
    })).rejects.toThrow(/standalone|coupon|download/i);
  });

  it.each([
    ['template fingerprint', (svg: string) => svg.replace(
      /data-template-fingerprint="[0-9a-f]+"/,
      `data-template-fingerprint="${'f'.repeat(32)}"`,
    )],
    ['kerf metadata', (svg: string) => svg.replace(/data-kerf-mm="[^"]+"/, 'data-kerf-mm="0.99"')],
    ['cut geometry', (svg: string) => svg.replace(/points="([^"])/, 'points="9$1')],
    ['document dimensions', (svg: string) => svg.replace(
      /width="([^"]+)mm"/,
      (_match, width: string) => `width="${Number(width) + 1}mm"`,
    )],
    ['label position', (svg: string) => svg.replace(
      /(<text id="launcher-coupon-label-1"[^>]* x=")([^"]+)/,
      (_match, prefix: string, x: string) => `${prefix}${Number(x) + 1}`,
    )],
    ['root-external geometry', (svg: string) => `${svg}<polygon points="0,0 1,0 0,1"/>`],
  ])('rejects non-canonical launcher coupon mutation: %s', (_label, mutate) => {
    expect(() => parseLauncherFitCouponArtifact(mutate(output.launcherCouponSvg))).toThrow(
      /coupon|template|kerf|geometry|canonical|EOF/i,
    );
  });

  it('reconciles coupon material identity and kerf with the bounded worker result', async () => {
    const inspected = await inspectColoredArtifacts(artifacts);
    const summary = releaseSummary(coloredResult());
    expect(() => expectReleaseAssemblyGeometry(summary, {
      ...inspected,
      launcherCoupon: { ...inspected.launcherCoupon, materialId: 'forged-material' },
    })).toThrow(/coupon.*material|material.*coupon/i);
    expect(() => expectReleaseAssemblyGeometry(summary, {
      ...inspected,
      launcherCoupon: { ...inspected.launcherCoupon, kerfMm: inspected.launcherCoupon.kerfMm + 0.01 },
    })).toThrow(/coupon.*kerf|kerf.*coupon/i);
  });

  it('compares all six bounded downloads from bytes rather than trusting equal diagnostic digests', () => {
    type ByteEvidence = {
      readonly sha256: string;
      readonly downloadBytes: Readonly<Record<'zip' | 'svg' | 'dxf' | 'previewPdf' | 'explodedPdf' | 'launcherCouponSvg', Uint8Array>>;
    };
    const bytes = {
      zip: Uint8Array.of(1, 2, 3),
      svg: Uint8Array.of(4),
      dxf: Uint8Array.of(5),
      previewPdf: Uint8Array.of(6),
      explodedPdf: Uint8Array.of(7),
      launcherCouponSvg: Uint8Array.of(8),
    } as const;
    const first = { sha256: 'same-reported-digest', downloadBytes: bytes };
    const copied = Object.fromEntries(Object.entries(bytes).map(([name, payload]) => [name, payload.slice()])) as ByteEvidence['downloadBytes'];
    expect(compareDownloadedOutlineBytes(first, { sha256: 'same-reported-digest', downloadBytes: copied })).toMatchObject({
      byteIdentical: true,
      comparedArtifactCount: 6,
    });
    expect(() => compareDownloadedOutlineBytes(first, {
      sha256: 'same-reported-digest',
      downloadBytes: { ...bytes, zip: Uint8Array.of(1, 2, 4) },
    })).toThrow(/ZIP.*byte/i);
    for (const name of ['svg', 'dxf', 'previewPdf', 'explodedPdf', 'launcherCouponSvg'] as const) {
      expect(() => compareDownloadedOutlineBytes(first, {
        sha256: 'same-reported-digest',
        downloadBytes: { ...bytes, [name]: Uint8Array.of(255) },
      })).toThrow(/byte/i);
    }
    expect(() => compareDownloadedOutlineBytes(first, {
      sha256: 'same-reported-digest',
      downloadBytes: { ...bytes, zip: new Uint8Array(16 * 1024 * 1024 + 1) },
    })).toThrow(/bounded release evidence limit/i);
  });

  it('measures a complete release callback over one equivalent start-to-finish interval', async () => {
    const clock = [1_000, 1_275];
    const stages: string[] = [];
    const measured = await measureCompleteReleaseRun(async () => {
      stages.push('upload', 'result', 'probe', 'downloads', 'parse', 'reconcile');
      return 'complete';
    }, () => clock.shift()!);
    expect(measured).toEqual({ value: 'complete', durationMs: 275 });
    expect(stages).toEqual(['upload', 'result', 'probe', 'downloads', 'parse', 'reconcile']);
    expect(clock).toEqual([]);
  });

  it.each([
    ['swapped role', (svg: string) => mutateSvgEntity(svg, 'DEEP_RED', (tag) => tag.replace('data-role="DEEP_RED"', 'data-role="LIGHT_BLUE"'))],
    ['recolor', (svg: string) => mutateSvgEntity(svg, 'DEEP_RED', (tag) => tag.replace('stroke="#E5484D"', 'stroke="#3A78D4"'))],
    ['missing central hole', (svg: string) => svg.replace(/<polygon\b[^>]*id="[^"]*-hole"[^>]*\/>/, '')],
    ['extra feature', (svg: string) => mutateSvgEntity(svg, 'DEEP_RED', (tag) => `${tag}${tag.replace(/id="[^"]+"/, 'id="extra-feature"')}`)],
    ['duplicate fingerprint marker', (svg: string) => svg.replace('data-feature-evidence-fingerprint="', 'data-feature-evidence-fingerprint="bad" data-feature-evidence-fingerprint="')],
  ])('rejects raw SVG mutation: %s', async (_label, mutate) => {
    await expect(inspectColoredArtifacts({ ...artifacts, svg: mutate(output.cutSvg) })).rejects.toThrow();
  });

  it('rejects an extra SVG drawable outside the canonical polygon records', () => {
    const mutated = output.cutSvg.replace(
      '</svg>',
      '<path d="M 0 0 L 1 1" fill="none" stroke="#000000"/></svg>',
    );
    expect(() => parseColoredOutlineSvgArtifact(mutated)).toThrow(/drawable|canonical|polygon/i);
  });

  it('rejects geometry moved after the single SVG root', () => {
    const firstGroup = output.cutSvg.indexOf('<g ');
    const mutated = `${output.cutSvg.slice(0, firstGroup)}</svg>${output.cutSvg.slice(firstGroup, -6)}`;
    expect(() => parseColoredOutlineSvgArtifact(mutated)).toThrow(/root|canonical|outside/i);
  });

  it('rejects extra SVG text instead of relying on a partial drawable blacklist', async () => {
    const mutated = { ...artifacts, svg: output.cutSvg.replace(
      '</svg>',
      '<text x="2" y="2" fill="#000000">EXTRA</text></svg>',
    ) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/SVG|canonical|text|element/i);
  });

  it('rejects a raw DXF role swap even when the entity remains lexically parseable', () => {
    const mutated = output.cutDxf.replace(
      /8\nDEEP_RED\n62\n1\n420\n15026253\n/,
      '8\nLIGHT_BLUE\n62\n1\n420\n15026253\n',
    );
    expect(() => parseColoredOutlineDxfArtifact(mutated)).toThrow(/color|role|layer/i);
  });

  it('rejects an extra DXF drawable entity outside the canonical LWPOLYLINE records', () => {
    const mutated = output.cutDxf.replace(
      '0\nENDSEC\n0\nEOF\n',
      '0\nLINE\n8\nCUT_BLACK\n62\n7\n420\n0\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n',
    );
    expect(() => parseColoredOutlineDxfArtifact(mutated)).toThrow(/entity|canonical|LINE/i);
  });

  it('rejects a drawable DXF entity placed after ENTITIES but before EOF', () => {
    const mutated = output.cutDxf.replace(
      '0\nENDSEC\n0\nEOF\n',
      '0\nENDSEC\n0\nLINE\n8\nCUT_BLACK\n10\n0\n20\n0\n11\n1\n21\n1\n0\nEOF\n',
    );
    expect(() => parseColoredOutlineDxfArtifact(mutated)).toThrow(/canonical|record|LINE|EOF/i);
  });

  it('rejects a non-canonical numeric DXF group code hiding an extra entity', async () => {
    const mutated = { ...artifacts, dxf: output.cutDxf.replace(
      '0\nENDSEC\n0\nEOF\n',
      '00\nLINE\n8\nCUT_BLACK\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n',
    ) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/DXF|canonical|code|entity/i);
  });

  it('rejects a duplicate ZIP record that a high-level parser can collapse', async () => {
    const duplicate = duplicateFirstCentralDirectoryRecord(output.zip);
    expect(Object.keys((await JSZip.loadAsync(duplicate)).files)).toHaveLength(7);
    await expect(parseColoredZipRecords(duplicate)).rejects.toThrow(/seven|duplicate|record/i);
  });

  it('rejects an orphan local ZIP record not referenced by the central directory', async () => {
    const orphan = insertOrphanLocalRecord(output.zip);
    expect(Object.keys((await JSZip.loadAsync(orphan)).files)).toHaveLength(7);
    await expect(parseColoredZipRecords(orphan)).rejects.toThrow(/local|coverage|record/i);
  });

  it('rejects unsafe ZIP names using both raw and sanitized identities', async () => {
    const zip = new JSZip();
    zip.file('../cut-and-engrave.svg', output.cutSvg, { createFolders: false });
    zip.file('cut-and-engrave.dxf', output.cutDxf);
    zip.file('preview.pdf', output.previewPdf);
    zip.file('exploded-view.pdf', output.explodedViewPdf);
    zip.file('launcher-fit-coupon.svg', output.launcherCouponSvg);
    zip.file('project.json', output.projectJson);
    zip.file('manifest.json', output.manifestJson);
    const unsafe = await zip.generateAsync({ type: 'uint8array' });

    await expect(parseColoredZipRecords(unsafe)).rejects.toThrow(/unsafe|canonical|name/i);
  });

  it('rejects a PDF mismatch even though both payloads are individually valid PDFs', async () => {
    await expect(inspectColoredArtifacts({ ...artifacts, previewPdf: output.explodedViewPdf }))
      .rejects.toThrow(/PDF|preview|metadata|geometry/i);
  });

  it('rejects extra or transformed PDF drawing geometry instead of counting only colored lines', async () => {
    const extraDocument = await PDFDocument.load(output.previewPdf, { updateMetadata: false });
    extraDocument.getPage(0).drawEllipse({
      x: 20, y: 20, xScale: 5, yScale: 4,
      borderColor: rgb(0, 0, 0), borderWidth: 0.8,
    });
    extraDocument.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
    extraDocument.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
    const extra = await extraDocument.save({ useObjectStreams: false, addDefaultPage: false });
    await expect(parseColoredOutlinePdf(extra, 'preview')).rejects.toThrow(/drawing|geometry|stream|canonical|forbidden|Annots/i);

    const transformedDocument = await PDFDocument.load(output.previewPdf, { updateMetadata: false });
    transformedDocument.getPage(0).translateContent(1, 0);
    transformedDocument.setCreationDate(new Date('2000-01-01T00:00:00.000Z'));
    transformedDocument.setModificationDate(new Date('2000-01-01T00:00:00.000Z'));
    const transformed = await transformedDocument.save({ useObjectStreams: false, addDefaultPage: false });
    await expect(parseColoredOutlinePdf(transformed, 'preview')).rejects.toThrow(/drawing|geometry|stream|canonical|forbidden|Annots/i);
  });

  it.each([
    ['preview reordered endpoint', 'previewPdf', 0],
    ['exploded projected geometry', 'explodedPdf', 1],
  ] as const)('rejects byte-consistent ZIP with mutated PDF geometry: %s', async (_label, field, lineIndex) => {
    const mutated = { ...artifacts, [field]: await mutatePdfEndpoint(artifacts[field], lineIndex) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/PDF|drawing|geometry|reconcile/i);
  });

  it.each([
    ['Rotate', (bytes: Uint8Array) => mutatePdfPage(bytes, (pdf) => {
      pdf.getPage(0).node.set(PDFName.of('Rotate'), PDFNumber.of(90));
    })],
    ['UserUnit', (bytes: Uint8Array) => mutatePdfPage(bytes, (pdf) => {
      pdf.getPage(0).node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    })],
    ['annotation', (bytes: Uint8Array) => mutatePdfPage(bytes, (pdf) => {
      pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj([{
        Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 1, 1],
      }]));
    })],
    ['non-canonical CropBox', (bytes: Uint8Array) => mutatePdfPage(bytes, (pdf) => {
      pdf.getPage(0).node.set(PDFName.of('CropBox'), pdf.context.obj([0, 0, 10, 10]));
    })],
  ] as const)('rejects byte-consistent ZIP with forbidden PDF page feature: %s', async (_label, mutate) => {
    const mutated = { ...artifacts, previewPdf: await mutate(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/PDF|page|box|forbidden|canonical/i);
  });

  it.each([
    ['wrong label', 'WRONG LAYER LABEL', /text|label|reconcile/i],
    ['private path', ['', 'private', 'var', 'secret-model.stl'].join('/'), /private|path|source|forbidden|text/i],
  ] as const)('rejects byte-consistent ZIP with decoded PDF %s', async (_label, replacement, error) => {
    const previewPdf = await mutatePdfContent(artifacts.previewPdf, (content) => content.replace(
      /<(?:[0-9A-F]{2})+> Tj/,
      `<${encodedPdfText(replacement)}> Tj`,
    ));
    const mutated = { ...artifacts, previewPdf };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(error);
  });

  it('rejects a byte-consistent ZIP whose raw PDF Info string hides a private path in octal escapes', async () => {
    const mutated = { ...artifacts, previewPdf: await mutatePdfRawInfoWithOctalPath(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/private|path|forbidden|text/i);
  });

  it('rejects a byte-consistent ZIP whose raw PDF Info hex string hides a private path around whitespace and an odd nibble', async () => {
    const mutated = { ...artifacts, previewPdf: await mutatePdfRawInfoWithWhitespaceAndOddNibbleHexPath(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/private|path|forbidden|text/i);
  });

  it('rejects a byte-consistent ZIP whose Info literal mimics a PDF stream around a private path', async () => {
    const mutated = { ...artifacts, previewPdf: await mutatePdfInfoWithStreamLikeLiteralPath(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/private|path|forbidden|text/i);
  });

  it('rejects a byte-consistent ZIP whose PDF Info key is an encoded private-path name', async () => {
    const mutated = { ...artifacts, previewPdf: await mutatePdfInfoWithEncodedNamePath(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/private|path|name|dictionary|canonical|forbidden/i);
  });

  it('rejects a byte-consistent ZIP containing an orphan compressed PDF stream', async () => {
    const mutated = { ...artifacts, previewPdf: await mutatePdfWithOrphanPrivateStream(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/PDF|orphan|object|stream|reachable|canonical/i);
  });

  it('rejects a byte-consistent ZIP containing data after the final PDF EOF marker', async () => {
    const mutated = { ...artifacts, previewPdf: mutatePdfWithPostEofPrivatePath(artifacts.previewPdf) };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/PDF|EOF|envelope|trailing|private|path/i);
  });

  it('rejects executable PDF drawing operators hidden inside a text block with comments', async () => {
    const previewPdf = await mutatePdfContent(output.previewPdf, (content) => content.replace(
      'BT\n',
      'BT\n0 0 0 RG %extra\n0 0 m %extra\n1 1 l %extra\nS %extra\n',
    ));
    const mutated = { ...artifacts, previewPdf };
    mutated.zip = await zipWithArtifacts(mutated);
    await expect(inspectColoredArtifacts(mutated)).rejects.toThrow(/PDF|text|drawing|canonical/i);
  });
});
