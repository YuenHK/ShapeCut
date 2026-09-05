import { describe, expect, it } from 'vitest';
import type { Point2 } from '../decomposition/types';
import { validatePolygon } from '../engraving/geometry';
import { KNIGHT_FORTRESS_LAUNCHER_TEMPLATE, OFFICIAL_THREE_PRONG_TEMPLATE, signedArea } from './launcher-template';

function distanceToLoop(point: Point2, loop: readonly Point2[]): number {
  return Math.min(...loop.map((start,index)=>{
    const end=loop[(index+1)%loop.length];
    const dx=end[0]-start[0],dy=end[1]-start[1];
    const t=Math.max(0,Math.min(1,((point[0]-start[0])*dx+(point[1]-start[1])*dy)/(dx*dx+dy*dy)));
    return Math.hypot(point[0]-start[0]-t*dx,point[1]-start[1]-t*dy);
  }));
}

function denseBoundary(loop: readonly Point2[]): readonly Point2[] {
  return loop.flatMap((a,index)=>{
    const b=loop[(index+1)%loop.length];
    const count=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.005);
    return Array.from({length:count},(_,i):Point2=>[a[0]+(b[0]-a[0])*i/count,a[1]+(b[1]-a[1])*i/count]);
  });
}

describe('rounded three-prong manufacturing template',()=>{
  it('versions the derived geometry separately from the retained source template',()=>{
    expect(KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.version).toBe(1);
    expect(OFFICIAL_THREE_PRONG_TEMPLATE.version).toBe(2);
  });

  it('uses three identical simple loops at exactly 120 degree intervals',()=>{
    const loops=OFFICIAL_THREE_PRONG_TEMPLATE.loops;
    expect(loops).toHaveLength(3);
    loops.forEach((loop,index)=>{
      expect(validatePolygon({points:loop})).toBe(true);
      expect(loop).toHaveLength(96);
      const angle=index*2*Math.PI/3;
      loop.forEach(([x,y],pointIndex)=>{
        const [baseX,baseY]=loops[0][pointIndex];
        expect(x).toBeCloseTo(baseX*Math.cos(angle)-baseY*Math.sin(angle),8);
        expect(y).toBeCloseTo(baseX*Math.sin(angle)+baseY*Math.cos(angle),8);
      });
    });
  });

  it('places every boundary point on a circular arc or rounded end cap',()=>{
    OFFICIAL_THREE_PRONG_TEMPLATE.loops.forEach((loop,index)=>{
      const phase=(.2+120*index)*Math.PI/180,halfSpan=54.6*Math.PI/180;
      for(const [x,y] of loop){
        const px=x*Math.cos(phase)+y*Math.sin(phase),py=-x*Math.sin(phase)+y*Math.cos(phase);
        const angle=Math.max(-halfSpan,Math.min(halfSpan,Math.atan2(py,px)));
        expect(Math.hypot(px-21.5*Math.cos(angle),py-21.5*Math.sin(angle))).toBeCloseTo(1.41,8);
      }
    });
  });

  it('keeps bounded deviation from the source loops without claiming physical calibration',()=>{
    OFFICIAL_THREE_PRONG_TEMPLATE.loops.forEach((loop,index)=>{
      const original=KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.loops[index];
      const distances=[...denseBoundary(original).map(p=>distanceToLoop(p,loop)),...denseBoundary(loop).map(p=>distanceToLoop(p,original))];
      expect(distances.reduce((sum,value)=>sum+value,0)/distances.length).toBeLessThanOrEqual(.5);
      // Redesign bound, NOT fit tolerance: removing source notches changes local
      // boundaries by ~1.99 mm. Nearest sample is at most half the 0.005 mm
      // spacing away; distance-to-boundary is 1-Lipschitz on each segment.
      expect(Math.max(...distances) + .0025).toBeLessThanOrEqual(2);
      expect(Math.abs(Math.abs(signedArea(loop))/Math.abs(signedArea(original))-1)).toBeLessThanOrEqual(.1);
    });
  });
});
