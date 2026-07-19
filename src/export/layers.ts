import type { Polygon2 } from '../domain/decomposition/types';

export type LayerName = 'CUT' | 'SCORE' | `ENGRAVE_${1 | 2 | 3 | 4 | 5}`;
export const LAYER_ORDER: readonly LayerName[] = ['CUT', 'SCORE', 'ENGRAVE_1', 'ENGRAVE_2', 'ENGRAVE_3', 'ENGRAVE_4', 'ENGRAVE_5'];

export type LayerEntity = { readonly id: string; readonly partId: string; readonly layer: LayerName; readonly polygon: Polygon2 };
export type ManufacturingSheet = { readonly width: number; readonly height: number; readonly entities: readonly LayerEntity[] };
export type PartManifest = { readonly partId: string; readonly quantity: number; readonly assemblyOrder: number };
export type ManufacturingDocument = { readonly unit: 'mm'; readonly sheets: readonly ManufacturingSheet[]; readonly manifest: readonly PartManifest[] };
export type ManufacturingProject = {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly sourceSha256: string;
  readonly document: ManufacturingDocument;
  readonly settings: Readonly<Record<string, unknown>>;
};

export function validateProject(project: ManufacturingProject): void {
  if (project.schemaVersion !== 1) throw new RangeError('Unsupported project schema version');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(project.name)) throw new RangeError('Project name must be a safe filename');
  if (!/^[0-9a-f]{64}$/i.test(project.sourceSha256)) throw new RangeError('Source SHA-256 fingerprint must contain 64 hexadecimal characters');
  if (project.document.unit !== 'mm' || project.document.sheets.length === 0) throw new RangeError('Manufacturing document must contain millimetre sheets');
  const partIds = new Set<string>();
  for (const item of project.document.manifest) {
    if (!item.partId || partIds.has(item.partId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.assemblyOrder) || item.assemblyOrder < 1) throw new RangeError('Part manifest is invalid');
    partIds.add(item.partId);
  }
  for (const sheet of project.document.sheets) {
    if (![sheet.width, sheet.height].every(Number.isFinite) || sheet.width <= 0 || sheet.height <= 0) throw new RangeError('Sheet dimensions must be finite and positive');
    for (const entity of sheet.entities) {
      if (!LAYER_ORDER.includes(entity.layer) || !partIds.has(entity.partId) || entity.polygon.points.length < 3 || entity.polygon.points.some((point) => point.length !== 2 || !point.every(Number.isFinite))) throw new RangeError('Entity geometry must be finite and reference a manifest part');
    }
  }
}

export function usedLayers(sheet: ManufacturingSheet): LayerName[] {
  const present = new Set(sheet.entities.map(({ layer }) => layer));
  return LAYER_ORDER.filter((layer) => present.has(layer));
}
