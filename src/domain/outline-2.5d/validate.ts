import { isSimplePolygon } from '../decomposition/polygon-validation';
import type { OutlineLayer } from './extract';
import { signedArea } from './simplify';

export type OutlineValidation = { readonly ok: boolean; readonly reasons: readonly string[] };

export function validateOutlineLayer(layer: OutlineLayer): OutlineValidation {
  const reasons: string[] = [], points = layer.contour.outer;
  if (!Number.isInteger(layer.index) || layer.index < 0) reasons.push('Layer index must be a non-negative integer');
  if (![layer.zStart, layer.zEnd].every(Number.isFinite) || layer.zEnd <= layer.zStart) reasons.push('Layer Z interval must be finite and positive');
  if (layer.contour.holes.length !== 0) reasons.push('Outline layers must not contain holes');
  if (points.length > 4096) reasons.push('Contour exceeds 4096 points');
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) reasons.push('Contour coordinates must be finite');
  const unique = new Set(points.map(([x, y]) => `${x}:${y}`));
  if (unique.size < 3) reasons.push('Contour requires at least three unique points');
  if (points.some((point, index) => {
    const next = points[(index + 1) % points.length];
    return point[0] === next?.[0] && point[1] === next?.[1];
  })) reasons.push('Contour has a zero-length edge or adjacent duplicate point');
  const area = points.length >= 3 && points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) ? signedArea(points) : 0;
  if (!Number.isFinite(area) || area >= 0) reasons.push('Contour must have positive geometric area and clockwise winding');
  if (points.length >= 3 && points.length <= 4096 && reasons.every((reason) => !reason.includes('finite'))
    && !isSimplePolygon({ points })) reasons.push('Contour self-intersects');
  if (!Number.isFinite(layer.sourceAreaMm2) || layer.sourceAreaMm2 <= 0
    || !Number.isFinite(layer.simplifiedAreaMm2) || layer.simplifiedAreaMm2 <= 0) {
    reasons.push('Contour areas must be finite and positive');
  } else if (Math.abs(layer.simplifiedAreaMm2 - layer.sourceAreaMm2) / layer.sourceAreaMm2 > 0.03 + 1e-12) {
    reasons.push('Simplified contour area drift exceeds three percent');
  }
  return { ok: reasons.length === 0, reasons };
}
