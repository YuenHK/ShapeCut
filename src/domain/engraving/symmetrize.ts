import type { Point2, Polygon2 } from '../decomposition/types';
import { canonicalPolygonKey, rotatePolygon } from './geometry';
import { assertEngravingMapContract, assertPolygonCollectionBudget, assertPolygonsDoNotOverlap, assertRegionsDoNotOverlap, EngravingError, MAX_TOTAL_POLYGON_VERTICES, type EngravingMap, type EngravingRegion } from './height-field';

export type SymmetryOptions = {
  readonly sectors: number;
  readonly center?: Point2;
};

export function symmetrizeEngraving(map: EngravingMap, optionsValue: SymmetryOptions): EngravingMap {
  assertEngravingMapContract(map);
  if (optionsValue === null || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) throw new EngravingError('SECTORS', 'Symmetry options must be an object');
  const options = optionsValue;
  if (!Number.isInteger(options.sectors) || options.sectors < 2 || options.sectors > 64) throw new EngravingError('SECTORS', 'Rotational symmetry requires an integer sector count from 2 to 64');
  const center = options.center ?? map.center;
  if (!Array.isArray(center) || center.length !== 2 || !(0 in center) || !(1 in center) || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) throw new EngravingError('GEOMETRY', 'Symmetry centre must be a finite point');
  if (map.regions.length * options.sectors > 4096 || (map.baseFootprint?.length ?? 0) * options.sectors > 4096) throw new EngravingError('COMPLEXITY', 'Symmetrized engraving or base footprint would exceed the region limit');
  const expandedVertices = (map.regions.reduce((sum, region) => sum + region.polygon.points.length, 0)
    + (map.baseFootprint ?? []).reduce((sum, polygon) => sum + polygon.points.length, 0)) * options.sectors;
  if (expandedVertices > MAX_TOTAL_POLYGON_VERTICES) throw new EngravingError('COMPLEXITY', 'Symmetrized geometry would exceed the total vertex limit');
  const regions: EngravingRegion[] = [], keys = new Set<string>();
  for (const region of map.regions) for (let sector = 0; sector < options.sectors; sector += 1) {
    const polygon = rotatePolygon(region.polygon, sector * Math.PI * 2 / options.sectors, center);
    const key = `${region.level}:${canonicalPolygonKey(polygon)}`;
    if (keys.has(key)) continue;
    keys.add(key);
    regions.push({ level: region.level, polygon });
  }
  const baseFootprint = map.baseFootprint === undefined ? undefined : (() => {
    const polygons: Polygon2[] = [], polygonKeys = new Set<string>();
    for (const source of map.baseFootprint!) for (let sector = 0; sector < options.sectors; sector += 1) {
      const polygon = rotatePolygon(source, sector * Math.PI * 2 / options.sectors, center);
      const key = canonicalPolygonKey(polygon);
      if (!polygonKeys.has(key)) { polygonKeys.add(key); polygons.push(polygon); }
    }
    assertPolygonCollectionBudget(polygons);
    assertPolygonsDoNotOverlap(polygons);
    return polygons;
  })();
  assertRegionsDoNotOverlap(regions);
  return {
    levels: map.levels,
    regions,
    ...(baseFootprint === undefined ? {} : { baseFootprint }),
    center: [center[0], center[1]],
    depthMode: map.depthMode,
    levelDepths: [...map.levelDepths],
    ...(map.sheetThicknessMm === undefined ? {} : { sheetThicknessMm: map.sheetThicknessMm }),
    assumptions: [...map.assumptions, `engraving copied with ${options.sectors}-sector rotational symmetry`],
  };
}
