import type { Polygon2 } from '../decomposition/types';
import { clonePolygon, polygonsIntersectOrTouch, validatePolygon } from './geometry';
import { assertCrossIntersectionBudget, assertEngravingMapContract, assertPolygonCollectionBudget, EngravingError, type EngravingMap } from './height-field';

export type ProtectedZone = {
  readonly kind: 'shaft' | 'joint' | 'load-bearing' | 'outer-connection';
  readonly polygon: Polygon2;
  /** Zero forbids engraving. One permits only the shallowest calibrated level. */
  readonly maxLevel: 0 | 1;
};

/** Conservatively protects an entire quantized cell whenever it touches a structural zone. */
export function applyProtectedZones(map: EngravingMap, zones: readonly ProtectedZone[]): EngravingMap {
  assertEngravingMapContract(map);
  if (!Array.isArray(zones) || zones.length > 4096) throw new EngravingError('COMPLEXITY', 'Protected-zone count is invalid or too large');
  const zonePolygons: Polygon2[] = [];
  for (let index = 0; index < zones.length; index += 1) {
    if (!(index in zones)) throw new EngravingError('GEOMETRY', 'Protected-zone list cannot be sparse');
    const zone = zones[index];
    if (zone === null || typeof zone !== 'object' || !['shaft', 'joint', 'load-bearing', 'outer-connection'].includes(zone.kind)) throw new EngravingError('GEOMETRY', 'Protected zone kind is invalid');
    if (zone.maxLevel !== 0 && zone.maxLevel !== 1) throw new EngravingError('PROTECTED_LEVEL', 'Protected zones may only forbid engraving or permit level one');
    if (zone.polygon === null || typeof zone.polygon !== 'object' || !Array.isArray(zone.polygon.points)) throw new EngravingError('GEOMETRY', 'Protected zones must contain polygon point arrays');
    zonePolygons.push(zone.polygon);
  }
  assertPolygonCollectionBudget(zonePolygons);
  for (const polygon of zonePolygons) if (!validatePolygon(polygon)) throw new EngravingError('GEOMETRY', 'Protected zones must be finite simple non-degenerate polygons');
  assertCrossIntersectionBudget(map.regions.map(({ polygon }) => polygon), zonePolygons);
  const fullyProtected = zones.filter(({ maxLevel }) => maxLevel === 0);
  const shallowOnly = zones.filter(({ maxLevel }) => maxLevel === 1);
  return {
    levels: map.levels,
    regions: map.regions.map((region) => {
      let level = region.level;
      if (level > 0 && fullyProtected.some((zone) => polygonsIntersectOrTouch(region.polygon, zone.polygon))) level = 0;
      else if (level > 1 && shallowOnly.some((zone) => polygonsIntersectOrTouch(region.polygon, zone.polygon))) level = 1;
      return { level, polygon: clonePolygon(region.polygon) };
    }),
    ...(map.baseFootprint === undefined ? {} : { baseFootprint: map.baseFootprint.map(clonePolygon) }),
    center: [map.center[0], map.center[1]],
    depthMode: map.depthMode,
    levelDepths: [...map.levelDepths],
    ...(map.sheetThicknessMm === undefined ? {} : { sheetThicknessMm: map.sheetThicknessMm }),
    assumptions: [...map.assumptions, 'structural protection conservatively applies to every intersecting height-field cell'],
  };
}
