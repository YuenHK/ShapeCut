import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { coloredResult } from './colored-outline-test-fixture';
import { createOutlinePackage, verifyOutlinePackage } from './outline-package';
import { parseColoredOutlineDxf, parseColoredOutlineSvg } from './package';

afterEach(()=>vi.unstubAllGlobals());
describe('canonical engraved package',()=>{
  it('exports shared vector entities, correct SVG orientation, explicit layer and intentional settings only',async()=>{
    const data=readFileSync('src/domain/part-engraving/assets/NotoSansCJKtc-Regular.otf');
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(data)));
    const result=coloredResult(),engraving={name:'1A99',workName:'破滅魔劍'};
    const output=await createOutlinePackage(result,Infinity,{engraving});
    expect(output.cutSvg).toContain('ENGRAVE_TEXT');
    expect(output.cutSvg).toMatch(/transform="translate\(0 [\d.]+\) scale\(1 -1\)"/);
    expect(output.cutSvg).not.toContain('破滅');
    expect(output.cutSvg).not.toContain('<text');
    expect(output.cutDxf).not.toContain('\nTEXT\n');
    const svg=parseColoredOutlineSvg(output.cutSvg),dxf=parseColoredOutlineDxf(output.cutDxf);
    expect(svg).toEqual(dxf);
    expect(svg.filter(e=>e.role==='ENGRAVE_TEXT').length).toBeGreaterThan(6);
    expect(JSON.parse(output.projectJson).engraving.settings).toEqual(engraving);
    const zip=await JSZip.loadAsync(output.zip);
    expect(await zip.file('cut-and-engrave.svg')!.async('string')).toBe(output.cutSvg);
    await expect(verifyOutlinePackage(output,result,Infinity,{engraving:{...engraving,name:'1A98'}})).rejects.toThrow();
    await expect(verifyOutlinePackage({...output,cutSvg:output.cutSvg.replace('scale(1 -1)','scale(-1 -1)')},result,Infinity,{engraving})).rejects.toThrow();
    const blank=await createOutlinePackage(result,Infinity,{engraving:{name:' ',workName:''}});
    const legacy=await createOutlinePackage(result,Infinity);
    expect(blank.cutSvg).toBe(legacy.cutSvg);
    expect(blank.cutDxf).toBe(legacy.cutDxf);
    expect(blank.projectJson).toBe(legacy.projectJson);
    expect(parseColoredOutlineSvg(blank.cutSvg)).toEqual(svg.filter(e=>e.role!=='ENGRAVE_TEXT'));
    expect(blank.launcherCouponSvg).toBe(output.launcherCouponSvg);
  },30000);
});
