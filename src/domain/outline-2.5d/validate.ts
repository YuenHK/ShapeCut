import type { Point2 } from '../decomposition/types';
import type { OutlineLayer } from './extract';
import { contourBounds, signedArea } from './simplify';

export type OutlineValidation = { readonly ok: boolean; readonly reasons: readonly string[] };

const RUNTIME_REASON = 'Contour validation exceeded the runtime budget';

function expired(deadline: number): boolean {
  return Date.now() > deadline;
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2, areaTolerance: number, lengthTolerance: number): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const onSegment = (p: Point2, q: Point2, r: Point2) => Math.abs(cross(p, q, r)) <= areaTolerance
    && r[0] >= Math.min(p[0], q[0]) - lengthTolerance && r[0] <= Math.max(p[0], q[0]) + lengthTolerance
    && r[1] >= Math.min(p[1], q[1]) - lengthTolerance && r[1] <= Math.max(p[1], q[1]) + lengthTolerance;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function isSimpleWithinDeadline(points: readonly Point2[], deadline: number): boolean | undefined {
  let scale = Number.MIN_VALUE;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0 && expired(deadline)) return undefined;
    scale = Math.max(scale, Math.abs(points[index][0]), Math.abs(points[index][1]));
  }
  const areaTolerance = scale * scale * 64 * Number.EPSILON;
  const lengthTolerance = scale * 64 * Number.EPSILON;
  for (let first = 0; first < points.length; first += 1) {
    if ((first & 15) === 0 && expired(deadline)) return undefined;
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      if ((second & 63) === 0 && expired(deadline)) return undefined;
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext], areaTolerance, lengthTolerance)) return false;
    }
  }
  return true;
}

export function validateOutlineLayer(layer: OutlineLayer, deadline = Infinity): OutlineValidation {
  const reasons: string[] = [], points = layer.contour.outer;
  if (expired(deadline)) return { ok: false, reasons: [RUNTIME_REASON] };
  if (!Number.isInteger(layer.index) || layer.index < 0) reasons.push('Layer index must be a non-negative integer');
  if (!Number.isSafeInteger(layer.removedComponentCount) || layer.removedComponentCount < 0) reasons.push('Removed component count must be a non-negative safe integer');
  if (![layer.zStart, layer.zEnd].every(Number.isFinite) || layer.zEnd <= layer.zStart) reasons.push('Layer Z interval must be finite and positive');
  if (layer.contour.holes.length !== 0) reasons.push('Outline layers must not contain holes');
  if (points.length > 4096) reasons.push('Contour exceeds 4096 points');
  let finite = true, hasAdjacentDuplicate = false;
  const unique = new Set<string>();
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0 && expired(deadline)) return { ok: false, reasons: [...reasons, RUNTIME_REASON] };
    const [x, y] = points[index];
    if (!Number.isFinite(x) || !Number.isFinite(y)) finite = false;
    unique.add(`${x}:${y}`);
    const next = points[(index + 1) % points.length];
    if (next && x === next[0] && y === next[1]) hasAdjacentDuplicate = true;
  }
  if (!finite) reasons.push('Contour coordinates must be finite');
  if (unique.size < 3) reasons.push('Contour requires at least three unique points');
  if (hasAdjacentDuplicate) reasons.push('Contour has a zero-length edge or adjacent duplicate point');
  let area = 0;
  if (points.length >= 3 && finite) {
    try { area = signedArea(points, deadline); } catch { return { ok: false, reasons: [...reasons, RUNTIME_REASON] }; }
  }
  if (!Number.isFinite(area) || area >= 0) reasons.push('Contour must have positive geometric area and clockwise winding');
  if (points.length >= 3 && points.length <= 4096 && finite && !hasAdjacentDuplicate) {
    const simple = isSimpleWithinDeadline(points, deadline);
    if (simple === undefined) return { ok: false, reasons: [...reasons, RUNTIME_REASON] };
    if (!simple) reasons.push('Contour self-intersects');
  }
  const geometricArea = Math.abs(area);
  if (!Number.isFinite(layer.sourceAreaMm2) || layer.sourceAreaMm2 <= 0
    || !Number.isFinite(layer.simplifiedAreaMm2) || layer.simplifiedAreaMm2 <= 0) {
    reasons.push('Contour areas must be finite and positive');
  } else {
    const metadataTolerance = Math.max(1e-9, geometricArea * 1e-9);
    if (Math.abs(layer.simplifiedAreaMm2 - geometricArea) > metadataTolerance) {
      reasons.push('Simplified contour area metadata does not match its geometry');
    }
    if (Math.abs(layer.simplifiedAreaMm2 - layer.sourceAreaMm2) / layer.sourceAreaMm2 > 0.03 + 1e-12) {
      reasons.push('Simplified contour area drift exceeds three percent');
    }
  }
  const sourceBounds = layer.sourceBoundsMm;
  if (!sourceBounds || ![sourceBounds.minX, sourceBounds.minY, sourceBounds.maxX, sourceBounds.maxY].every(Number.isFinite)
    || sourceBounds.maxX <= sourceBounds.minX || sourceBounds.maxY <= sourceBounds.minY) {
    reasons.push('Source contour bounds must be finite and positive');
  } else if (points.length > 0 && finite) {
    let simplifiedBounds;
    try { simplifiedBounds = contourBounds(points, deadline); } catch { return { ok: false, reasons: [...reasons, RUNTIME_REASON] }; }
    const sourceWidth = sourceBounds.maxX - sourceBounds.minX, sourceHeight = sourceBounds.maxY - sourceBounds.minY;
    const drift = [
      Math.abs(simplifiedBounds.minX - sourceBounds.minX) / sourceWidth,
      Math.abs(simplifiedBounds.maxX - sourceBounds.maxX) / sourceWidth,
      Math.abs(simplifiedBounds.minY - sourceBounds.minY) / sourceHeight,
      Math.abs(simplifiedBounds.maxY - sourceBounds.maxY) / sourceHeight,
    ];
    if (drift.some((ratio) => ratio > 0.03 + 1e-12)) reasons.push('Simplified contour bounds drift exceeds three percent');
  }
  return { ok: reasons.length === 0, reasons };
}
