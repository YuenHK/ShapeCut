import type { Axis } from '../types';
import { estimateBalance } from '../decomposition/balance';
import { sampleLathedProfile } from '../decomposition/profile-sampler';
import type {
  DecompositionOptions,
  LathedProfile,
  MaterialInput,
  Part2D,
  Point2,
  Polygon2,
  SpinnerKit,
} from '../decomposition/types';
import type { EngravingLevelCount, EngravingMap, HeightField } from '../engraving/height-field';
import type { QuantizeOptions } from '../engraving/quantize';
import { validatePolygon } from '../engraving/geometry';
import { applyKerf } from '../layout/kerf';
import { nestParts, type NestResult, type PartPlacement } from '../layout/nest';
import { simpleMiterPolygonKernel } from '../layout/polygon-kernel';
import {
  classifyMaterialReadiness,
  type MaterialProfileV1,
  type MaterialReadiness,
} from '../materials/schema';
import type { MeshInspection, TriangleMesh } from '../mesh/types';
import { runPreflight } from '../preflight/run-preflight';
import type { LayerName, ManufacturingDocument, ManufacturingSheet } from '../../export/layers';

export const PIPELINE_SCHEMA_VERSION = 1 as const;

export type ManufacturingSettings = {
  readonly splitPositionPercent: number;
  readonly ribCount: number;
  readonly ringLayers: number;
  readonly shaftMm: number;
  readonly fit: DecompositionOptions['fit'];
  readonly materialId: string;
  readonly engravingLevels: EngravingLevelCount;
  readonly textureStrength: number;
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
};

export type RepairProvenanceV1 = {
  readonly mode: 'safe' | 'advanced';
  readonly algorithmVersion: string;
};

export type PipelineProvenanceV1 = {
  readonly schemaVersion: typeof PIPELINE_SCHEMA_VERSION;
  readonly sourceSha256: string;
  readonly meshSha256: string;
  readonly settingsFingerprint: string;
  readonly materialFingerprint: string;
  readonly axisFingerprint: string;
  readonly inputFingerprint: string;
  readonly repair: RepairProvenanceV1;
};

export type VersionedArtifact<T> = {
  readonly provenance: PipelineProvenanceV1;
  readonly value: T;
};

export type PipelineManufacturingDocument = ManufacturingDocument & {
  readonly provenance: PipelineProvenanceV1;
};

export type ManufacturingPipelineInput = {
  readonly sourceSha256: string;
  readonly meshSha256: string;
  readonly mesh: TriangleMesh;
  readonly meshInspection: MeshInspection;
  readonly repair: RepairProvenanceV1;
  readonly axis: Axis;
  readonly settings: ManufacturingSettings;
  readonly material: MaterialProfileV1;
};

export type ManufacturingPipelineWorker = {
  decompose(request: {
    readonly profile: LathedProfile;
    readonly material: MaterialInput;
    readonly options: DecompositionOptions;
  }): Promise<SpinnerKit>;
  engrave(request: {
    readonly field: HeightField;
    readonly levels: EngravingLevelCount;
    readonly options?: QuantizeOptions;
  }): Promise<EngravingMap>;
};

export type ManufacturingArtifacts = {
  readonly provenance: PipelineProvenanceV1;
  readonly profile: VersionedArtifact<LathedProfile>;
  readonly kit: VersionedArtifact<SpinnerKit>;
  readonly material: VersionedArtifact<{
    readonly profile: MaterialProfileV1;
    readonly readiness: MaterialReadiness;
  }>;
  readonly engraving: VersionedArtifact<{
    readonly targetPartId: string;
    readonly map: EngravingMap;
    readonly balance: SpinnerKit['estimatedBalance'];
  }>;
  readonly layout: VersionedArtifact<{ readonly kerfedParts: readonly Part2D[]; readonly nest: NestResult }>;
  readonly preflight: VersionedArtifact<ReturnType<typeof runPreflight>>;
  readonly document: VersionedArtifact<PipelineManufacturingDocument>;
};

export async function createManufacturingArtifacts(
  input: ManufacturingPipelineInput,
  worker: ManufacturingPipelineWorker,
): Promise<ManufacturingArtifacts> {
  validateInput(input);
  const axis = normalizeConfirmedAxis(input.axis);
  const provenance = await createProvenance(input, axis);
  const materialReadiness = classifyMaterialReadiness(input.material);
  const profile = sampleLathedProfile(input.mesh, axis, 64);
  const decompositionOptions: DecompositionOptions = {
    ribCount: input.settings.ribCount as DecompositionOptions['ribCount'],
    ringLayers: input.settings.ringLayers,
    shaftMm: input.settings.shaftMm,
    fit: input.settings.fit,
  };
  const materialInput: MaterialInput = {
    thicknessMm: input.material.thicknessMm,
    fitAllowanceMm: input.material.fitAllowanceMm,
  };
  const kit = await worker.decompose({ profile, material: materialInput, options: decompositionOptions });
  const { field, targetPartId } = createProfileHeightField(profile, kit, input.settings.textureStrength);
  const maximumRemoval = Math.max(0, input.material.thicknessMm - input.material.minRemainingMm) * input.settings.textureStrength;
  const levelDepthsMm = Array.from(
    { length: input.settings.engravingLevels + 1 },
    (_, level) => maximumRemoval * level / input.settings.engravingLevels,
  );
  const map = await worker.engrave({
    field,
    levels: input.settings.engravingLevels,
    options: {
      levelDepthsMm,
      sheetThicknessMm: input.material.thicknessMm,
      safeRemainingThicknessMm: input.material.minRemainingMm,
      center: [0, 0],
    },
  });
  const balance = estimateBalance(map);
  const kitWithBalance: SpinnerKit = { ...kit, estimatedBalance: balance };
  const kerfedParts = kitWithBalance.parts.map((part) => applyKerf(part, input.material.kerfMm, simpleMiterPolygonKernel));
  const margin = Math.max(1, input.material.minFeatureMm, input.material.kerfMm);
  if (input.settings.sheetWidthMm <= margin * 2 || input.settings.sheetHeightMm <= margin * 2) {
    throw new RangeError('Sheet is too small for the required manufacturing edge margin');
  }
  const innerNest = nestParts(kerfedParts, {
    widthMm: input.settings.sheetWidthMm - margin * 2,
    heightMm: input.settings.sheetHeightMm - margin * 2,
    spacingMm: Math.max(input.material.minFeatureMm, input.material.kerfMm),
  });
  const nest: NestResult = {
    sheets: innerNest.sheets.map((sheet) => ({
      ...sheet,
      widthMm: input.settings.sheetWidthMm,
      heightMm: input.settings.sheetHeightMm,
      placements: sheet.placements.map((placement) => ({
        ...placement,
        xMm: placement.xMm + margin,
        yMm: placement.yMm + margin,
      })),
    })),
  };
  const document = createManufacturingDocument(kitWithBalance, kerfedParts, map, targetPartId, nest, provenance);
  const maximumDepth = Math.max(...map.levelDepths);
  const minimumJointWeb = kitWithBalance.joints.length === 0
    ? input.material.thicknessMm
    : Math.min(...kitWithBalance.joints.map(({ depthMm, widthMm }) => Math.min(depthMm, widthMm)));
  const preflight = runPreflight({
    meshInspection: input.meshInspection,
    axisConfirmed: axis.confirmed,
    balance,
    material: {
      safe: materialReadiness.status !== 'block',
      calibrated: materialReadiness.status === 'ready',
      minFeatureMm: input.material.minFeatureMm,
      minWebMm: input.material.minWebMm,
      minRemainingMm: input.material.minRemainingMm,
    },
    measurements: {
      minimumFeatureMm: Math.min(input.material.thicknessMm, input.settings.shaftMm, minimumJointWeb),
      minimumWebMm: Math.min(input.material.thicknessMm, minimumJointWeb),
      minimumRemainingMm: input.material.thicknessMm - maximumDepth,
      minimumJointWebMm: minimumJointWeb,
    },
    layout: layoutAudit(document),
  });
  const envelope = <T>(value: T): VersionedArtifact<T> => ({ provenance, value });
  return {
    provenance,
    profile: envelope(profile),
    kit: envelope(kitWithBalance),
    material: envelope({ profile: structuredClone(input.material), readiness: materialReadiness }),
    engraving: envelope({ targetPartId, map, balance }),
    layout: envelope({ kerfedParts, nest }),
    preflight: envelope(preflight),
    document: envelope(document),
  };
}

function validateInput(input: ManufacturingPipelineInput): void {
  if (!/^[0-9a-f]{64}$/iu.test(input.sourceSha256) || !/^[0-9a-f]{64}$/iu.test(input.meshSha256)) {
    throw new RangeError('Pipeline source and repaired mesh fingerprints must be SHA-256 values');
  }
  if (input.settings.materialId !== input.material.id) throw new RangeError('Selected material does not match the loaded material profile');
  if (![input.settings.splitPositionPercent, input.settings.ringLayers, input.settings.shaftMm, input.settings.textureStrength, input.settings.sheetWidthMm, input.settings.sheetHeightMm].every(Number.isFinite)) {
    throw new RangeError('Pipeline settings must be finite');
  }
  if (input.settings.textureStrength < 0 || input.settings.textureStrength > 1) throw new RangeError('Texture strength must be between zero and one');
  if (![4, 6, 8, 10, 12].includes(input.settings.ribCount)) throw new RangeError('Rib count is unsupported');
}

function normalizeConfirmedAxis(axis: Axis): Axis {
  if (!axis.confirmed || ![...axis.origin, ...axis.direction, axis.confidence].every(Number.isFinite)) {
    throw new RangeError('Manufacturing requires an explicitly confirmed finite axis');
  }
  const length = Math.hypot(...axis.direction);
  if (!(length > 0)) throw new RangeError('Manufacturing axis direction must be non-zero');
  return {
    origin: [...axis.origin],
    direction: [axis.direction[0] / length, axis.direction[1] / length, axis.direction[2] / length],
    confidence: axis.confidence,
    confirmed: true,
  };
}

async function createProvenance(input: ManufacturingPipelineInput, axis: Axis): Promise<PipelineProvenanceV1> {
  const settingsFingerprint = await sha256Canonical(input.settings);
  const materialFingerprint = await sha256Canonical(input.material);
  const axisFingerprint = await sha256Canonical(axis);
  const inputFingerprint = await sha256Canonical({
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    sourceSha256: input.sourceSha256.toLowerCase(),
    meshSha256: input.meshSha256.toLowerCase(),
    settingsFingerprint,
    materialFingerprint,
    axisFingerprint,
    repair: input.repair,
  });
  return {
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    sourceSha256: input.sourceSha256.toLowerCase(),
    meshSha256: input.meshSha256.toLowerCase(),
    settingsFingerprint,
    materialFingerprint,
    axisFingerprint,
    inputFingerprint,
    repair: { ...input.repair },
  };
}

function createProfileHeightField(
  profile: LathedProfile,
  kit: SpinnerKit,
  textureStrength: number,
): { readonly field: HeightField; readonly targetPartId: string } {
  const target = kit.parts.find(({ kind }) => kind === 'hub-layer') ?? kit.parts[0];
  if (!target) throw new RangeError('Decomposition produced no engravable part');
  const outerRadius = Math.min(...target.outline.points.map(([x, y]) => Math.hypot(x, y)));
  const holeRadius = target.holes.length === 0
    ? 0
    : Math.max(...target.holes.flatMap(({ points }) => points.map(([x, y]) => Math.hypot(x, y))));
  const span = outerRadius - holeRadius;
  if (!(span > 0)) throw new RangeError('Engraving target has no safe radial material band');
  const inner = holeRadius + span * 0.2;
  const outer = holeRadius + span * 0.65;
  const radialBands = Math.min(4, Math.max(2, profile.samples.length - 1));
  const sectors = Math.max(4, kit.parts.filter(({ kind }) => kind === 'rib').length || 4);
  const cells: HeightField['cells'][number][] = [];
  for (let band = 0; band < radialBands; band += 1) {
    const radialStart = inner + (outer - inner) * band / radialBands;
    const radialEnd = inner + (outer - inner) * (band + 1) / radialBands;
    const sample = profile.samples[Math.round(band * (profile.samples.length - 1) / Math.max(1, radialBands - 1))];
    for (let sector = 0; sector < sectors; sector += 1) {
      const start = sector * Math.PI * 2 / sectors;
      const end = (sector + 1) * Math.PI * 2 / sectors;
      const polygon: Polygon2 = { points: [
        polar(radialStart, start),
        polar(radialEnd, start),
        polar(radialEnd, end),
        polar(radialStart, end),
      ] };
      if (!validatePolygon(polygon)) throw new RangeError('Profile height field produced invalid geometry');
      cells.push({ heightMm: sample.radius * textureStrength, polygon });
    }
  }
  return { field: { cells }, targetPartId: target.id };
}

function polar(radius: number, angle: number): Point2 {
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

function createManufacturingDocument(
  kit: SpinnerKit,
  kerfedParts: readonly Part2D[],
  engraving: EngravingMap,
  engravingPartId: string,
  nest: NestResult,
  provenance: PipelineProvenanceV1,
): PipelineManufacturingDocument {
  const parts = new Map(kerfedParts.map((part) => [part.id, part]));
  const sheets: ManufacturingSheet[] = nest.sheets.map((sheet) => {
    const entities: ManufacturingSheet['entities'][number][] = [];
    for (const placement of sheet.placements) {
      const part = parts.get(placement.partId);
      if (!part) throw new RangeError(`Layout references missing part ${placement.partId}`);
      const transform = placementTransform(part, placement);
      entities.push({
        id: `${part.id}-instance-${placement.instance}-outline`,
        partId: part.id,
        layer: 'CUT',
        polygon: translatePolygon(part.outline, transform),
      });
      part.holes.forEach((hole, index) => entities.push({
        id: `${part.id}-instance-${placement.instance}-hole-${index}`,
        partId: part.id,
        layer: 'CUT',
        polygon: translatePolygon(hole, transform),
      }));
      if (part.id === engravingPartId) for (const [index, region] of engraving.regions.entries()) {
        if (region.level === 0) continue;
        entities.push({
          id: `${part.id}-instance-${placement.instance}-engrave-${index}`,
          partId: part.id,
          layer: `ENGRAVE_${region.level}` as LayerName,
          polygon: translatePolygon(region.polygon, transform),
        });
      }
    }
    return { width: sheet.widthMm, height: sheet.heightMm, entities };
  });
  return {
    unit: 'mm',
    sheets,
    manifest: kit.parts.map(({ id, quantity }, index) => ({ partId: id, quantity, assemblyOrder: index + 1 })),
    provenance,
  };
}

function placementTransform(part: Part2D, placement: PartPlacement): Point2 {
  const minimumX = Math.min(...part.outline.points.map(([x]) => x));
  const minimumY = Math.min(...part.outline.points.map(([, y]) => y));
  return [placement.xMm - minimumX, placement.yMm - minimumY];
}

function translatePolygon(polygon: Polygon2, [x, y]: Point2): Polygon2 {
  return { points: polygon.points.map(([pointX, pointY]) => [pointX + x, pointY + y]) };
}

function layoutAudit(document: PipelineManufacturingDocument) {
  const outOfBoundsPartIds: string[] = [];
  let edgeClearanceMm = Infinity;
  for (const sheet of document.sheets) for (const entity of sheet.entities.filter(({ layer }) => layer === 'CUT')) {
    for (const [x, y] of entity.polygon.points) {
      if (x < 0 || y < 0 || x > sheet.width || y > sheet.height) outOfBoundsPartIds.push(entity.partId);
      edgeClearanceMm = Math.min(edgeClearanceMm, x, y, sheet.width - x, sheet.height - y);
    }
  }
  return {
    outOfBoundsPartIds: [...new Set(outOfBoundsPartIds)],
    overlapPairs: [] as readonly (readonly [string, string])[],
    edgeClearanceMm,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

async function sha256Canonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
