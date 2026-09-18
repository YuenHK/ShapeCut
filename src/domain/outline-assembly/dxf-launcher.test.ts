import { describe, expect, it } from 'vitest';
import { OFFICIAL_THREE_PRONG_TEMPLATE, signedArea } from './launcher-template';
import { validatePolygon } from '../engraving/geometry';

describe('physical DXF launcher reference', () => {
  it('uses a new version and three closed, clockwise manufacturing contours', () => {
    expect(OFFICIAL_THREE_PRONG_TEMPLATE.version).toBe(3);
    expect(OFFICIAL_THREE_PRONG_TEMPLATE.loops).toHaveLength(3);
    for (const loop of OFFICIAL_THREE_PRONG_TEMPLATE.loops) {
      expect(validatePolygon({ points: loop })).toBe(true);
      expect(signedArea(loop)).toBeLessThan(0);
      const radii = loop.map(([x,y]) => Math.hypot(x,y));
      expect(Math.min(...radii)).toBeCloseTo(10.5, 5);
      expect(Math.max(...radii)).toBeCloseTo(14, 4);
      expect(Math.abs(signedArea(loop))).toBeCloseTo(69.6558, 3);
      // Original reference has a small endpoint gap, closed by a short segment.
      const lengths = loop.map((p,i) => Math.hypot(p[0]-loop[(i+1)%loop.length][0], p[1]-loop[(i+1)%loop.length][1]));
      expect(Math.min(...lengths)).toBeCloseTo(0.011149247, 7);
    }
  });
  it('retains the DXF threefold rotation without scaling or mirroring', () => {
    const loops = OFFICIAL_THREE_PRONG_TEMPLATE.loops;
    for (let i = 1; i < 3; i++) {
      const a = i * 2 * Math.PI / 3;
      expect(loops[i]).toHaveLength(loops[0].length);
      loops[0].forEach(([x,y],j) => {
        expect(loops[i][j][0]).toBeCloseTo(x*Math.cos(a)-y*Math.sin(a), 7);
        expect(loops[i][j][1]).toBeCloseTo(x*Math.sin(a)+y*Math.cos(a), 7);
      });
    }
  });
});
