import { mkdir, writeFile } from 'node:fs/promises';
import { createCalibrationCoupon } from '../src/domain/materials/calibration-coupon';
import type { MaterialProfileV1 } from '../src/domain/materials/schema';

const recipes = {
  cut: { powerPercent: 50, speedMmPerSecond: 20, passes: 1, notes: 'Unverified starting point; replace using manufacturer guidance.' },
  score: null,
  engrave1: { powerPercent: 10, speedMmPerSecond: 100, passes: 1, notes: 'Unverified level 1.' },
  engrave2: { powerPercent: 15, speedMmPerSecond: 100, passes: 1, notes: 'Unverified level 2.' },
  engrave3: { powerPercent: 20, speedMmPerSecond: 100, passes: 1, notes: 'Unverified level 3.' },
  engrave4: null,
  engrave5: null,
} satisfies MaterialProfileV1['recipes'];

const common = {
  schemaVersion: 1 as const, machine: 'REPLACE-WITH-MACHINE', batchNotes: 'PRE-CALIBRATION BATCH - replace with exact lot',
  thicknessMm: 3, sheetWidthMm: 300, sheetHeightMm: 200, kerfMm: 0.15,
  fitAllowanceMm: { loose: 0.2, slip: 0.12, snug: 0.06, press: 0 }, minFeatureMm: 0.8, minWebMm: 1.6, minRemainingMm: 1.2,
  recipes, calibratedAt: null, physicalCouponVerified: false,
};
const profiles: MaterialProfileV1[] = [
  { ...common, id: 'pending-plywood-3', materialCode: 'BIRCH-PLY-PENDING', materialName: 'Laser-approved birch plywood pending batch verification', safetyEvidence: { kind: 'allowlisted', category: 'laser-approved-plywood', compositionKnown: true, manufacturer: 'REPLACE', productId: 'BIRCH-PLY-PENDING', laserSafetyReference: 'https://manufacturer.invalid/replace-before-use' } },
  { ...common, id: 'pending-cardboard-3', materialCode: 'CARDBOARD-PENDING', materialName: 'Cardboard pending batch verification', safetyEvidence: { kind: 'allowlisted', category: 'cardboard', compositionKnown: true, manufacturer: 'REPLACE', productId: 'CARDBOARD-PENDING', laserSafetyReference: 'https://manufacturer.invalid/replace-before-use' } },
  { ...common, id: 'pending-cast-pmma-3', materialCode: 'CAST-PMMA-PENDING', materialName: 'Vendor-confirmed cast PMMA pending product verification', safetyEvidence: { kind: 'allowlisted', category: 'laser-rated-cast-acrylic', compositionKnown: true, manufacturer: 'REPLACE', productId: 'CAST-PMMA-PENDING', laserSafetyReference: 'https://manufacturer.invalid/replace-before-use' } },
];

const polygon = ({ points }: { points: readonly (readonly [number, number])[] }) => points.map(([x, y]) => `${x},${y}`).join(' ');
const target = new URL('../fixtures/acceptance/material-coupons/', import.meta.url);
await mkdir(target, { recursive: true });
for (const profile of profiles) {
  const coupon = createCalibrationCoupon(profile, 3);
  const cut = [coupon.outline, ...coupon.fitSamples.map(({ polygon }) => polygon), coupon.kerfFeature.polygon].map((item) => `<polygon points="${polygon(item)}"/>`).join('');
  const engrave = coupon.engravingSwatches.map(({ level, polygon: shape }) => `<g id="layer-ENGRAVE_${level}"><polygon points="${polygon(shape)}"/></g>`).join('');
  const labels = coupon.labels.map(({ text, position }) => `<text x="${position[0]}" y="${position[1]}" font-size="2">${text.replaceAll('&', '&amp;')}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="${coupon.outline.points[2][1]}mm" viewBox="0 0 120 ${coupon.outline.points[2][1]}"><g id="layer-CUT">${cut}</g>${engrave}<g id="layer-ANNOTATION">${labels}</g></svg>`;
  await writeFile(new URL(`${profile.id}-coupon.svg`, target), svg);
}
