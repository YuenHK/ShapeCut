import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEngravingFont, glyphOutlines } from './font';
import { planPartEngraving, isSafeEngravingLoop } from './layout';

const bytes = readFileSync('src/domain/part-engraving/assets/NotoSansCJKtc-Regular.otf');
const font = () => parseEngravingFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const square = [[-30,-30],[-30,30],[30,30],[30,-30]] as const;
const layer = (id: string, z: number) => ({ id, zStart: z, zEnd: z + 6,
  cuts: [square, [[-2,-2],[2,-2],[2,2],[-2,2]] as const], decorations: [] });

describe('offline outlined engraving', () => {
  it('preserves counter loops and proportional 3 mm outlines for Traditional Chinese', () => {
    const outlines = glyphOutlines(font(), '1A99 破滅魔劍 PartA');
    expect(outlines.length).toBe(15);
    expect(outlines.find(g => g.character === 'A')!.loops.length).toBeGreaterThan(1);
    expect(outlines.find(g => g.character === '破')!.advance).toBe(3);
  });
  it('rejects missing glyphs and malformed fonts explicitly', () => {
    expect(() => glyphOutlines(font(), '🫠')).toThrow(/缺字/);
    expect(() => parseEngravingFont(new ArrayBuffer(4))).toThrow(/字型/);
  });
  it('ranks by geometric height and retains all loops inside every layer', () => {
    const layers = [layer('middle',6),layer('bottom',0),layer('top',12)];
    const plan = planPartEngraving(layers, {name:'1A99',workName:'破滅魔劍'},font());
    expect(plan.map(p => [p.layerId,p.part])).toEqual([['middle','PartB'],['bottom','PartC'],['top','PartA']]);
    for (const p of plan) for(const contour of p.contours) expect(isSafeEngravingLoop(contour.outer,layers[0])).toBe(true);
  });
  it('fails the complete package on a small or decoration-filled layer', () => {
    const tiny = { ...layer('small',0), cuts: [[[0,0],[0,4],[4,4],[4,0]] as const] };
    expect(() => planPartEngraving([tiny],{name:'1A99',workName:''},font())).toThrow(/PartA/);
    const blocked = { ...layer('blocked',0), decorations:[square] };
    expect(() => planPartEngraving([blocked],{name:'A',workName:''},font())).toThrow(/PartA/);
  });
  it('checks whole segments crossing a hole even when endpoints are safe', () => {
    expect(isSafeEngravingLoop([[-5,0],[5,0],[5,5],[-5,5]], layer('test',0))).toBe(false);
  });
  it('identifies the affected Part for missing glyphs and rejects long complete lines', () => {
    expect(() => planPartEngraving([layer('test',0)],{name:'🫠',workName:''},font())).toThrow(/PartA.*缺字/);
    expect(() => planPartEngraving([layer('test',0)],{name:'字'.repeat(24),workName:'字'.repeat(24)},font())).toThrow(/PartA/);
  });
  it('rejects a concave notch that crosses a segment while vertices remain in solid material', () => {
    const notched={...layer('notched',0),cuts:[[[0,0],[0,10],[4,10],[4,4],[6,4],[6,10],[10,10],[10,0]] as const]};
    expect(isSafeEngravingLoop([[2,2],[8,2],[8,7],[2,7]],notched)).toBe(false);
  });
});
