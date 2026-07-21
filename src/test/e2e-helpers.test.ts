import JSZip from 'jszip';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, rgb } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  inspectColoredArtifacts,
  parseColoredOutlineDxfArtifact,
  parseColoredOutlinePdf,
  parseColoredOutlineSvgArtifact,
  parseColoredZipRecords,
  type ColoredArtifactPayloads,
} from '../../e2e/helpers';
import { coloredResult } from '../export/colored-outline-test-fixture';
import { createOutlinePackage, type ColoredOutlinePackage } from '../export/outline-package';

let output: ColoredOutlinePackage;
let artifacts: ColoredArtifactPayloads;

beforeAll(async () => {
  output = await createOutlinePackage(coloredResult());
  artifacts = {
    zip: output.zip,
    svg: output.cutSvg,
    dxf: output.cutDxf,
    previewPdf: output.previewPdf,
    explodedPdf: output.explodedViewPdf,
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
  page.node.set(PDFName.of('Contents'), replacement);
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

async function zipWithArtifacts(value: ColoredArtifactPayloads): Promise<Uint8Array> {
  const zip = new JSZip(), date = new Date('2000-01-01T00:00:00.000Z');
  zip.file('cut-and-engrave.svg', value.svg, { date });
  zip.file('cut-and-engrave.dxf', value.dxf, { date });
  zip.file('preview.pdf', value.previewPdf, { date });
  zip.file('exploded-view.pdf', value.explodedPdf, { date });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('release E2E colored artifact parsers', () => {
  it('parses every SVG role group/entity and every DXF layer/entity in encounter order', () => {
    const svg = parseColoredOutlineSvgArtifact(output.cutSvg);
    const dxf = parseColoredOutlineDxfArtifact(output.cutDxf);

    expect(svg.layers.map(({ order }) => order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(svg.entities.map(({ id }) => id)).toEqual(dxf.entities.map(({ id }) => id));
    expect(svg.entities).toEqual(dxf.entities);
    expect(svg.entityCounts).toEqual({ CUT_BLACK: 7, DEEP_RED: 1, LIGHT_BLUE: 1 });
    expect(svg.layers.flatMap(({ roleGroups }) => roleGroups.map(({ role }) => role)))
      .toEqual(Array.from({ length: 6 }, () => ['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE']).flat());
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
  });

  it('enumerates the exact four ZIP records in encounter order and reconciles byte identity', async () => {
    const zip = await parseColoredZipRecords(output.zip);
    expect(zip.map(({ name }) => name)).toEqual([
      'cut-and-engrave.svg',
      'cut-and-engrave.dxf',
      'preview.pdf',
      'exploded-view.pdf',
    ]);

    const inspected = await inspectColoredArtifacts(artifacts);
    expect(inspected.entities).toEqual(parseColoredOutlineSvgArtifact(output.cutSvg).entities);
    expect(inspected.zipRecords.every(({ byteIdentical }) => byteIdentical)).toBe(true);
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
    expect(Object.keys((await JSZip.loadAsync(duplicate)).files)).toHaveLength(4);
    await expect(parseColoredZipRecords(duplicate)).rejects.toThrow(/four|duplicate|record/i);
  });

  it('rejects an orphan local ZIP record not referenced by the central directory', async () => {
    const orphan = insertOrphanLocalRecord(output.zip);
    expect(Object.keys((await JSZip.loadAsync(orphan)).files)).toHaveLength(4);
    await expect(parseColoredZipRecords(orphan)).rejects.toThrow(/local|coverage|record/i);
  });

  it('rejects unsafe ZIP names using both raw and sanitized identities', async () => {
    const zip = new JSZip();
    zip.file('../cut-and-engrave.svg', output.cutSvg, { createFolders: false });
    zip.file('cut-and-engrave.dxf', output.cutDxf);
    zip.file('preview.pdf', output.previewPdf);
    zip.file('exploded-view.pdf', output.explodedViewPdf);
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
