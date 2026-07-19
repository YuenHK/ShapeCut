import type { Part2D } from '../decomposition/types';
import { validatePolygon } from '../engraving/geometry';

export type PartPlacement = { readonly partId: string; readonly instance: number; readonly xMm: number; readonly yMm: number; readonly widthMm: number; readonly heightMm: number };
export type SheetLayout = { readonly index: number; readonly widthMm: number; readonly heightMm: number; readonly placements: readonly PartPlacement[] };
export type NestResult = { readonly sheets: readonly SheetLayout[] };

function bounds(part: Part2D) {
  const xs = part.outline.points.map(([x]) => x), ys = part.outline.points.map(([, y]) => y);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export function nestParts(parts: readonly Part2D[], sheet: { readonly widthMm: number; readonly heightMm: number; readonly spacingMm: number }): NestResult {
  if (![sheet.widthMm, sheet.heightMm, sheet.spacingMm].every(Number.isFinite) || sheet.widthMm <= 0 || sheet.heightMm <= 0 || sheet.spacingMm < 0) throw new RangeError('Sheet dimensions and spacing must be finite and valid');
  let totalQuantity = 0;
  for (const part of parts) {
    if (!validatePolygon(part.outline) || part.holes.some((hole) => !validatePolygon(hole))) throw new RangeError(`Part ${part.id} contains invalid geometry`);
    if (!Number.isSafeInteger(part.quantity) || part.quantity < 1) throw new RangeError(`Part ${part.id} has an invalid quantity`);
    totalQuantity += part.quantity;
    if (totalQuantity > 100_000) throw new RangeError('Total part quantity exceeds the layout safety limit');
  }
  const items = parts.flatMap((part) => Array.from({ length: part.quantity }, (_, instance) => ({ part, instance, ...bounds(part) })))
    .sort((a, b) => b.width * b.height - a.width * a.height || a.part.id.localeCompare(b.part.id) || a.instance - b.instance);
  const sheets: { index: number; widthMm: number; heightMm: number; placements: PartPlacement[]; x: number; y: number; rowHeight: number }[] = [];
  for (const item of items) {
    if (item.width > sheet.widthMm || item.height > sheet.heightMm) throw new RangeError(`Part ${item.part.id} does not fit the sheet`);
    let target = sheets.find((candidate) => {
      const x = candidate.x + item.width <= sheet.widthMm ? candidate.x : 0;
      const y = x === 0 && candidate.x !== 0 ? candidate.y + candidate.rowHeight + sheet.spacingMm : candidate.y;
      return y + item.height <= sheet.heightMm;
    });
    if (!target) {
      target = { index: sheets.length, widthMm: sheet.widthMm, heightMm: sheet.heightMm, placements: [], x: 0, y: 0, rowHeight: 0 };
      sheets.push(target);
    }
    if (target.x + item.width > sheet.widthMm) { target.x = 0; target.y += target.rowHeight + sheet.spacingMm; target.rowHeight = 0; }
    target.placements.push({ partId: item.part.id, instance: item.instance, xMm: target.x, yMm: target.y, widthMm: item.width, heightMm: item.height });
    target.x += item.width + sheet.spacingMm;
    target.rowHeight = Math.max(target.rowHeight, item.height);
  }
  return { sheets: sheets.map(({ index, widthMm, heightMm, placements }) => ({ index, widthMm, heightMm, placements })) };
}
