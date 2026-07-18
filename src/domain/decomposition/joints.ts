import { DecompositionError, type Fit, type JointFeature, type MaterialInput } from './types';

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

export function jointPair(id: string, slotPartId: string, tabPartId: string, widthMm: number): readonly [JointFeature, JointFeature] {
  return [
    { id, partId: slotPartId, matePartId: tabPartId, role: 'slot', widthMm },
    { id, partId: tabPartId, matePartId: slotPartId, role: 'tab', widthMm },
  ];
}
