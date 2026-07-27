import { describe, expect, it } from 'vitest';
import { simpleMiterPolygonKernel } from '../domain/layout/polygon-kernel';
import { LAUNCHER_ASSEMBLY_ALLOWANCE_MM } from '../domain/outline-assembly/launcher';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE,
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import type { ManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import {
  createLauncherFitCoupon,
  LAUNCHER_COUPON_OFFSETS_MM,
  writeLauncherFitCouponSvg,
} from './launcher-fit-coupon';

const readyMaterial: ManufacturingGeometryProfile = {
  id: 'plywood-3',
  name: '3 mm plywood geometry estimate',
  thicknessMm: 3,
  kerfMm: 0.15,
  minFeatureMm: 0.8,
  minWebMm: 0.7,
  fitAllowanceMm: { loose: 0.2, slip: 0.1, snug: 0, press: -0.1 },
};

describe('launcher fit calibration coupon', () => {
  it('creates five labelled openings from the fixed template and selected kerf', () => {
    const coupon = createLauncherFitCoupon(readyMaterial);

    expect(coupon.openings.map(({ fitOffsetMm }) => fitOffsetMm))
      .toEqual([-0.10, -0.05, 0, 0.05, 0.10]);
    expect(coupon.openings.map(({ label }) => label))
      .toEqual(['-0.10 mm', '-0.05 mm', '0.00 mm', '+0.05 mm', '+0.10 mm']);
    expect(coupon.openings.every(({ cuts }) => cuts.length === 3)).toBe(true);
    expect(coupon.openings.flatMap(({ cuts }) => cuts).every(({ role }) => role === 'CUT_BLACK')).toBe(true);
    expect(coupon.templateVersion).toBe(OFFICIAL_THREE_PRONG_TEMPLATE_VERSION);
    expect(coupon.templateFingerprint).toBe(OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT);
    expect(coupon.materialId).toBe(readyMaterial.id);
    expect(coupon.kerfMm).toBe(readyMaterial.kerfMm);
  });

  it('applies each finished fit and half-kerf toolpath offset once to the fixed template', () => {
    const coupon = createLauncherFitCoupon(readyMaterial);
    for (const opening of coupon.openings) {
      const toolpathOffsetMm = LAUNCHER_ASSEMBLY_ALLOWANCE_MM
        + opening.fitOffsetMm
        - readyMaterial.kerfMm / 2;
      for (let index = 0; index < OFFICIAL_THREE_PRONG_TEMPLATE.loops.length; index += 1) {
        const expected = simpleMiterPolygonKernel.offset(
          { points: OFFICIAL_THREE_PRONG_TEMPLATE.loops[index] },
          toolpathOffsetMm,
        );
        expect(expected).toHaveLength(1);
        expect(opening.cuts[index].outer).toEqual(expected[0].points);
      }
    }
  });

  it('writes one deterministic fully-labelled SVG with exact canonical metadata and roles', () => {
    const coupon = createLauncherFitCoupon(readyMaterial);
    const svg = writeLauncherFitCouponSvg(coupon);

    expect(writeLauncherFitCouponSvg(createLauncherFitCoupon(readyMaterial))).toBe(svg);
    expect(svg).toContain('data-template-version="1"');
    expect(svg).toContain(`data-template-fingerprint="${OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT}"`);
    expect(svg).toContain('data-material-id="plywood-3"');
    expect(svg).toContain('data-kerf-mm="0.15"');
    expect(svg.match(/<polygon /g)).toHaveLength(15);
    expect(svg.match(/data-role="CUT_BLACK"/g)).toHaveLength(16);
    expect(svg.match(/<text /g)).toHaveLength(5);
    expect(svg.match(/data-role="DEEP_RED"/g)).toHaveLength(6);
    for (const offset of LAUNCHER_COUPON_OFFSETS_MM) {
      expect(svg).toContain(`data-fit-offset-mm="${offset}"`);
    }
    for (const label of ['-0.10 mm', '-0.05 mm', '0.00 mm', '+0.05 mm', '+0.10 mm']) {
      expect(svg).toContain(`>${label}</text>`);
    }
    expect(svg).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><svg[\s\S]*<\/svg>$/);
    expect(svg).not.toMatch(/internalValidationEvidence|launcherDecoration|provisional|minimumStructuralClearance|decorationOverlap/i);
  });

  it.each([
    ['material ID', { ...readyMaterial, id: 'bad" onload="private' }],
    ['kerf', { ...readyMaterial, kerfMm: Number.NaN }],
  ])('rejects an unsafe %s instead of serializing it', (_label, material) => {
    expect(() => createLauncherFitCoupon(material)).toThrow();
  });
});
