import { simpleMiterPolygonKernel } from '../domain/layout/polygon-kernel';
import type { ManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { validateManufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { contourBounds, signedArea } from '../domain/outline-2.5d/simplify';
import { LAUNCHER_ASSEMBLY_ALLOWANCE_MM } from '../domain/outline-assembly/launcher';
import { validateLauncherFitOffsetMm } from '../domain/outline-assembly/launcher-fit';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE,
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import type { FeatureContour } from '../domain/outline-features/types';
import { validatePolygon } from '../domain/engraving/geometry';

export const LAUNCHER_COUPON_OFFSETS_MM = [-0.10, -0.05, 0, 0.05, 0.10] as const;

export type LauncherFitCoupon = {
  readonly templateVersion: number;
  readonly templateFingerprint: string;
  readonly materialId: string;
  readonly kerfMm: number;
  readonly openings: readonly {
    readonly fitOffsetMm: number;
    readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour];
    readonly label: string;
  }[];
};

const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const LABELS = Object.freeze(['-0.10 mm', '-0.05 mm', '0.00 mm', '+0.05 mm', '+0.10 mm'] as const);
const MARGIN_MM = 5;
const OPENING_GAP_MM = 5;
const LABEL_GAP_MM = 3;
const LABEL_FONT_MM = 2.5;

type LauncherCouponCheckpoint = (label: string) => void;

function checkDeadline(deadline: number, checkpoint?: LauncherCouponCheckpoint, label = 'checkpoint'): void {
  if (checkpoint) {
    checkpoint(label);
    return;
  }
  if (Number.isNaN(deadline) || Date.now() > deadline) {
    throw new RangeError('Launcher fit coupon exceeded the shared deadline');
  }
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function canonicalCuts(
  fitOffsetMm: number,
  kerfMm: number,
  openingIndex: number,
  deadline: number,
  checkpoint?: LauncherCouponCheckpoint,
): readonly [FeatureContour, FeatureContour, FeatureContour] {
  const validatedOffset = validateLauncherFitOffsetMm(fitOffsetMm);
  const toolpathOffsetMm = LAUNCHER_ASSEMBLY_ALLOWANCE_MM + validatedOffset - kerfMm / 2;
  const geometryDeadline = checkpoint ? Infinity : deadline;
  const cuts: FeatureContour[] = [];
  for (let index = 0; index < OFFICIAL_THREE_PRONG_TEMPLATE.loops.length; index += 1) {
    checkDeadline(deadline, checkpoint, 'geometry-loop');
    const offset = simpleMiterPolygonKernel.offset(
      { points: OFFICIAL_THREE_PRONG_TEMPLATE.loops[index] },
      toolpathOffsetMm,
      () => checkDeadline(deadline, checkpoint, 'offset-point-loop'),
    );
    if (offset.length !== 1 || !validatePolygon(
      offset[0],
      () => checkDeadline(deadline, checkpoint, 'polygon-validation-loop'),
    )) {
      throw new RangeError('Launcher fit coupon opening could not be generated from the official template');
    }
    const outer = offset[0].points;
    cuts.push({
      id: `launcher-coupon-opening-${openingIndex + 1}-cut-${index + 1}`,
      role: 'CUT_BLACK',
      outer,
      boundsMm: contourBounds(
        outer,
        geometryDeadline,
        () => checkDeadline(deadline, checkpoint, 'bounds-point-loop'),
      ),
      areaMm2: Math.abs(signedArea(
        outer,
        geometryDeadline,
        () => checkDeadline(deadline, checkpoint, 'area-point-loop'),
      )),
    });
  }
  if (cuts.length !== 3) throw new RangeError('Launcher fit coupon requires exactly three cuts per opening');
  return cuts as unknown as readonly [FeatureContour, FeatureContour, FeatureContour];
}

function validateLauncherFitCoupon(
  coupon: LauncherFitCoupon,
  deadline = Infinity,
  checkpoint?: LauncherCouponCheckpoint,
): void {
  checkDeadline(deadline, checkpoint, 'validate-start');
  if (!coupon || typeof coupon !== 'object'
    || !exact(Object.keys(coupon).sort(), [
      'kerfMm', 'materialId', 'openings', 'templateFingerprint', 'templateVersion',
    ])
    || coupon.templateVersion !== OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
    || coupon.templateFingerprint !== OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT
    || typeof coupon.materialId !== 'string'
    || !SAFE_PUBLIC_ID.test(coupon.materialId)
    || !Number.isFinite(coupon.kerfMm)
    || coupon.kerfMm < 0
    || !Array.isArray(coupon.openings)
    || coupon.openings.length !== LAUNCHER_COUPON_OFFSETS_MM.length) {
    throw new RangeError('Launcher fit coupon metadata is not canonical');
  }
  for (let index = 0; index < LAUNCHER_COUPON_OFFSETS_MM.length; index += 1) {
    checkDeadline(deadline, checkpoint, 'validate-opening-loop');
    const opening = coupon.openings[index];
    const offset = LAUNCHER_COUPON_OFFSETS_MM[index];
    if (!opening || typeof opening !== 'object'
      || !exact(Object.keys(opening).sort(), ['cuts', 'fitOffsetMm', 'label'])
      || opening.fitOffsetMm !== offset
      || opening.label !== LABELS[index]
      || !Array.isArray(opening.cuts)
      || opening.cuts.length !== 3) {
      throw new RangeError('Launcher fit coupon opening metadata is not canonical');
    }
    const expected = canonicalCuts(offset, coupon.kerfMm, index, deadline, checkpoint);
    if (!exact(opening.cuts, expected)) {
      throw new RangeError('Launcher fit coupon opening geometry is not canonical');
    }
  }
}

export function createLauncherFitCoupon(
  material: ManufacturingGeometryProfile,
  deadline = Infinity,
  checkpoint?: LauncherCouponCheckpoint,
): LauncherFitCoupon {
  checkDeadline(deadline, checkpoint, 'create-start');
  const validated = validateManufacturingGeometryProfile(material);
  if (!SAFE_PUBLIC_ID.test(validated.id)) {
    throw new RangeError('Launcher fit coupon material identity is not safe for a public artifact');
  }
  const coupon: LauncherFitCoupon = {
    templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
    materialId: validated.id,
    kerfMm: validated.kerfMm,
    openings: LAUNCHER_COUPON_OFFSETS_MM.map((fitOffsetMm, index) => ({
      fitOffsetMm: validateLauncherFitOffsetMm(fitOffsetMm),
      cuts: canonicalCuts(fitOffsetMm, validated.kerfMm, index, deadline, checkpoint),
      label: LABELS[index],
    })),
  };
  validateLauncherFitCoupon(coupon, deadline, checkpoint);
  return coupon;
}

function serializeLauncherFitCouponSvg(
  coupon: LauncherFitCoupon,
  deadline: number,
  checkpoint?: LauncherCouponCheckpoint,
): string {
  let cursorX = MARGIN_MM;
  let maximumCutY = MARGIN_MM;
  const cutPolygons: string[] = [];
  const labels: string[] = [];
  for (let openingIndex = 0; openingIndex < coupon.openings.length; openingIndex += 1) {
    checkDeadline(deadline, checkpoint, 'layout-opening-loop');
    const opening = coupon.openings[openingIndex];
    const bounds = opening.cuts.reduce((combined, cut) => ({
      minX: Math.min(combined.minX, cut.boundsMm.minX),
      minY: Math.min(combined.minY, cut.boundsMm.minY),
      maxX: Math.max(combined.maxX, cut.boundsMm.maxX),
      maxY: Math.max(combined.maxY, cut.boundsMm.maxY),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, width, height].every(Number.isFinite)
      || width <= 0 || height <= 0) {
      throw new RangeError('Launcher fit coupon opening bounds are invalid');
    }
    const translateX = cursorX - bounds.minX;
    const translateY = MARGIN_MM - bounds.minY;
    const groupPolygons = opening.cuts.map((cut) => {
      const points = cut.outer.map(([x, y]) => `${x + translateX},${y + translateY}`).join(' ');
      return `<polygon id="${xmlEscape(cut.id)}" data-role="CUT_BLACK" points="${points}" fill="none" stroke="#000000"/>`;
    }).join('');
    cutPolygons.push(
      `<g id="launcher-coupon-opening-${openingIndex + 1}" data-fit-offset-mm="${opening.fitOffsetMm}">${groupPolygons}</g>`,
    );
    const labelX = cursorX + width / 2;
    const labelY = MARGIN_MM + height + LABEL_GAP_MM + LABEL_FONT_MM;
    labels.push(
      `<text id="launcher-coupon-label-${openingIndex + 1}" data-role="DEEP_RED" data-fit-offset-mm="${opening.fitOffsetMm}" x="${labelX}" y="${labelY}" text-anchor="middle" font-size="${LABEL_FONT_MM}" fill="#E5484D">${xmlEscape(opening.label)}</text>`,
    );
    maximumCutY = Math.max(maximumCutY, MARGIN_MM + height);
    cursorX += width + OPENING_GAP_MM;
  }
  const width = cursorX - OPENING_GAP_MM + MARGIN_MM;
  const height = maximumCutY + LABEL_GAP_MM + LABEL_FONT_MM + MARGIN_MM;
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new RangeError('Launcher fit coupon layout is invalid');
  }
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" data-template-version="${coupon.templateVersion}" data-template-fingerprint="${coupon.templateFingerprint}" data-material-id="${xmlEscape(coupon.materialId)}" data-kerf-mm="${coupon.kerfMm}" data-offsets-mm="${LAUNCHER_COUPON_OFFSETS_MM.join(',')}"><g id="CUT_BLACK" data-role="CUT_BLACK" data-color="#000000" data-entity-count="15">${cutPolygons.join('')}</g><g id="DEEP_RED" data-role="DEEP_RED" data-color="#E5484D" data-entity-count="5">${labels.join('')}</g></svg>`;
}

export function writeLauncherFitCouponSvg(
  coupon: LauncherFitCoupon,
  deadline = Infinity,
  checkpoint?: LauncherCouponCheckpoint,
): string {
  validateLauncherFitCoupon(coupon, deadline, checkpoint);
  return serializeLauncherFitCouponSvg(coupon, deadline, checkpoint);
}

export function verifyLauncherFitCouponSvg(
  svg: string,
  coupon: LauncherFitCoupon,
  deadline = Infinity,
  checkpoint?: LauncherCouponCheckpoint,
): void {
  validateLauncherFitCoupon(coupon, deadline, checkpoint);
  if (typeof svg !== 'string' || svg !== serializeLauncherFitCouponSvg(coupon, deadline, checkpoint)) {
    throw new RangeError('Launcher fit coupon SVG grammar, metadata, geometry, role, label, or EOF is not canonical');
  }
}
