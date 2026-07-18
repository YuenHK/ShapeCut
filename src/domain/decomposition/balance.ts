import { assertCrossIntersectionBudget, assertEngravingMapContract, assertPolygonCollectionBudget, assertPolygonsDoNotOverlap, EngravingError, type EngravingMap, type EngravingRegion } from '../engraving/height-field';
import { MAX_ENGRAVING_REGIONS, polygonIntersectionArea, polygonMassProperties, polygonPolarSecondMoment, validatePolygon } from '../engraving/geometry';
import type { BalanceResult, Point2, Polygon2 } from './types';

export type BalanceBase = {
  /** Non-overlapping solid material polygons. Holes are represented by uncovered space. */
  readonly footprint: readonly Polygon2[];
  readonly thicknessMm: number;
};

export type BalanceThresholds = {
  readonly center?: Point2;
  readonly base?: BalanceBase;
  readonly passCentroidOffsetMm?: number;
  readonly blockCentroidOffsetMm?: number;
  readonly passAngularMassError?: number;
  readonly blockAngularMassError?: number;
};

const defaults = {
  passCentroidOffsetMm: 0.05,
  blockCentroidOffsetMm: 0.25,
  passAngularMassError: 0.01,
  blockAngularMassError: 0.05,
} as const;

class CompensatedSum {
  private sum = 0;
  private correction = 0;
  add(value: number): void {
    const next = this.sum + value;
    this.correction += Math.abs(this.sum) >= Math.abs(value) ? (this.sum - next) + value : (value - next) + this.sum;
    this.sum = next;
  }
  value(): number { return this.sum + this.correction; }
}

function finitePoint(value: unknown): value is Point2 {
  return Array.isArray(value) && value.length === 2 && 0 in value && 1 in value && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

type LocalProperties = { readonly area: number; readonly centroid: Point2; readonly polarSecondMoment: number };

function localProperties(polygon: Polygon2, center: Point2): LocalProperties {
  const local: Polygon2 = { points: polygon.points.map(([x, y]) => [x - center[0], y - center[1]] as const) };
  const { area, centroid } = polygonMassProperties(local), polarSecondMoment = polygonPolarSecondMoment(local);
  if (![area, centroid[0], centroid[1], polarSecondMoment].every(Number.isFinite) || !(area > 0) || !(polarSecondMoment > 0)) {
    throw new EngravingError('NUMERIC', 'Polygon mass properties exceed finite numeric range');
  }
  return { area, centroid, polarSecondMoment };
}

function validateFootprint(value: unknown, allowEmpty: boolean): readonly Polygon2[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_ENGRAVING_REGIONS) throw new EngravingError('FOOTPRINT', 'Balance footprint must contain a bounded list of material polygons');
  const polygons: Polygon2[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const polygon = value[index] as Polygon2;
    if (!(index in value) || polygon === null || typeof polygon !== 'object' || !Array.isArray(polygon.points)) throw new EngravingError('FOOTPRINT', 'Balance footprint must contain polygon point arrays');
    polygons.push(polygon);
  }
  assertPolygonCollectionBudget(polygons);
  for (const polygon of polygons) if (!validatePolygon(polygon)) throw new EngravingError('FOOTPRINT', 'Balance footprint polygons must be finite, simple, and non-degenerate');
  try {
    assertPolygonsDoNotOverlap(polygons);
  } catch (error) {
    if (error instanceof EngravingError && error.code === 'OVERLAP') throw new EngravingError('FOOTPRINT', 'Balance footprint material polygons cannot overlap');
    throw error;
  }
  return polygons;
}

function assertRegionsInsideFootprint(regions: readonly EngravingRegion[], footprint: readonly Polygon2[]): void {
  for (const region of regions) {
    const regionArea = polygonMassProperties(region.polygon).area;
    const covered = new CompensatedSum();
    for (const material of footprint) {
      const area = polygonIntersectionArea(region.polygon, material);
      if (!Number.isFinite(area)) throw new EngravingError('NUMERIC', 'Footprint containment could not be evaluated in finite numeric range');
      covered.add(area);
    }
    const tolerance = Math.max(Number.MIN_VALUE, regionArea * 4096 * Number.EPSILON);
    if (!Number.isFinite(regionArea) || !Number.isFinite(covered.value())) throw new EngravingError('NUMERIC', 'Footprint containment exceeds finite numeric range');
    if (covered.value() < regionArea - tolerance) throw new EngravingError('FOOTPRINT', 'Every engraving region must lie completely inside solid base material');
  }
}

function assertRepresentablePrecision(map: EngravingMap, footprint: readonly Polygon2[], passCentroidOffsetMm: number): void {
  let maximumCoordinate = Math.max(Math.abs(map.center[0]), Math.abs(map.center[1]));
  for (const region of map.regions) for (const [x, y] of region.polygon.points) maximumCoordinate = Math.max(maximumCoordinate, Math.abs(x), Math.abs(y));
  for (const polygon of footprint) for (const [x, y] of polygon.points) maximumCoordinate = Math.max(maximumCoordinate, Math.abs(x), Math.abs(y));
  if (!Number.isFinite(maximumCoordinate) || maximumCoordinate * Number.EPSILON > passCentroidOffsetMm / 4) {
    throw new EngravingError('NUMERIC', 'Coordinate resolution is too coarse for the requested balance tolerance; normalize geometry near its spin centre');
  }
}

function footprintMassProperties(footprint: readonly Polygon2[], center: Point2, thickness: number): {
  readonly volume: number; readonly momentX: number; readonly momentY: number; readonly polarSecondMoment: number;
} {
  const area = new CompensatedSum(), momentX = new CompensatedSum(), momentY = new CompensatedSum(), polar = new CompensatedSum();
  for (const polygon of footprint) {
    const property = localProperties(polygon, center);
    area.add(property.area);
    momentX.add(property.area * property.centroid[0]);
    momentY.add(property.area * property.centroid[1]);
    polar.add(property.polarSecondMoment);
  }
  const volume = area.value() * thickness;
  const result = { volume, momentX: momentX.value() * thickness, momentY: momentY.value() * thickness, polarSecondMoment: polar.value() * thickness };
  if (![result.volume, result.momentX, result.momentY, result.polarSecondMoment].every(Number.isFinite)
    || !(result.volume > 0) || !(result.polarSecondMoment > 0)) throw new EngravingError('NUMERIC', 'Base mass properties exceed finite numeric range');
  return result;
}

export function estimateBalance(map: EngravingMap, optionsValue: BalanceThresholds = {}): BalanceResult {
  assertEngravingMapContract(map);
  if (optionsValue === null || typeof optionsValue !== 'object' || Array.isArray(optionsValue)) throw new EngravingError('THRESHOLDS', 'Balance options must be an object');
  const options = optionsValue;
  const center = options.center ?? map.center;
  if (!finitePoint(center)) throw new EngravingError('GEOMETRY', 'Balance centre must be a finite point');
  const passCentroid = options.passCentroidOffsetMm ?? defaults.passCentroidOffsetMm;
  const blockCentroid = options.blockCentroidOffsetMm ?? defaults.blockCentroidOffsetMm;
  const passAngular = options.passAngularMassError ?? defaults.passAngularMassError;
  const blockAngular = options.blockAngularMassError ?? defaults.blockAngularMassError;
  if (![passCentroid, blockCentroid, passAngular, blockAngular].every((value) => Number.isFinite(value) && value >= 0)
    || passCentroid >= blockCentroid || passAngular >= blockAngular) {
    throw new EngravingError('THRESHOLDS', 'Balance pass thresholds must be finite, non-negative, and below block thresholds');
  }
  if (options.base !== undefined && (options.base === null || typeof options.base !== 'object' || Array.isArray(options.base))) throw new EngravingError('FOOTPRINT', 'Balance base must be an object');
  const suppliedBase = options.base;
  if (suppliedBase && (!Number.isFinite(suppliedBase.thicknessMm) || !(suppliedBase.thicknessMm > 0))) throw new EngravingError('FOOTPRINT', 'Balance base thickness must be finite and positive');
  const footprint = suppliedBase ? validateFootprint(suppliedBase.footprint, false) : validateFootprint(map.baseFootprint, false);
  const baseThickness = suppliedBase?.thicknessMm ?? (map.depthMode === 'millimetres' ? map.sheetThicknessMm! : 1);
  if (suppliedBase && map.depthMode === 'millimetres') {
    const tolerance = Math.max(baseThickness, map.sheetThicknessMm!, 1) * 64 * Number.EPSILON;
    if (Math.abs(baseThickness - map.sheetThicknessMm!) > tolerance) throw new EngravingError('SAFETY', 'Balance base thickness must match the physical engraving map sheet thickness');
  }
  assertRepresentablePrecision(map, footprint, passCentroid);
  assertCrossIntersectionBudget(map.regions.map(({ polygon }) => polygon), footprint);
  assertRegionsInsideFootprint(map.regions, footprint);

  const base = footprintMassProperties(footprint, center, baseThickness);
  const removalVolume = new CompensatedSum(), removalMomentX = new CompensatedSum(), removalMomentY = new CompensatedSum(), removalPolar = new CompensatedSum();
  for (const region of map.regions) {
    const programmedDepth = map.levelDepths[region.level];
    const depth = map.depthMode === 'relative' ? programmedDepth * baseThickness : programmedDepth;
    if (depth === 0) continue;
    const property = localProperties(region.polygon, center);
    const volume = property.area * depth, momentX = volume * property.centroid[0], momentY = volume * property.centroid[1], polar = property.polarSecondMoment * depth;
    if (![depth, volume, momentX, momentY, polar].every(Number.isFinite)) throw new EngravingError('NUMERIC', 'Engraving removal mass exceeds finite numeric range');
    removalVolume.add(volume); removalMomentX.add(momentX); removalMomentY.add(momentY); removalPolar.add(polar);
  }
  const remainingVolume = base.volume - removalVolume.value();
  const remainingMomentX = base.momentX - removalMomentX.value(), remainingMomentY = base.momentY - removalMomentY.value();
  const remainingPolar = base.polarSecondMoment - removalPolar.value();
  const massTolerance = base.volume * 256 * Number.EPSILON, polarTolerance = base.polarSecondMoment * 256 * Number.EPSILON;
  if (![remainingVolume, remainingMomentX, remainingMomentY, remainingPolar].every(Number.isFinite)) throw new EngravingError('NUMERIC', 'Remaining material mass exceeds finite numeric range');
  if (remainingVolume <= massTolerance || remainingPolar <= polarTolerance) throw new EngravingError('SAFETY', 'Engraving leaves no positive safe base mass distribution');
  const centroidOffsetMm = Math.hypot(remainingMomentX, remainingMomentY) / remainingVolume;
  const remainingRmsRadius = Math.sqrt(remainingPolar / remainingVolume);
  const angularMassError = centroidOffsetMm / remainingRmsRadius;
  if (![centroidOffsetMm, remainingRmsRadius, angularMassError].every(Number.isFinite) || !(remainingRmsRadius > 0)) throw new EngravingError('NUMERIC', 'Balance result exceeds finite numeric range');

  const status = centroidOffsetMm <= passCentroid && angularMassError <= passAngular
    ? 'pass'
    : centroidOffsetMm >= blockCentroid || angularMassError >= blockAngular ? 'block' : 'confirm';
  const assumptions = [...new Set([
    ...map.assumptions,
    'ideal static estimate only; not a dynamic balance analysis',
    'uniform material density and ideal engraving removal',
    suppliedBase ? 'finished centre of mass uses the supplied validated material footprint' : 'finished centre of mass uses the engraving map complete base footprint',
    'angular mass error is centroid offset normalized by exact remaining RMS radius',
    map.depthMode === 'relative' ? 'relative depths are interpreted as fractions of a normalized base thickness' : 'physical depths use the declared sheet thickness',
  ])];
  return { kind: 'ideal-static-estimate', status, centroidOffsetMm, angularMassError, assumptions };
}
