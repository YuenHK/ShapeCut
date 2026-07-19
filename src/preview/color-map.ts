import { Color } from 'three';

const ENGRAVING_COLORS = ['#e5e7eb', '#bfdbfe', '#7dd3fc', '#38bdf8', '#0284c7', '#075985'] as const;

export function engravingLevelColor(level: number, levels: number): Color {
  if (!Number.isInteger(level) || level < 0 || !Number.isInteger(levels) || levels < 1 || level > levels) {
    throw new RangeError('Engraving level must be an integer inside the configured range');
  }
  const index = Math.round(level / levels * (ENGRAVING_COLORS.length - 1));
  return new Color(ENGRAVING_COLORS[index]);
}

export const PART_COLORS = {
  'hub-layer': '#d97706',
  rib: '#2563eb',
  'outer-ring': '#059669',
  spacer: '#7c3aed',
} as const;
