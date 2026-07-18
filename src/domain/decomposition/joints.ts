import { DecompositionError, type Fit, type JointFeature, type MaterialInput, type Point2, type Polygon2 } from './types';

export function fitAllowance(material: MaterialInput, fit: Fit): number {
  return typeof material.fitAllowanceMm === 'number' ? material.fitAllowanceMm : material.fitAllowanceMm[fit];
}

export function jointWidth(material: MaterialInput, fit: Fit, localStructureMm: number): number {
  const width = material.thicknessMm + fitAllowance(material, fit);
  if (!Number.isFinite(width) || width <= 0 || width >= localStructureMm) {
    throw new DecompositionError('JOINT', 'Joint width must be positive and smaller than the local structure');
  }
  return width;
}

export function jointPair(id: string, slotPartId: string, tabPartId: string, widthMm: number, depthMm: number, slotPosition: Point2, slotDirection: Point2, tabPosition: Point2, tabDirection: Point2, slot: Polygon2, tab: Polygon2): readonly [JointFeature, JointFeature] {
  return [
    { id, partId: slotPartId, matePartId: tabPartId, role: 'slot', widthMm, depthMm, position: slotPosition, direction: slotDirection, polygon: slot },
    { id, partId: tabPartId, matePartId: slotPartId, role: 'tab', widthMm, depthMm, position: tabPosition, direction: tabDirection, polygon: tab },
  ];
}
