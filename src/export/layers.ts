import type { Polygon2 } from '../domain/decomposition/types';
import { pointLocation, polygonIntersectionArea, polygonMassProperties, polygonsIntersectOrTouch, validatePolygon } from '../domain/engraving/geometry';
import { MaterialProfileSchema, type MaterialProfileV1 } from '../domain/materials/schema';
import type { OutlineMode, OutlineResultStatus } from '../domain/outline-2.5d/types';
import type { AutomaticOutlineDiagnostics } from '../domain/pipeline/automatic-outline-pipeline';

export type LayerName = 'CUT' | 'SCORE' | `ENGRAVE_${1 | 2 | 3 | 4 | 5}`;
export type ColoredLayerName = 'CUT_BLACK' | 'DEEP_RED' | 'LIGHT_BLUE';
export const COLORED_LAYER_ORDER: readonly ColoredLayerName[] = ['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE'];
export const LAYER_ORDER: readonly LayerName[] = ['CUT', 'SCORE', 'ENGRAVE_1', 'ENGRAVE_2', 'ENGRAVE_3', 'ENGRAVE_4', 'ENGRAVE_5'];

export type LayerEntity = {
  readonly id: string;
  readonly partId: string;
  readonly instance: number;
  readonly contour: 'outline' | 'hole' | 'process';
  readonly layer: LayerName;
  readonly polygon: Polygon2;
};
export type ManufacturingSheet = { readonly width: number; readonly height: number; readonly entities: readonly LayerEntity[] };
export type PartManifest = { readonly partId: string; readonly quantity: number; readonly assemblyOrder: number };
export type ArtifactReference = { readonly inputFingerprint: string };
export type OutlineDocumentLayer = {
  readonly id: string;
  readonly order: number;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly boundsMm: readonly [number, number];
  readonly sourceBoundsMm: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
  readonly pointCount: number;
  readonly sheetIndex: number;
  readonly removedComponentCount: number;
};
export type OutlineDocumentMetadata = {
  readonly mode: OutlineMode;
  readonly sourceHash: string;
  readonly status: OutlineResultStatus;
  readonly warnings: readonly string[];
  readonly repairAccepted: boolean;
  readonly removedComponentCount: number;
  readonly removalEvidenceFingerprint: string;
  readonly axisSource: 'candidate' | 'shortest-bounds';
  readonly diagnostics: AutomaticOutlineDiagnostics;
  readonly diagnosticsFingerprint: string;
  readonly layers: readonly OutlineDocumentLayer[];
  readonly materialIndependent: true;
};
export type ExportPreflightEvidence = {
  readonly inputFingerprint: string;
  readonly canExport: boolean;
  readonly issues: readonly { readonly code: string; readonly severity: 'blocking' | 'confirm' | 'info'; readonly message: string }[];
  readonly acceptedConfirmations: readonly string[];
  readonly materialReadiness: {
    readonly status: 'ready' | 'confirm' | 'block';
    readonly reasons: readonly { readonly code: string; readonly message: string }[];
  };
  readonly materialProfile: MaterialProfileV1;
  readonly physicalApproval: 'approved' | 'pending';
};
export type ManufacturingDocument = {
  readonly provenance: ArtifactReference;
  readonly unit: 'mm';
  readonly sheets: readonly ManufacturingSheet[];
  readonly manifest: readonly PartManifest[];
  readonly outline?: OutlineDocumentMetadata;
};
export type ManufacturingProject = {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly sourceSha256: string;
  readonly provenance: ArtifactReference;
  readonly preflight: ExportPreflightEvidence;
  readonly document: ManufacturingDocument;
  readonly settings: Readonly<Record<string, unknown>>;
};

export function validateProject(project: ManufacturingProject): void {
  if (project.schemaVersion !== 1) throw new RangeError('Unsupported project schema version');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(project.name)) throw new RangeError('Project name must be a safe filename');
  if (!/^[0-9a-f]{64}$/i.test(project.sourceSha256)) throw new RangeError('Source SHA-256 fingerprint must contain 64 hexadecimal characters');
  const inputFingerprint = project.provenance?.inputFingerprint;
  if (!/^[0-9a-f]{64}$/i.test(inputFingerprint)
    || project.preflight?.inputFingerprint !== inputFingerprint
    || project.document?.provenance?.inputFingerprint !== inputFingerprint) {
    throw new RangeError('Manufacturing project artifacts must share one valid pipeline fingerprint');
  }
  if (!Array.isArray(project.preflight.issues) || !Array.isArray(project.preflight.acceptedConfirmations)
    || !Array.isArray(project.preflight.materialReadiness?.reasons)
    || !['ready', 'confirm', 'block'].includes(project.preflight.materialReadiness?.status)
    || !['approved', 'pending'].includes(project.preflight.physicalApproval)) {
    throw new RangeError('Manufacturing preflight evidence is invalid');
  }
  MaterialProfileSchema.parse(project.preflight.materialProfile);
  const acceptedConfirmations = new Set(project.preflight.acceptedConfirmations);
  if (acceptedConfirmations.size !== project.preflight.acceptedConfirmations.length
    || project.preflight.issues.some(({ code, severity, message }) => !code || !message || !['blocking', 'confirm', 'info'].includes(severity))) {
    throw new RangeError('Manufacturing preflight issue evidence is invalid');
  }
  if (project.document.unit !== 'mm' || project.document.sheets.length === 0) throw new RangeError('Manufacturing document must contain millimetre sheets');
  const partIds = new Set<string>();
  const assemblyOrders = new Set<number>();
  const quantities = new Map<string, number>();
  if (project.document.manifest.length === 0) throw new RangeError('Part manifest must not be empty');
  for (const item of project.document.manifest) {
    if (typeof item.partId !== 'string' || !item.partId || partIds.has(item.partId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1
      || !Number.isSafeInteger(item.assemblyOrder) || item.assemblyOrder < 1 || assemblyOrders.has(item.assemblyOrder)) {
      throw new RangeError('Part manifest assembly order and quantities must be unique and valid');
    }
    partIds.add(item.partId);
    assemblyOrders.add(item.assemblyOrder);
    quantities.set(item.partId, item.quantity);
  }
  if ([...assemblyOrders].sort((left, right) => left - right).some((order, index) => order !== index + 1)) {
    throw new RangeError('Part manifest assembly order must be contiguous from one');
  }

  const entityIds = new Set<string>();
  const cutEntities: { readonly entity: LayerEntity; readonly sheetIndex: number }[] = [];
  const outlines = new Map<string, { readonly entity: LayerEntity; readonly sheetIndex: number }>();
  for (const [sheetIndex, sheet] of project.document.sheets.entries()) {
    if (![sheet.width, sheet.height].every(Number.isFinite) || sheet.width <= 0 || sheet.height <= 0) throw new RangeError('Sheet dimensions must be finite and positive');
    for (const entity of sheet.entities) {
      if (typeof entity.id !== 'string' || !entity.id || entityIds.has(entity.id)) throw new RangeError('Manufacturing entity IDs must be non-empty and unique');
      entityIds.add(entity.id);
      const quantity = quantities.get(entity.partId);
      if (!LAYER_ORDER.includes(entity.layer) || quantity === undefined
        || !Number.isSafeInteger(entity.instance) || entity.instance < 0 || entity.instance >= quantity) {
        throw new RangeError('Entity must reference a valid manifest part instance and layer');
      }
      if (!entity.polygon || !Array.isArray(entity.polygon.points)
        || entity.polygon.points.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate)))) {
        throw new RangeError('Entity geometry must be finite and reference a manifest part');
      }
      if (!validatePolygon(entity.polygon)) throw new RangeError('Entity polygon geometry must be valid and non-self-intersecting');
      if (entity.layer !== 'CUT') {
        if (entity.contour !== 'process') throw new RangeError('Non-CUT entities must use the process contour');
        continue;
      }
      if (entity.contour !== 'outline' && entity.contour !== 'hole') throw new RangeError('CUT entities must identify an outline or hole contour');
      if (entity.polygon.points.some(([x, y]) => x < 0 || y < 0 || x > sheet.width || y > sheet.height)) {
        throw new RangeError('CUT polygon must remain within its material sheet bounds');
      }
      const indexed = { entity, sheetIndex };
      cutEntities.push(indexed);
      if (entity.contour === 'outline') {
        const key = partInstanceKey(entity);
        if (outlines.has(key)) throw new RangeError('Each manifest part instance must have exactly one CUT outline');
        outlines.set(key, indexed);
      }
    }
  }

  for (const item of project.document.manifest) {
    for (let instance = 0; instance < item.quantity; instance += 1) {
      if (!outlines.has(partInstanceKey({ partId: item.partId, instance }))) {
        throw new RangeError('CUT instance quantity does not match the part manifest');
      }
    }
  }
  if (outlines.size !== project.document.manifest.reduce((sum, item) => sum + item.quantity, 0)) {
    throw new RangeError('CUT instance quantity does not match the part manifest');
  }

  for (const indexed of cutEntities) {
    if (indexed.entity.contour !== 'hole') continue;
    const outline = outlines.get(partInstanceKey(indexed.entity));
    if (!outline || outline.sheetIndex !== indexed.sheetIndex || !strictlyContains(outline.entity.polygon, indexed.entity.polygon)) {
      throw new RangeError('CUT hole must be strictly contained by its matching part-instance outline');
    }
  }
  for (let leftIndex = 0; leftIndex < cutEntities.length; leftIndex += 1) {
    const left = cutEntities[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < cutEntities.length; rightIndex += 1) {
      const right = cutEntities[rightIndex];
      if (left.sheetIndex !== right.sheetIndex || isMatchingOutlineAndHole(left.entity, right.entity)) continue;
      if (polygonsIntersectOrTouch(left.entity.polygon, right.entity.polygon)) {
        throw new RangeError(`CUT polygons ${left.entity.id} and ${right.entity.id} overlap or touch`);
      }
    }
  }
}

function partInstanceKey(entity: Pick<LayerEntity, 'partId' | 'instance'>): string {
  return `${entity.partId}\u0000${entity.instance}`;
}

function isMatchingOutlineAndHole(left: LayerEntity, right: LayerEntity): boolean {
  return left.partId === right.partId && left.instance === right.instance
    && ((left.contour === 'outline' && right.contour === 'hole') || (left.contour === 'hole' && right.contour === 'outline'));
}

function strictlyContains(outline: Polygon2, hole: Polygon2): boolean {
  if (hole.points.some((point) => pointLocation(outline, point) !== 1)) return false;
  const holeArea = polygonMassProperties(hole).area;
  const intersectionArea = polygonIntersectionArea(outline, hole);
  const tolerance = Math.max(Number.MIN_VALUE, holeArea * 4096 * Number.EPSILON);
  return Number.isFinite(intersectionArea) && Math.abs(intersectionArea - holeArea) <= tolerance;
}

export function usedLayers(sheet: ManufacturingSheet): LayerName[] {
  const present = new Set(sheet.entities.map(({ layer }) => layer));
  return LAYER_ORDER.filter((layer) => present.has(layer));
}
