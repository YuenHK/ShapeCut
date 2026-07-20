import { describe, expect, it } from 'vitest';
import { assertExactRemovalRecords, parseDxfRemovalRecords, parsePdfRemovalRecords, parseSvgRemovalRecords, type RemovalRecord } from '../../e2e/helpers';

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
});
