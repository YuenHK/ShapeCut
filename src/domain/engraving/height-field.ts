import type { Point2, Polygon2 } from '../decomposition/types';
import { clonePolygon, MAX_ENGRAVING_REGIONS, pointLocation, polygonsOverlapArea, validatePolygon } from './geometry';

export type EngravingLevelCount = 3 | 4 | 5;
export type EngravingErrorCode = 'LEVELS' | 'HEIGHT_FIELD' | 'GEOMETRY' | 'OVERLAP' | 'SAFETY' | 'PROTECTED_LEVEL' | 'SECTORS' | 'THRESHOLDS' | 'COMPLEXITY' | 'NUMERIC' | 'FOOTPRINT';

export class EngravingError extends Error {
  readonly name = 'EngravingError';
  constructor(readonly code: EngravingErrorCode, message: string) { super(message); }
}

export const MAX_TOTAL_POLYGON_VERTICES = 100_000;
export const MAX_GEOMETRY_WORK = 50_000_000;

export type HeightCell = {
  readonly heightMm: number;
  readonly polygon: Polygon2;
};

export type HeightField = {
  readonly cells: readonly HeightCell[];
};

export type EngravingRegion = {
  /** Zero means no engraving; positive values select a process depth. */
  readonly level: number;
  readonly polygon: Polygon2;
};

/** Plain structured-clone-safe data. Point queries intentionally live in the levelAt helper. */
export type EngravingMap = {
  readonly levels: EngravingLevelCount;
  readonly regions: readonly EngravingRegion[];
  /** Complete solid base cells used to prove the mass footprint; required for balance unless an explicit base is supplied. */
  readonly baseFootprint?: readonly Polygon2[];
  readonly center: Point2;
  readonly depthMode: 'relative' | 'millimetres';
  /** Index zero is always zero; indices 1..levels are monotonically increasing removal depths. */
  readonly levelDepths: readonly number[];
  /** Required when levelDepths are physical millimetres. */
  readonly sheetThicknessMm?: number;
  readonly assumptions: readonly string[];
};

export function isEngravingLevelCount(value: unknown): value is EngravingLevelCount {
  return value === 3 || value === 4 || value === 5;
}

export function assertPolygonCollectionBudget(polygons: readonly Polygon2[]): void {
  let totalVertices = 0, validationWork = 0;
  for (const polygon of polygons) {
    const count = Array.isArray(polygon?.points) ? polygon.points.length : 0;
    totalVertices += count;
    validationWork += count * count;
    if (totalVertices > MAX_TOTAL_POLYGON_VERTICES || validationWork > MAX_GEOMETRY_WORK) throw new EngravingError('COMPLEXITY', 'Polygon collection exceeds the bounded geometry validation budget');
  }
}

export function assertCrossIntersectionBudget(left: readonly Polygon2[], right: readonly Polygon2[]): void {
  assertPolygonCollectionBudget(left); assertPolygonCollectionBudget(right);
  const leftVertices = left.reduce((sum, polygon) => sum + polygon.points.length, 0);
  const rightVertices = right.reduce((sum, polygon) => sum + polygon.points.length, 0);
  if (leftVertices * rightVertices > MAX_GEOMETRY_WORK) throw new EngravingError('COMPLEXITY', 'Polygon intersection product exceeds the bounded geometry work budget');
}

export function assertPolygonsDoNotOverlap(polygons: readonly Polygon2[]): void {
  assertPolygonCollectionBudget(polygons);
  let work = 0;
  for (let left = 0; left < polygons.length; left += 1) for (let right = left + 1; right < polygons.length; right += 1) {
    work += polygons[left].points.length * polygons[right].points.length;
    if (work > MAX_GEOMETRY_WORK) throw new EngravingError('COMPLEXITY', 'Polygon overlap audit exceeds the bounded geometry work budget');
    if (polygonsOverlapArea(polygons[left], polygons[right])) throw new EngravingError('OVERLAP', `Polygons ${left} and ${right} overlap in positive area`);
  }
}

function assertEngravingMapStructure(map: EngravingMap): void {
  if (map === null || typeof map !== 'object' || !isEngravingLevelCount(map.levels)) throw new EngravingError('LEVELS', 'Engraving map must use 3, 4, or 5 levels');
  if (!Array.isArray(map.regions) || map.regions.length > MAX_ENGRAVING_REGIONS) throw new EngravingError('COMPLEXITY', `Engraving map is limited to ${MAX_ENGRAVING_REGIONS} regions`);
  if (!Array.isArray(map.center) || map.center.length !== 2 || !(0 in map.center) || !(1 in map.center) || !Number.isFinite(map.center[0]) || !Number.isFinite(map.center[1])) throw new EngravingError('GEOMETRY', 'Engraving centre must be a finite point');
  if (map.depthMode !== 'relative' && map.depthMode !== 'millimetres') throw new EngravingError('SAFETY', 'Engraving depth mode is invalid');
  if (!Array.isArray(map.levelDepths) || map.levelDepths.length !== map.levels + 1 || map.levelDepths[0] !== 0) {
    throw new EngravingError('SAFETY', 'Engraving depths must contain zero followed by one finite non-negative value per level');
  }
  for (let index = 0; index < map.levelDepths.length; index += 1) if (!(index in map.levelDepths) || !Number.isFinite(map.levelDepths[index]) || map.levelDepths[index] < 0) {
    throw new EngravingError('SAFETY', 'Engraving depths must contain zero followed by one finite non-negative value per level');
  }
  for (let index = 1; index < map.levelDepths.length; index += 1) if (map.levelDepths[index] < map.levelDepths[index - 1]) {
    throw new EngravingError('SAFETY', 'Engraving depths must be monotonically increasing');
  }
  if (map.depthMode === 'millimetres') {
    if (!Number.isFinite(map.sheetThicknessMm) || !(map.sheetThicknessMm! > 0) || map.levelDepths.at(-1)! > map.sheetThicknessMm!) {
      throw new EngravingError('SAFETY', 'Millimetre engraving maps require a valid sheet thickness no smaller than the deepest level');
    }
  } else if (map.sheetThicknessMm !== undefined) {
    throw new EngravingError('SAFETY', 'Relative engraving maps cannot claim a physical sheet thickness');
  }
  if (!Array.isArray(map.assumptions)) throw new EngravingError('SAFETY', 'Engraving assumptions must be text');
  for (let index = 0; index < map.assumptions.length; index += 1) if (!(index in map.assumptions) || typeof map.assumptions[index] !== 'string') throw new EngravingError('SAFETY', 'Engraving assumptions must be text');
  const regionPolygons: Polygon2[] = [];
  for (let index = 0; index < map.regions.length; index += 1) {
    if (!(index in map.regions)) throw new EngravingError('GEOMETRY', 'Engraving region list cannot be sparse');
    const region = map.regions[index];
    if (region === null || typeof region !== 'object' || !Number.isInteger(region.level) || region.level < 0 || region.level > map.levels) throw new EngravingError('LEVELS', 'Region level is outside the engraving map range');
    if (region.polygon === null || typeof region.polygon !== 'object' || !Array.isArray(region.polygon.points)) throw new EngravingError('GEOMETRY', 'Engraving regions must contain polygon point arrays');
    regionPolygons.push(region.polygon);
  }
  assertPolygonCollectionBudget(regionPolygons);
  for (const polygon of regionPolygons) if (!validatePolygon(polygon)) throw new EngravingError('GEOMETRY', 'Engraving regions must be finite simple non-degenerate polygons');
  if (map.baseFootprint !== undefined) {
    if (!Array.isArray(map.baseFootprint) || map.baseFootprint.length > MAX_ENGRAVING_REGIONS) throw new EngravingError('COMPLEXITY', 'Base footprint is invalid or too large');
    const footprint: Polygon2[] = [];
    for (let index = 0; index < map.baseFootprint.length; index += 1) {
      if (!(index in map.baseFootprint) || map.baseFootprint[index] === null || typeof map.baseFootprint[index] !== 'object' || !Array.isArray(map.baseFootprint[index].points)) throw new EngravingError('FOOTPRINT', 'Base footprint must contain polygon point arrays');
      footprint.push(map.baseFootprint[index]);
    }
    assertPolygonCollectionBudget(footprint);
    for (const polygon of footprint) if (!validatePolygon(polygon)) throw new EngravingError('FOOTPRINT', 'Base footprint must contain finite simple non-degenerate polygons');
  }
}

export function assertRegionsDoNotOverlap(regions: readonly EngravingRegion[]): void {
  assertPolygonsDoNotOverlap(regions.map(({ polygon }) => polygon));
}

export function assertEngravingMapContract(map: EngravingMap): void {
  assertEngravingMapStructure(map);
  assertPolygonCollectionBudget([...map.regions.map(({ polygon }) => polygon), ...(map.baseFootprint ?? [])]);
  assertRegionsDoNotOverlap(map.regions);
  if (map.baseFootprint !== undefined) assertPolygonsDoNotOverlap(map.baseFootprint);
}

export function cloneEngravingMap(map: EngravingMap): EngravingMap {
  assertEngravingMapContract(map);
  return {
    levels: map.levels,
    regions: map.regions.map(({ level, polygon }) => ({ level, polygon: clonePolygon(polygon) })),
    ...(map.baseFootprint === undefined ? {} : { baseFootprint: map.baseFootprint.map(clonePolygon) }),
    center: [map.center[0], map.center[1]],
    depthMode: map.depthMode,
    levelDepths: [...map.levelDepths],
    ...(map.sheetThicknessMm === undefined ? {} : { sheetThicknessMm: map.sheetThicknessMm }),
    assumptions: [...map.assumptions],
  };
}

export function levelAt(map: EngravingMap, point: Point2): number {
  assertEngravingMapContract(map);
  if (!Array.isArray(point) || point.length !== 2 || !(0 in point) || !(1 in point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new EngravingError('GEOMETRY', 'Lookup point must be finite');
  let level: number | undefined;
  for (const region of map.regions) if (pointLocation(region.polygon, point) >= 0) level = level === undefined ? region.level : Math.min(level, region.level);
  return level ?? 0;
}
