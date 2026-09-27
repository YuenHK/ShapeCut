import type { Font } from 'opentype.js';
import type { Point2 } from '../decomposition/types';
import { contourBounds, signedArea } from '../outline-2.5d/simplify';
import { glyphOutlines, type EngravingGlyph } from './font';
import { EngravingError, hasEngravingText, normalizeEngravingSettings, type EngravingSettings } from './settings';

export type EngravingContour = { readonly id: string; readonly role: 'ENGRAVE_TEXT'; readonly outer: readonly Point2[]; readonly boundsMm: ReturnType<typeof contourBounds>; readonly areaMm2: number };
export type EngravingLayer = { readonly id: string; readonly zStart: number; readonly zEnd: number; readonly cuts: readonly (readonly Point2[])[]; readonly decorations: readonly (readonly Point2[])[] };
export type PartEngraving = { readonly layerId: string; readonly part: string; readonly contours: readonly EngravingContour[] };
const cross = (a: Point2, b: Point2, c: Point2) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function pointDistance(p: Point2, a: Point2, b: Point2): number {
  const dx=b[0]-a[0],dy=b[1]-a[1], length=dx*dx+dy*dy;
  const t=length ? Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) : 0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
function segmentDistance(a: Point2,b: Point2,c: Point2,d: Point2): number {
  if (cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) return 0;
  return Math.min(pointDistance(a,c,d),pointDistance(b,c,d),pointDistance(c,a,b),pointDistance(d,a,b));
}
function inside(p: Point2, loop: readonly Point2[]): boolean {
  let result=false;
  for(let i=0,j=loop.length-1;i<loop.length;j=i++) {
    const a=loop[i],b=loop[j];
    if ((a[1]>p[1]) !== (b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) result=!result;
  }
  return result;
}
export function isSafeEngravingLoop(loop: readonly Point2[], layer: EngravingLayer, checkpoint: () => void = () => undefined): boolean {
  if (loop.length<3 || !layer.cuts.length) return false;
  if (!inside(loop[0],layer.cuts[0])) return false;
  for (const hole of layer.cuts.slice(1)) if (inside(loop[0],hole) || inside(hole[0],loop)) return false;
  for (const decoration of layer.decorations) if (inside(loop[0],decoration) || inside(decoration[0],loop)) return false;
  for (const boundary of [...layer.cuts,...layer.decorations]) {
    for(let i=0;i<loop.length;i++) {
      if ((i&31)===0) checkpoint();
      const a=loop[i],b=loop[(i+1)%loop.length];
      for(let j=0;j<boundary.length;j++) {
        const c=boundary[j],d=boundary[(j+1)%boundary.length];
        // Broad-phase rejects only provably distant boxes; narrow phase checks entire segments.
        if(Math.max(a[0],b[0])+1.000001<Math.min(c[0],d[0]) || Math.max(c[0],d[0])+1.000001<Math.min(a[0],b[0])
          || Math.max(a[1],b[1])+1.000001<Math.min(c[1],d[1]) || Math.max(c[1],d[1])+1.000001<Math.min(a[1],b[1])) continue;
        if(segmentDistance(a,b,c,d)<1.000001) return false;
      }
    }
  }
  return true;
}
export function planPartEngraving(layers: readonly EngravingLayer[], input: EngravingSettings, font: Font, checkpoint: () => void = () => undefined): PartEngraving[] {
  const settings=normalizeEngravingSettings(input);
  if(!hasEngravingText(settings)) return [];
  if(layers.length>24) throw new EngravingError('刻字切片數量超出上限');
  const ranks=[...layers].sort((a,b)=>b.zEnd-a.zEnd || b.zStart-a.zStart);
  return layers.map(layer=>{
    const rank=ranks.indexOf(layer),part=`Part${String.fromCharCode(65+rank)}`;
    let glyphs: EngravingGlyph[];
    try { glyphs=glyphOutlines(font,[settings.name,settings.workName,part].filter(Boolean).join(' ')); }
    catch (error) {
      if(error instanceof EngravingError) throw new EngravingError(`${part}：${error.message}`);
      throw error;
    }
    const width=glyphs.reduce((sum,g)=>sum+g.advance+0.12,0);
    const box=contourBounds(layer.cuts[0]),cx=(box.minX+box.maxX)/2,cy=(box.minY+box.maxY)/2;
    const maximumRadius=Math.min(box.maxX-box.minX,box.maxY-box.minY)/2-4.2;
    // Fixed bounded search: 8 near-edge rings x 48 angular positions, never scale glyphs down.
    for(let ring=0;ring<8;ring++) {
      const radius=maximumRadius-ring*0.75;
      if(radius<3 || width/radius>Math.PI*1.7) continue;
      for(let candidate=0;candidate<48;candidate++) {
        checkpoint();
        const centerAngle=Math.PI/2+candidate*Math.PI*2/48;
        let cursor=-width/2,loopIndex=0;
        const contours: EngravingContour[]=[];
        let safe=true;
        for(const glyph of glyphs) {
          const angle=centerAngle-(cursor+glyph.advance/2)/radius;
          const tangent=angle-Math.PI/2,cos=Math.cos(tangent),sin=Math.sin(tangent);
          const origin: Point2=[cx+radius*Math.cos(angle),cy+radius*Math.sin(angle)];
          for(const loop of glyph.loops) {
            const outer=loop.map(([x,y])=>[origin[0]+(x-glyph.advance/2)*cos-y*sin,origin[1]+(x-glyph.advance/2)*sin+y*cos] as Point2);
            if(!isSafeEngravingLoop(outer,layer,checkpoint)) { safe=false;break; }
            contours.push({id:`engraving-${rank}-${loopIndex++}`,role:'ENGRAVE_TEXT',outer,boundsMm:contourBounds(outer),areaMm2:Math.abs(signedArea(outer))});
          }
          if(!safe) break;
          cursor+=glyph.advance+0.12;
        }
        if(safe && contours.length) return {layerId:layer.id,part,contours};
      }
    }
    throw new EngravingError(`${part} 沒有足夠空間放置完整刻字（3 mm、切割間隔 1 mm）；請縮短文字或清空兩欄`);
  });
}
