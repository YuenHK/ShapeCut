import type { Point2 } from '../decomposition/types';
import { clonePolygon, MAX_ENGRAVING_REGIONS, validatePolygon } from './geometry';
import { assertPolygonCollectionBudget, assertPolygonsDoNotOverlap, EngravingError, isEngravingLevelCount, type EngravingLevelCount, type EngravingMap, type HeightField } from './height-field';

export type QuantizeOptions = {
  readonly levelDepthsMm?: readonly number[];
  readonly sheetThicknessMm?: number;
  readonly safeRemainingThicknessMm?: number;
  readonly center?: Point2;
};

function validateField(field: HeightField): void {
  if (field === null || typeof field !== 'object' || !Array.isArray(field.cells) || field.cells.length === 0 || field.cells.length > MAX_ENGRAVING_REGIONS) {
    throw new EngravingError('HEIGHT_FIELD', `Height field must contain 1..${MAX_ENGRAVING_REGIONS} cells`);
  }
  const polygons = [];
  for (let index = 0; index < field.cells.length; index += 1) {
    if (!(index in field.cells)) throw new EngravingError('HEIGHT_FIELD', 'Height field cells cannot be sparse');
    const cell = field.cells[index];
    if (cell === null || typeof cell !== 'object' || !Number.isFinite(cell.heightMm)) throw new EngravingError('HEIGHT_FIELD', 'Height field values must be finite millimetres');
    if (cell.polygon === null || typeof cell.polygon !== 'object' || !Array.isArray(cell.polygon.points)) throw new EngravingError('GEOMETRY', 'Height cells must contain polygon point arrays');
    polygons.push(cell.polygon);
  }
  assertPolygonCollectionBudget(polygons);
  for (const polygon of polygons) if (!validatePolygon(polygon)) throw new EngravingError('GEOMETRY', 'Height cells must be finite simple non-degenerate polygons');
  assertPolygonsDoNotOverlap(polygons);
}

function depths(levels: EngravingLevelCount, options: QuantizeOptions): Pick<EngravingMap, 'depthMode' | 'levelDepths' | 'sheetThicknessMm' | 'assumptions'> {
  const supplied = options.levelDepthsMm !== undefined || options.sheetThicknessMm !== undefined || options.safeRemainingThicknessMm !== undefined;
  if (!supplied) return {
    depthMode: 'relative',
    levelDepths: Array.from({ length: levels + 1 }, (_, level) => level / levels),
    assumptions: ['relative engraving depth only; no physical removal depth or material density supplied'],
  };
  const { levelDepthsMm, sheetThicknessMm, safeRemainingThicknessMm } = options;
  if (!Array.isArray(levelDepthsMm) || levelDepthsMm.length !== levels + 1
    || !Number.isFinite(sheetThicknessMm) || !(sheetThicknessMm! > 0)
    || !Number.isFinite(safeRemainingThicknessMm) || safeRemainingThicknessMm! < 0 || safeRemainingThicknessMm! > sheetThicknessMm!) {
    throw new EngravingError('SAFETY', 'Physical engraving requires a complete valid depth table, sheet thickness, and safe remaining thickness');
  }
  if (levelDepthsMm[0] !== 0) throw new EngravingError('SAFETY', 'Physical engraving depths must start at zero and remain finite and non-negative');
  for (let index = 0; index < levelDepthsMm.length; index += 1) if (!(index in levelDepthsMm) || !Number.isFinite(levelDepthsMm[index]) || levelDepthsMm[index] < 0) {
    throw new EngravingError('SAFETY', 'Physical engraving depths must start at zero and remain finite and non-negative');
  }
  for (let index = 1; index < levelDepthsMm.length; index += 1) if (levelDepthsMm[index] < levelDepthsMm[index - 1]) throw new EngravingError('SAFETY', 'Physical engraving depths must be monotonically increasing');
  const maximumRemoval = sheetThicknessMm! - safeRemainingThicknessMm!;
  const tolerance = Math.max(sheetThicknessMm!, 1) * 64 * Number.EPSILON;
  if (levelDepthsMm.at(-1)! > maximumRemoval + tolerance) throw new EngravingError('SAFETY', 'Deepest engraving would leave less than the safe remaining material thickness');
  return {
    depthMode: 'millimetres',
    levelDepths: [...levelDepthsMm],
    sheetThicknessMm,
    assumptions: ['ideal programmed engraving depths; actual removal requires a calibrated material profile'],
  };
}

/** Lower model surface heights receive deeper engraving; the maximum height remains unengraved (level zero). */
export function quantizeHeightField(field: HeightField, levelsValue: EngravingLevelCount, optionsValue: QuantizeOptions = {}): EngravingMap {
  if (!isEngravingLevelCount(levelsValue)) throw new EngravingError('LEVELS', 'Engraving level count must be exactly 3, 4, or 5');
  if (optionsValue === null || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) throw new EngravingError('SAFETY', 'Quantization options must be an object');
  const options = optionsValue;
  validateField(field);
  const center = options.center ?? [0, 0];
  if (!Array.isArray(center) || center.length !== 2 || !(0 in center) || !(1 in center) || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) throw new EngravingError('GEOMETRY', 'Engraving centre must be a finite point');
  const minimum = Math.min(...field.cells.map(({ heightMm }) => heightMm));
  const maximum = Math.max(...field.cells.map(({ heightMm }) => heightMm));
  const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum));
  const normalizedMinimum = magnitude === 0 ? 0 : minimum / magnitude;
  const normalizedMaximum = magnitude === 0 ? 0 : maximum / magnitude;
  const normalizedRange = normalizedMaximum - normalizedMinimum;
  const regions = field.cells.map(({ heightMm, polygon }) => {
    const fraction = normalizedRange === 0 ? 0 : (normalizedMaximum - heightMm / magnitude) / normalizedRange;
    const level = fraction <= 64 * Number.EPSILON ? 0 : Math.max(1, Math.min(levelsValue, Math.ceil(fraction * levelsValue - 64 * Number.EPSILON)));
    if (!Number.isInteger(level) || level < 0 || level > levelsValue) throw new EngravingError('NUMERIC', 'Height normalization did not produce a finite engraving level');
    return { level, polygon: clonePolygon(polygon) };
  });
  return { levels: levelsValue, regions, baseFootprint: field.cells.map(({ polygon }) => clonePolygon(polygon)), center: [center[0], center[1]], ...depths(levelsValue, options) };
}
