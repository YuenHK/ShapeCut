import type { Part2D, Polygon2 } from '../decomposition/types';
import { convexPolygonKernel, type PolygonKernel } from './polygon-kernel';

function singleOffset(kernel: PolygonKernel, polygon: Polygon2, mm: number): Polygon2 {
  const results = kernel.offset(polygon, mm);
  if (results.length !== 1) throw new RangeError('Kerf compensation requires a single connected offset polygon');
  return results[0];
}

export function applyKerf(part: Part2D, kerfMm: number, kernel: PolygonKernel = convexPolygonKernel): Part2D {
  if (!Number.isFinite(kerfMm) || kerfMm < 0) throw new RangeError('Kerf must be a finite non-negative width');
  const compensation = kerfMm / 2;
  return {
    ...part,
    outline: singleOffset(kernel, part.outline, compensation),
    holes: part.holes.map((hole) => singleOffset(kernel, hole, -compensation)),
  };
}
