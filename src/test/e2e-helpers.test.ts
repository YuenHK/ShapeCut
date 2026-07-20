import { describe, expect, it } from 'vitest';
import { assertExactRemovalRecords, exactlyOneProvenance, exactlyOneSvgRootAttribute, parseDxfRemovalRecords, parsePdfRemovalRecords, parseSvgRemovalRecords, type RemovalRecord } from '../../e2e/helpers';

const records: RemovalRecord[] = [
  { id: 'a', order: 1, index: 4, zStart: 0, zEnd: 1, removedComponentCount: 2 },
  { id: 'b', order: 2, index: 9, zStart: 1, zEnd: 2, removedComponentCount: 2 },
];
const svg = records.map((r) => `<polygon id="${r.id}" data-outline-order="${r.order}" data-outline-index="${r.index}" data-z-start="${r.zStart}" data-z-end="${r.zEnd}" data-removed-component-count="${r.removedComponentCount}"/>`).join('');
const dxf = records.map((r) => `999\nOUTLINE_LAYER:${r.id}:${r.order}:${r.index}:${r.zStart}:${r.zEnd}:4:10x10:${r.removedComponentCount}\n`).join('');
const pdf = records.map((r) => `outline-layer:${r.id}:${r.order}:${r.index}:4:10x10:${r.zStart}:${r.zEnd}:${r.removedComponentCount}`).join(' ');

describe('exact E2E removal record parsers', () => {
  it('parses exact ordered records even when counts are duplicated', () => {
    expect(parseSvgRemovalRecords(svg)).toEqual(records);
    expect(parseDxfRemovalRecords(dxf)).toEqual(records);
    expect(parsePdfRemovalRecords(pdf)).toEqual(records);
  });
  it.each([
    ['missing', records.slice(0, 1)],
    ['extra', [...records, { ...records[1], id: 'c', order: 3, index: 10 }]],
    ['swapped', [records[1], records[0]]],
  ])('rejects %s records against canonical evidence', (_label, candidate) => {
    expect(() => assertExactRemovalRecords(candidate, records)).toThrow(/exactly match/i);
  });
  it('rejects duplicate IDs or indexes during parsing', () => {
    expect(() => parseSvgRemovalRecords(`${svg}${svg}`)).toThrow(/duplicate/i);
    expect(() => parseDxfRemovalRecords(`${dxf}${dxf}`)).toThrow(/duplicate/i);
    expect(() => parsePdfRemovalRecords(`${pdf} ${pdf}`)).toThrow(/duplicate/i);
  });

  it.each([
    ['SVG', parseSvgRemovalRecords, svg, svg.split('/>')[0] + '/>', `${svg}${svg}`, svg.replace('data-outline-index="9"', 'data-outline-index="4"'), `${svg}<polygon data-outline-order="3"/>`, svg.split('/>').reverse().join('/>')],
    ['DXF', parseDxfRemovalRecords, dxf, dxf.split('999\nOUTLINE_LAYER:b')[0], `${dxf}${dxf}`, dxf.replace(':2:9:1:2:', ':2:4:1:2:'), `${dxf}999\nOUTLINE_LAYER:bad\n`, dxf.match(/999\nOUTLINE_LAYER:[\s\S]*?\n(?=999|$)/g)!.reverse().join('')],
    ['PDF', parsePdfRemovalRecords, pdf, pdf.split(' outline-layer:b')[0], `${pdf} ${pdf}`, pdf.replace(':2:9:4:', ':2:4:4:'), `${pdf} outline-layer:bad`, pdf.split(' ').reverse().join(' ')],
  ])('rejects raw %s missing/extra/duplicate/malformed/swapped records', (_label, parser, _valid, missing, extra, duplicate, malformed, swapped) => {
    for (const artifact of [missing, extra, duplicate, malformed, swapped]) {
      expect(() => assertExactRemovalRecords(parser(artifact), records)).toThrow();
    }
  });

  it('rejects malformed and duplicated aggregate/fingerprint markers before value parsing', () => {
    expect(() => exactlyOneProvenance('REMOVED_COMPONENT_COUNT:bad\n', /REMOVED_COMPONENT_COUNT:/g, /REMOVED_COMPONENT_COUNT:(\d+)\n/g, '2', 'DXF')).toThrow();
    expect(() => exactlyOneProvenance('removed-components:2 removed-components:2', /removed-components:/g, /(?:^|\s)removed-components:(\d+)(?=\s|$)/g, '2', 'PDF')).toThrow();
    expect(() => exactlyOneProvenance('<svg data-removal-evidence-fingerprint="bad">', /<svg [^>]*data-removal-evidence-fingerprint=/g, /<svg [^>]*data-removal-evidence-fingerprint="([0-9a-f]+)"/g, 'abcd', 'SVG')).toThrow();
  });

  it('enumerates every SVG polygon and rejects missing, corrupt, or duplicate identifying attributes', () => {
    expect(() => parseSvgRemovalRecords(`${svg}<polygon id="extra"/>`)).toThrow(/exactly one data-outline-order/i);
    for (const name of ['id', 'data-outline-order', 'data-outline-index', 'data-z-start', 'data-z-end', 'data-removed-component-count']) {
      const missing = svg.replace(new RegExp(`\\s${name}="[^"]*"`), '');
      expect(() => parseSvgRemovalRecords(missing)).toThrow();
      const corruptValue = name === 'id' ? 'bad identity' : 'bad';
      const corrupt = svg.replace(new RegExp(`${name}="[^"]*"`), `${name}="${corruptValue}"`);
      expect(() => parseSvgRemovalRecords(corrupt)).toThrow();
      const duplicate = svg.replace(new RegExp(`${name}="([^"]*)"`), `${name}="$1" ${name}="$1"`);
      expect(() => parseSvgRemovalRecords(duplicate)).toThrow(/exactly one|malformed/i);
    }
  });

  it('lexically rejects malformed or duplicate SVG root provenance with whitespace around equals', () => {
    expect(() => exactlyOneSvgRootAttribute('<svg data-removed-component-count = "2">', 'data-removed-component-count', '2')).not.toThrow();
    expect(() => exactlyOneSvgRootAttribute('<svg data-removed-component-count = bad>', 'data-removed-component-count', '2')).toThrow();
    expect(() => exactlyOneSvgRootAttribute('<svg data-removal-evidence-fingerprint="abcd" data-removal-evidence-fingerprint = "abcd">', 'data-removal-evidence-fingerprint', 'abcd')).toThrow();
  });
});
