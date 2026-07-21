import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
} from 'pdf-lib';
import { expect, type Download, type Page } from '@playwright/test';

export const COLORED_ROLES = ['CUT_BLACK', 'DEEP_RED', 'LIGHT_BLUE'] as const;
export type ColoredRole = typeof COLORED_ROLES[number];

const ROLE_COLORS: Readonly<Record<ColoredRole, string>> = Object.freeze({
  CUT_BLACK: '#000000',
  DEEP_RED: '#E5484D',
  LIGHT_BLUE: '#3A78D4',
});
const ROLE_DXF: Readonly<Record<ColoredRole, { readonly aci: number; readonly trueColor: number }>> = Object.freeze({
  CUT_BLACK: { aci: 7, trueColor: 0 },
  DEEP_RED: { aci: 1, trueColor: 0xE5484D },
  LIGHT_BLUE: { aci: 5, trueColor: 0x3A78D4 },
});
const PDF_ROLE_RGB: Readonly<Record<ColoredRole, readonly [number, number, number]>> = Object.freeze({
  CUT_BLACK: [0, 0, 0],
  DEEP_RED: [0xe5 / 255, 0x48 / 255, 0x4d / 255],
  LIGHT_BLUE: [0x3a / 255, 0x78 / 255, 0xd4 / 255],
});
const EXPECTED_ZIP_NAMES = Object.freeze([
  'cut-and-engrave.svg',
  'cut-and-engrave.dxf',
  'preview.pdf',
  'exploded-view.pdf',
] as const);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const HASH = /^[0-9a-f]{32}$/i;
const MM_TO_POINTS = 72 / 25.4;

export type ColoredEntityRecord = {
  readonly physicalLayerId: string;
  readonly order: number;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly role: ColoredRole;
  readonly id: string;
  readonly points: readonly (readonly number[])[];
};

export type ColoredLayerRecord = {
  readonly id: string;
  readonly order: number;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly roleGroups: readonly {
    readonly role: ColoredRole;
    readonly color: string;
    readonly entityCount: number;
  }[];
};

export type ColoredFingerprints = {
  readonly sourceHash: string;
  readonly featureEvidenceFingerprint: string;
  readonly diagnosticsFingerprint: string;
};

export type ParsedColoredArtifact = ColoredFingerprints & {
  readonly layers: readonly ColoredLayerRecord[];
  readonly entities: readonly ColoredEntityRecord[];
  readonly entityCounts: Readonly<Record<ColoredRole, number>>;
};

export type PdfGeometryRecord = {
  readonly role: ColoredRole;
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
};

type PdfStrokeRecord = {
  readonly color: readonly [number, number, number];
  readonly role?: ColoredRole;
  readonly thickness: number;
  readonly dashArray: readonly number[];
  readonly dashPhase: number;
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
};

export type PdfLayerRecord = {
  readonly id: string;
  readonly order: number;
  readonly thickness?: number;
  readonly width?: number;
  readonly height?: number;
  readonly holeDiameter?: number | null;
};

export type ParsedColoredPdf = {
  readonly kind: 'preview' | 'exploded';
  readonly fingerprints: ColoredFingerprints;
  readonly layerRecords: readonly PdfLayerRecord[];
  readonly geometryRecords: readonly PdfGeometryRecord[];
  readonly strokeRecords: readonly PdfStrokeRecord[];
  readonly pageSize: readonly [number, number];
  readonly textBlockCount: number;
  readonly keywords: readonly string[];
};

export type ColoredArtifactPayloads = {
  readonly zip: Uint8Array;
  readonly svg: string;
  readonly dxf: string;
  readonly previewPdf: Uint8Array;
  readonly explodedPdf: Uint8Array;
};

export type ParsedColoredZipRecord = {
  readonly name: typeof EXPECTED_ZIP_NAMES[number];
  readonly payload: Uint8Array;
};

export type DownloadedOutline = ColoredFingerprints & {
  readonly layers: readonly ColoredLayerRecord[];
  readonly entities: readonly ColoredEntityRecord[];
  readonly entityCounts: Readonly<Record<ColoredRole, number>>;
  readonly previewPdf: ParsedColoredPdf;
  readonly explodedPdf: ParsedColoredPdf;
  readonly zipRecords: readonly (ParsedColoredZipRecord & { readonly byteIdentical: boolean })[];
  readonly sha256: string;
};

export type WorkerResultSummary = {
  readonly mode: 'exact' | 'outline-2.5d';
  readonly status: 'success' | 'warning';
  readonly removedComponentCount: number;
  readonly coloredLayers: readonly {
    readonly id: string;
    readonly widthMm: number;
    readonly planarDiameterMm: number;
    readonly cellSizeMm: number;
    readonly exteriorPoints: readonly (readonly [number, number])[];
    readonly hole: {
      readonly status: 'retained' | 'omitted';
      readonly equivalentDiameterMm?: number;
      readonly axisDistanceMm?: number;
      readonly areaMm2?: number;
      readonly points?: readonly (readonly [number, number])[];
    };
    readonly hasDeep: boolean;
    readonly hasLight: boolean;
  }[];
};

export type WorkerProbeState = {
  readonly results: readonly WorkerResultSummary[];
  readonly errorCodes: readonly string[];
  readonly created: number;
  readonly terminated: number;
  readonly packageRequests: number;
  readonly packageCheckpoints: readonly string[];
  readonly replacementTriggered: number;
  readonly replacementCheckpoint?: string;
  readonly applyPaths: readonly string[];
};

type MutableSvgRoleGroup = {
  role: ColoredRole;
  color: string;
  declaredCount: number;
  entities: ColoredEntityRecord[];
};

type MutableSvgLayer = {
  id: string;
  order: number;
  index: number;
  zStart: number;
  zEnd: number;
  roleGroups: MutableSvgRoleGroup[];
};

function exact(value: unknown): string {
  return JSON.stringify(value);
}

function safeFinite(value: string, label: string): number {
  if (value.trim() === '') throw new Error(`${label} must be finite`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function safeInteger(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function exactAttributes(tag: string, names: readonly string[], label: string): Readonly<Record<string, string>> {
  const lexical = [...tag.matchAll(/\s([A-Za-z_:][A-Za-z0-9:._-]*)\s*=/g)].map((match) => match[1]);
  const parsed = [...tag.matchAll(/\s([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*"([^"]*)"/g)];
  if (lexical.length !== parsed.length || new Set(lexical).size !== lexical.length
    || exact([...lexical].sort()) !== exact([...names].sort())) {
    throw new Error(`${label} must contain exactly one quoted value for every canonical attribute`);
  }
  return Object.fromEntries(parsed.map((match) => [match[1], match[2]]));
}

function roleCounts(entities: readonly ColoredEntityRecord[]): Readonly<Record<ColoredRole, number>> {
  return Object.freeze(Object.fromEntries(COLORED_ROLES.map((role) => [
    role,
    entities.filter((entity) => entity.role === role).length,
  ])) as Record<ColoredRole, number>);
}

function countString(counts: Readonly<Record<ColoredRole, number>>): string {
  return COLORED_ROLES.map((role) => `${role}:${counts[role]}`).join(',');
}

function signedArea(points: readonly (readonly number[])[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function validateEntityRecords(entities: readonly ColoredEntityRecord[], label: string): void {
  if (entities.length === 0) throw new Error(`${label} contains no colored entities`);
  const ids = new Set<string>();
  let lastOrder = 0;
  const layerRoles = new Map<string, ColoredRole[]>();
  for (const entity of entities) {
    if (!SAFE_ID.test(entity.id) || !SAFE_ID.test(entity.physicalLayerId) || ids.has(entity.id)) {
      throw new Error(`${label} contains malformed or duplicate feature identity`);
    }
    if (!Number.isSafeInteger(entity.order) || entity.order < 1 || !Number.isSafeInteger(entity.index)
      || entity.index < 0 || !Number.isFinite(entity.zStart) || !Number.isFinite(entity.zEnd)
      || entity.zEnd <= entity.zStart || entity.order < lastOrder) {
      throw new Error(`${label} contains malformed or out-of-order physical layer metadata`);
    }
    if (entity.points.length < 3 || entity.points.length > 4096
      || entity.points.some((point) => point.length !== 2 || !point.every(Number.isFinite))) {
      throw new Error(`${label} contains invalid point geometry`);
    }
    if (new Set(entity.points.map((point) => point.join(','))).size !== entity.points.length) {
      throw new Error(`${label} contains duplicate polygon vertices`);
    }
    ids.add(entity.id);
    lastOrder = entity.order;
    const key = `${entity.order}:${entity.physicalLayerId}`;
    const roles = layerRoles.get(key) ?? [];
    roles.push(entity.role);
    layerRoles.set(key, roles);
  }
  for (const roles of layerRoles.values()) {
    const counts = Object.fromEntries(COLORED_ROLES.map((role) => [role, roles.filter((item) => item === role).length])) as Record<ColoredRole, number>;
    if (counts.CUT_BLACK < 1 || counts.CUT_BLACK > 2 || counts.DEEP_RED > 1 || counts.LIGHT_BLUE > 1
      || exact(roles) !== exact(COLORED_ROLES.flatMap((role) => Array.from({ length: counts[role] }, () => role)))) {
      throw new Error(`${label} role encounter order or per-layer cardinality is invalid`);
    }
  }
}

function parsePoints(value: string, label: string): readonly (readonly number[])[] {
  if (value.trim() !== value || value === '') throw new Error(`${label} points are malformed`);
  return value.split(' ').map((pair) => {
    const components = pair.split(',');
    if (components.length !== 2) throw new Error(`${label} point is malformed`);
    return components.map((component) => safeFinite(component, `${label} point`));
  });
}

function fingerprintsFromValues(values: ColoredFingerprints, label: string): ColoredFingerprints {
  if (!HASH.test(values.sourceHash) || !HASH.test(values.featureEvidenceFingerprint)
    || !HASH.test(values.diagnosticsFingerprint)) {
    throw new Error(`${label} contains malformed fingerprints`);
  }
  return values;
}

export function parseColoredOutlineSvgArtifact(svg: string): ParsedColoredArtifact {
  const roots = [...svg.matchAll(/<svg\b[^>]*>/g)];
  if (roots.length !== 1 || [...svg.matchAll(/<\/svg>/g)].length !== 1) {
    throw new Error('Colored SVG must contain exactly one root');
  }
  const root = exactAttributes(roots[0][0], [
    'xmlns', 'width', 'height', 'viewBox', 'data-outline-source-hash',
    'data-feature-evidence-fingerprint', 'data-diagnostics-fingerprint', 'data-entity-counts',
  ], 'Colored SVG root');
  const fingerprints = fingerprintsFromValues({
    sourceHash: root['data-outline-source-hash'],
    featureEvidenceFingerprint: root['data-feature-evidence-fingerprint'],
    diagnosticsFingerprint: root['data-diagnostics-fingerprint'],
  }, 'Colored SVG');

  const allTags = [...svg.matchAll(/<[^>]*>/g)].map((match) => match[0]);
  const allowedTag = /^(?:<\?xml version="1\.0" encoding="UTF-8"\?>|<svg\b[^>]*>|<\/svg>|<g\b[^>]*>|<\/g>|<polygon\b[^>]*\/>)$/;
  if (allTags.length === 0 || allTags[0] !== '<?xml version="1.0" encoding="UTF-8"?>'
    || allTags.some((tag) => !allowedTag.test(tag)) || svg.replace(/<[^>]*>/g, '') !== '') {
    throw new Error('Colored SVG contains text, comments, or an element outside the canonical SVG/g/polygon grammar');
  }
  const drawableTags = [...svg.matchAll(/<(?!\/)(path|circle|ellipse|rect|line|polyline|polygon|image|use)\b[^>]*>/gi)];
  if (drawableTags.some((match) => match[1].toLowerCase() !== 'polygon')
    || drawableTags.length !== [...svg.matchAll(/<polygon\b/g)].length) {
    throw new Error('Colored SVG contains a non-canonical drawable outside its polygon records');
  }

  const tokens = [...svg.matchAll(/<g\b[^>]*>|<\/g>|<polygon\b[^>]*\/>/g)].map((match) => match[0]);
  if (tokens.filter((token) => token.startsWith('<g')).length !== [...svg.matchAll(/<g\b/g)].length
    || tokens.filter((token) => token.startsWith('<polygon')).length !== [...svg.matchAll(/<polygon\b/g)].length) {
    throw new Error('Colored SVG contains a malformed group or polygon');
  }
  const stack: Array<{ kind: 'layer'; value: MutableSvgLayer } | { kind: 'role'; value: MutableSvgRoleGroup }> = [];
  const layers: MutableSvgLayer[] = [];
  const entities: ColoredEntityRecord[] = [];
  for (const token of tokens) {
    if (token === '</g>') {
      const closed = stack.pop();
      if (!closed) throw new Error('Colored SVG contains an unmatched group close');
      if (closed.kind === 'role') {
        if (closed.value.entities.length !== closed.value.declaredCount || stack.at(-1)?.kind !== 'layer') {
          throw new Error('Colored SVG role group entity count is inconsistent');
        }
        (stack.at(-1) as { kind: 'layer'; value: MutableSvgLayer }).value.roleGroups.push(closed.value);
      } else {
        if (stack.length !== 0 || exact(closed.value.roleGroups.map(({ role }) => role)) !== exact(COLORED_ROLES)) {
          throw new Error('Colored SVG physical layer must contain exactly three canonical role groups');
        }
        layers.push(closed.value);
      }
      continue;
    }
    if (token.startsWith('<g')) {
      if (stack.length === 0) {
        const attrs = exactAttributes(token, ['id', 'data-layer-id', 'data-order', 'data-index', 'data-z-start', 'data-z-end'], 'Colored SVG physical layer');
        const order = safeInteger(attrs['data-order'], 'Colored SVG layer order');
        if (attrs.id !== `physical-layer-${order}` || !SAFE_ID.test(attrs['data-layer-id'])) {
          throw new Error('Colored SVG physical layer identity is malformed');
        }
        stack.push({ kind: 'layer', value: {
          id: attrs['data-layer-id'], order,
          index: safeInteger(attrs['data-index'], 'Colored SVG layer index'),
          zStart: safeFinite(attrs['data-z-start'], 'Colored SVG zStart'),
          zEnd: safeFinite(attrs['data-z-end'], 'Colored SVG zEnd'),
          roleGroups: [],
        } });
      } else if (stack.length === 1 && stack[0].kind === 'layer') {
        const attrs = exactAttributes(token, ['id', 'data-role', 'data-color', 'data-entity-count'], 'Colored SVG role group');
        const role = attrs['data-role'] as ColoredRole;
        if (!COLORED_ROLES.includes(role) || attrs.id !== role || attrs['data-color'] !== ROLE_COLORS[role]) {
          throw new Error('Colored SVG role group or canonical color is inconsistent');
        }
        stack.push({ kind: 'role', value: {
          role, color: attrs['data-color'],
          declaredCount: safeInteger(attrs['data-entity-count'], 'Colored SVG role entity count'),
          entities: [],
        } });
      } else {
        throw new Error('Colored SVG group nesting is invalid');
      }
      continue;
    }
    const layer = stack[0]?.kind === 'layer' ? stack[0].value : undefined;
    const group = stack[1]?.kind === 'role' ? stack[1].value : undefined;
    if (!layer || !group || stack.length !== 2) throw new Error('Colored SVG polygon is outside a canonical role group');
    const attrs = exactAttributes(token, [
      'id', 'data-physical-layer', 'data-order', 'data-index', 'data-z-start', 'data-z-end',
      'data-role', 'points', 'fill', 'stroke',
    ], 'Colored SVG polygon');
    const role = attrs['data-role'] as ColoredRole;
    const entity: ColoredEntityRecord = {
      physicalLayerId: attrs['data-physical-layer'],
      order: safeInteger(attrs['data-order'], 'Colored SVG entity order'),
      index: safeInteger(attrs['data-index'], 'Colored SVG entity index'),
      zStart: safeFinite(attrs['data-z-start'], 'Colored SVG entity zStart'),
      zEnd: safeFinite(attrs['data-z-end'], 'Colored SVG entity zEnd'),
      role,
      id: attrs.id,
      points: parsePoints(attrs.points, 'Colored SVG entity'),
    };
    if (!COLORED_ROLES.includes(role) || role !== group.role || attrs.stroke !== ROLE_COLORS[role]
      || attrs.fill !== 'none' || entity.physicalLayerId !== layer.id || entity.order !== layer.order
      || entity.index !== layer.index || entity.zStart !== layer.zStart || entity.zEnd !== layer.zEnd) {
      throw new Error('Colored SVG entity role, color, or physical-layer metadata is inconsistent');
    }
    group.entities.push(entity);
    entities.push(entity);
  }
  if (stack.length !== 0 || layers.length === 0) throw new Error('Colored SVG has unclosed or missing groups');
  if (new Set(layers.map(({ id }) => id)).size !== layers.length
    || new Set(layers.map(({ index }) => index)).size !== layers.length
    || layers.some((layer, index) => layer.order !== index + 1 || layer.zEnd <= layer.zStart
      || index > 0 && (layer.index <= layers[index - 1].index || layer.zStart < layers[index - 1].zEnd))) {
    throw new Error('Colored SVG contains duplicate or out-of-order layer identity');
  }
  validateEntityRecords(entities, 'Colored SVG');
  for (const layer of layers) {
    const black = layer.roleGroups[0].entities;
    if (signedArea(black[0].points) >= 0 || black.slice(1).some(({ points }) => signedArea(points) <= 0)
      || layer.roleGroups.slice(1).some((group) => group.entities.some(({ points }) => signedArea(points) >= 0))) {
      throw new Error('Colored SVG exterior, central-hole, or feature orientation is invalid');
    }
  }
  const entityCounts = roleCounts(entities);
  if (root['data-entity-counts'] !== countString(entityCounts)) {
    throw new Error('Colored SVG root entity counts are inconsistent');
  }
  return {
    ...fingerprints,
    layers: layers.map(({ id, order, index, zStart, zEnd, roleGroups }) => ({
      id, order, index, zStart, zEnd,
      roleGroups: roleGroups.map(({ role, color, declaredCount }) => ({ role, color, entityCount: declaredCount })),
    })),
    entities,
    entityCounts,
  };
}

function uniqueDxfMarker(dxf: string, marker: string, valuePattern: string, label: string): string {
  const lexical = [...dxf.matchAll(new RegExp(`999\\n${marker}:`, 'g'))];
  const parsed = [...dxf.matchAll(new RegExp(`999\\n${marker}:(${valuePattern})\\n`, 'g'))];
  if (lexical.length !== 1 || parsed.length !== 1) throw new Error(`Colored DXF ${label} marker is malformed or duplicated`);
  return parsed[0][1];
}

export function parseColoredOutlineDxfArtifact(dxf: string): Omit<ParsedColoredArtifact, 'layers'> {
  const fingerprints = fingerprintsFromValues({
    sourceHash: uniqueDxfMarker(dxf, 'OUTLINE_SOURCE_HASH', '[^\\n]+', 'source'),
    featureEvidenceFingerprint: uniqueDxfMarker(dxf, 'FEATURE_EVIDENCE_FINGERPRINT', '[^\\n]+', 'feature fingerprint'),
    diagnosticsFingerprint: uniqueDxfMarker(dxf, 'DIAGNOSTICS_FINGERPRINT', '[^\\n]+', 'diagnostics fingerprint'),
  }, 'Colored DXF');
  const declaredCounts = uniqueDxfMarker(dxf, 'ENTITY_COUNTS', '[^\\n]+', 'entity counts');
  const layerTables = [...dxf.matchAll(/0\nLAYER\n2\n([^\n]+)\n70\n0\n62\n(\d+)\n420\n(\d+)\n6\nCONTINUOUS\n/g)];
  if (layerTables.length !== 3 || [...dxf.matchAll(/0\nLAYER\n/g)].length !== layerTables.length) {
    throw new Error('Colored DXF must contain exactly three canonical layer table records');
  }
  layerTables.forEach((match, index) => {
    const role = match[1] as ColoredRole;
    if (role !== COLORED_ROLES[index] || Number(match[2]) !== ROLE_DXF[role].aci
      || Number(match[3]) !== ROLE_DXF[role].trueColor) {
      throw new Error('Colored DXF layer role or color is inconsistent');
    }
  });
  if (!dxf.endsWith('\n')) throw new Error('Colored DXF canonical record stream must end with a newline');
  const lines = dxf.slice(0, -1).split('\n');
  if (lines.length % 2 !== 0) throw new Error('Colored DXF contains an incomplete code/value record');
  if (lines.filter((_, index) => index % 2 === 0).some((code) => !/^(?:0|[1-9]\d*)$/.test(code))) {
    throw new Error('Colored DXF contains a non-canonical numeric group code');
  }
  const pairs = Array.from({ length: lines.length / 2 }, (_, index) => [lines[index * 2], lines[index * 2 + 1]] as const);
  const entitySectionStarts = pairs.flatMap((pair, index) => (
    pair[0] === '0' && pair[1] === 'SECTION' && pairs[index + 1]?.[0] === '2' && pairs[index + 1]?.[1] === 'ENTITIES'
      ? [index + 2]
      : []
  ));
  if (entitySectionStarts.length !== 1) throw new Error('Colored DXF must contain exactly one canonical ENTITIES section');
  const entityEnd = pairs.findIndex((pair, index) => index >= entitySectionStarts[0] && pair[0] === '0' && pair[1] === 'ENDSEC');
  if (entityEnd < 0) throw new Error('Colored DXF ENTITIES section is not terminated');
  const entityTypes = pairs.slice(entitySectionStarts[0], entityEnd)
    .filter(([code]) => code === '0')
    .map(([, value]) => value);
  if (entityTypes.some((type) => type !== 'LWPOLYLINE')) {
    throw new Error(`Colored DXF contains a non-canonical drawable entity: ${entityTypes.find((type) => type !== 'LWPOLYLINE')}`);
  }
  const rawEntitySections = [...dxf.matchAll(/0\nSECTION\n2\nENTITIES\n([\s\S]*?)0\nENDSEC\n/g)];
  if (rawEntitySections.length !== 1) throw new Error('Colored DXF ENTITIES lexical stream is malformed');
  const entityBody = rawEntitySections[0][1];
  const entityPattern = /999\nENTITY_ID:([^\n]+)\n999\nPHYSICAL_LAYER:([^:\n]+):(\d+):(\d+):([^:\n]+):([^\n]+)\n0\nLWPOLYLINE\n8\n(CUT_BLACK|DEEP_RED|LIGHT_BLUE)\n62\n(\d+)\n420\n(\d+)\n90\n(\d+)\n70\n1\n((?:10\n[^\n]+\n20\n[^\n]+\n)+)/g;
  const matches = [...entityBody.matchAll(entityPattern)];
  if (matches.map((match) => match[0]).join('') !== entityBody
    || [...entityBody.matchAll(/999\nENTITY_ID:/g)].length !== matches.length
    || [...entityBody.matchAll(/999\nPHYSICAL_LAYER:/g)].length !== matches.length
    || entityTypes.length !== matches.length
    || [...dxf.matchAll(/0\nLWPOLYLINE\n/g)].length !== matches.length) {
    throw new Error('Colored DXF contains malformed, duplicate, or extra entity markers');
  }
  const entities = matches.map((match): ColoredEntityRecord => {
    const role = match[7] as ColoredRole;
    if (Number(match[8]) !== ROLE_DXF[role].aci || Number(match[9]) !== ROLE_DXF[role].trueColor) {
      throw new Error('Colored DXF entity role color is inconsistent');
    }
    const points = [...match[11].matchAll(/10\n([^\n]+)\n20\n([^\n]+)\n/g)].map((point) => [
      safeFinite(point[1], 'Colored DXF X'), safeFinite(point[2], 'Colored DXF Y'),
    ]);
    if (points.length !== safeInteger(match[10], 'Colored DXF point count')) {
      throw new Error('Colored DXF point count is inconsistent');
    }
    return {
      id: match[1], physicalLayerId: match[2],
      order: safeInteger(match[3], 'Colored DXF entity order'),
      index: safeInteger(match[4], 'Colored DXF entity index'),
      zStart: safeFinite(match[5], 'Colored DXF entity zStart'),
      zEnd: safeFinite(match[6], 'Colored DXF entity zEnd'),
      role, points,
    };
  });
  validateEntityRecords(entities, 'Colored DXF');
  const entityCounts = roleCounts(entities);
  if (declaredCounts !== countString(entityCounts)) throw new Error('Colored DXF entity counts are inconsistent');
  return { ...fingerprints, entities, entityCounts };
}

function pdfRole(rgb: readonly number[]): ColoredRole | undefined {
  return COLORED_ROLES.find((role) => rgb.every((value, index) => Math.abs(value - PDF_ROLE_RGB[role][index]) < 1e-6));
}

function pdfContentStreams(pdf: PDFDocument): readonly string[] {
  const decoder = new TextDecoder('latin1');
  return pdf.getPages().flatMap((page) => {
    const contents = page.node.Contents();
    if (!contents) return [];
    const values = contents instanceof PDFArray ? contents.asArray() : [contents];
    return values.map((value) => {
      const stream = pdf.context.lookup(value);
      if (!(stream instanceof PDFRawStream)) throw new Error('Colored PDF contains a non-raw content stream');
      return decoder.decode(decodePDFRawStream(stream).decode());
    });
  });
}

function parsePdfGeometry(pdf: PDFDocument): {
  readonly strokes: readonly PdfStrokeRecord[];
  readonly textBlockCount: number;
  readonly pageSize: readonly [number, number];
} {
  const streams = pdfContentStreams(pdf);
  if (streams.length !== 1) throw new Error('Colored PDF must contain exactly one canonical content stream');
  const lines = streams[0].split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.trim() !== line || line === '')) {
    throw new Error('Colored PDF content stream has non-canonical whitespace');
  }
  const blocks: string[][] = [];
  let block: string[] | undefined;
  for (const line of lines) {
    if (line === 'q') {
      if (block) throw new Error('Colored PDF drawing stream contains a non-canonical nested graphics state');
      block = [line];
      continue;
    }
    if (line === 'Q') {
      if (!block) throw new Error('Colored PDF drawing stream contains an unmatched graphics-state close');
      block.push(line);
      blocks.push(block);
      block = undefined;
      continue;
    }
    if (!block) throw new Error('Colored PDF contains an operator outside a canonical graphics-state block');
    block.push(line);
  }
  if (block) throw new Error('Colored PDF drawing stream contains an unclosed graphics state');

  const number = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const rgbPattern = new RegExp(`^(${number}) (${number}) (${number}) RG$`);
  const scalarPattern = new RegExp(`^(${number}) w$`);
  const dashPattern = new RegExp(`^\\[(${number}(?: ${number})*)?\\] (${number}) d$`);
  const pointPattern = (operator: 'm' | 'l') => new RegExp(`^(${number}) (${number}) ${operator}$`);
  const strokes: PdfStrokeRecord[] = [];
  let textBlockCount = 0;
  for (const candidate of blocks) {
    if (candidate[1] === 'BT') {
      if (candidate.length !== 10 || candidate[2] !== '0 0 0 rg'
        || !/^\/Helvetica-\d+ (?:7|8) Tf$/.test(candidate[3])
        || candidate[4] !== '24 TL'
        || !(new RegExp(`^1 0 0 1 ${number} ${number} Tm$`)).test(candidate[5])
        || !/^<(?:[0-9A-F]{2})+> Tj$/.test(candidate[6])
        || candidate[7] !== 'T*' || candidate[8] !== 'ET' || candidate[9] !== 'Q') {
        throw new Error('Colored PDF text block does not match the exact canonical grammar');
      }
      textBlockCount += 1;
      continue;
    }
    if (candidate.length !== 9 || candidate[7] !== 'S') {
      throw new Error('Colored PDF contains a non-canonical drawing path');
    }
    const color = candidate[1].match(rgbPattern);
    const thickness = candidate[2].match(scalarPattern);
    const dash = candidate[3].match(dashPattern);
    const firstMove = candidate[4].match(pointPattern('m'));
    const repeatedMove = candidate[5].match(pointPattern('m'));
    const end = candidate[6].match(pointPattern('l'));
    if (!color || !thickness || !dash || !firstMove || !repeatedMove || !end
      || firstMove[1] !== repeatedMove[1] || firstMove[2] !== repeatedMove[2]) {
      throw new Error('Colored PDF drawing path does not match the canonical single-segment form');
    }
    const rgbValue = color.slice(1).map(Number) as [number, number, number];
    const stroke: PdfStrokeRecord = {
      color: rgbValue,
      role: pdfRole(rgbValue),
      thickness: Number(thickness[1]),
      dashArray: dash[1] ? dash[1].split(' ').map(Number) : [],
      dashPhase: Number(dash[2]),
      start: [Number(firstMove[1]), Number(firstMove[2])],
      end: [Number(end[1]), Number(end[2])],
    };
    if (![stroke.thickness, stroke.dashPhase, ...stroke.color, ...stroke.dashArray, ...stroke.start, ...stroke.end].every(Number.isFinite)) {
      throw new Error('Colored PDF drawing path contains non-finite geometry');
    }
    strokes.push(stroke);
  }
  const page = pdf.getPage(0);
  return { strokes, textBlockCount, pageSize: [page.getWidth(), page.getHeight()] };
}

function onePdfToken(tokens: readonly string[], prefix: string, pattern: RegExp, label: string): RegExpMatchArray {
  const candidates = tokens.filter((token) => token.startsWith(prefix));
  const parsed = candidates.map((token) => token.match(pattern));
  if (candidates.length !== 1 || parsed.length !== 1 || parsed[0] === null) {
    throw new Error(`Colored PDF ${label} metadata is malformed or duplicated`);
  }
  return parsed[0];
}

export async function parseColoredOutlinePdf(
  bytes: Uint8Array,
  kind: 'preview' | 'exploded',
): Promise<ParsedColoredPdf> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const expectedTitle = kind === 'preview' ? 'ShapeCut colored preview' : 'ShapeCut exploded view';
  if (pdf.getTitle() !== expectedTitle || pdf.getPageCount() !== 1
    || pdf.getSubject() !== 'Canonical colored outline' || pdf.getAuthor() !== 'ShapeCut'
    || pdf.getCreator() !== 'ShapeCut' || pdf.getProducer() !== 'ShapeCut') {
    throw new Error(`Colored ${kind} PDF identity metadata is inconsistent`);
  }
  if (pdf.getCreationDate()?.toISOString() !== '2000-01-01T00:00:00.000Z'
    || pdf.getModificationDate()?.toISOString() !== '2000-01-01T00:00:00.000Z') {
    throw new Error(`Colored ${kind} PDF dates are not deterministic`);
  }
  const keywordsText = pdf.getKeywords() ?? '';
  const keywords = keywordsText === '' ? [] : keywordsText.split(/\s+/);
  if (keywords.some((token) => token === '')) throw new Error(`Colored ${kind} PDF keyword metadata is malformed`);
  const source = onePdfToken(keywords, 'outline-source:', /^outline-source:([0-9a-f]{32})$/i, 'source');
  const feature = onePdfToken(keywords, 'feature-evidence:', /^feature-evidence:([0-9a-f]{32})$/i, 'feature fingerprint');
  const diagnostics = onePdfToken(keywords, 'diagnostics-evidence:', /^diagnostics-evidence:([0-9a-f]{32})$/i, 'diagnostics fingerprint');
  onePdfToken(
    keywords,
    kind === 'preview' ? 'roles:' : 'legend:',
    kind === 'preview'
      ? /^roles:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3A78D4$/
      : /^legend:CUT_BLACK:#000000,DEEP_RED:#E5484D,LIGHT_BLUE:#3A78D4$/,
    'role legend',
  );
  const layerTokens = keywords.filter((token) => token.startsWith('layer:'));
  const layerRecords = layerTokens.map((token): PdfLayerRecord => {
    if (kind === 'preview') {
      const match = token.match(/^layer:(\d+):([A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/);
      if (!match) throw new Error('Colored preview PDF contains a malformed layer record');
      return { order: safeInteger(match[1], 'Colored preview PDF layer order'), id: match[2] };
    }
    const match = token.match(/^layer:(\d+):([A-Za-z0-9][A-Za-z0-9_.-]{0,79}):order=(\d+):thickness=([^:]+):X=([^:]+):Y=([^:]+):hole-diameter=([^:]+)$/);
    if (!match) throw new Error('Colored exploded PDF contains a malformed layer geometry record');
    const order = safeInteger(match[1], 'Colored exploded PDF layer order');
    if (safeInteger(match[3], 'Colored exploded PDF repeated layer order') !== order) {
      throw new Error('Colored exploded PDF repeated layer order is inconsistent');
    }
    const holeDiameter = match[7] === '—' ? null : safeFinite(match[7], 'Colored exploded PDF hole diameter');
    return {
      order, id: match[2],
      thickness: safeFinite(match[4], 'Colored exploded PDF thickness'),
      width: safeFinite(match[5], 'Colored exploded PDF width'),
      height: safeFinite(match[6], 'Colored exploded PDF height'),
      holeDiameter,
    };
  });
  if (layerRecords.length === 0 || new Set(layerRecords.map(({ id }) => id)).size !== layerRecords.length
    || layerRecords.some(({ order }, index) => order !== index + 1)) {
    throw new Error(`Colored ${kind} PDF layer record cardinality or order is invalid`);
  }
  const fixedTokens = kind === 'preview'
    ? ['scale:1:1', 'disclaimer:verify-fit-before-fabrication']
    : ['view:isometric-exploded', 'axis:central'];
  for (const token of fixedTokens) {
    if (keywords.filter((candidate) => candidate === token).length !== 1) {
      throw new Error(`Colored ${kind} PDF is missing canonical ${token} metadata`);
    }
  }
  const recognizedCount = 3 + 1 + fixedTokens.length + layerRecords.length;
  if (keywords.length !== recognizedCount) throw new Error(`Colored ${kind} PDF contains extra or malformed metadata markers`);
  assertPublicText(keywordsText, `Colored ${kind} PDF metadata`);
  const parsedGeometry = parsePdfGeometry(pdf);
  return {
    kind,
    fingerprints: fingerprintsFromValues({
      sourceHash: source[1], featureEvidenceFingerprint: feature[1], diagnosticsFingerprint: diagnostics[1],
    }, `Colored ${kind} PDF`),
    layerRecords,
    geometryRecords: parsedGeometry.strokes.flatMap(({ role, start, end }) => role ? [{ role, start, end }] : []),
    strokeRecords: parsedGeometry.strokes,
    pageSize: parsedGeometry.pageSize,
    textBlockCount: parsedGeometry.textBlockCount,
    keywords,
  };
}

function exactZipName(raw: Uint8Array): typeof EXPECTED_ZIP_NAMES[number] {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('Colored ZIP record name is not canonical UTF-8');
  }
  if (!(EXPECTED_ZIP_NAMES as readonly string[]).includes(decoded)) {
    throw new Error('Colored ZIP record has an unsafe or non-canonical name');
  }
  return decoded as typeof EXPECTED_ZIP_NAMES[number];
}

export async function parseColoredZipRecords(bytes: Uint8Array): Promise<readonly ParsedColoredZipRecord[]> {
  if (bytes.length < 22 || bytes.length > 64 * 1024 * 1024) throw new Error('Colored ZIP size is outside the canonical bound');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50 || view.getUint16(eocd + 20, true) !== 0) {
    throw new Error('Colored ZIP must end in one uncommented EOCD record');
  }
  const diskRecords = view.getUint16(eocd + 8, true);
  const recordCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0
    || diskRecords !== recordCount || recordCount !== 4 || centralOffset + centralSize !== eocd) {
    throw new Error('Colored ZIP must contain exactly four central-directory records');
  }
  const central: Array<{
    name: typeof EXPECTED_ZIP_NAMES[number];
    rawName: Uint8Array;
    localOffset: number;
    flags: number;
    method: number;
    modifiedTime: number;
    modifiedDate: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
  }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < recordCount; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Colored ZIP central record is malformed');
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || extraLength !== 0 || commentLength !== 0 || end > eocd) throw new Error('Colored ZIP central record bounds are invalid');
    const rawName = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = exactZipName(rawName);
    central.push({
      name,
      rawName,
      flags: view.getUint16(cursor + 8, true),
      method: view.getUint16(cursor + 10, true),
      modifiedTime: view.getUint16(cursor + 12, true),
      modifiedDate: view.getUint16(cursor + 14, true),
      crc32: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localOffset: view.getUint32(cursor + 42, true),
    });
    cursor = end;
  }
  if (cursor !== eocd || exact(central.map(({ name }) => name)) !== exact(EXPECTED_ZIP_NAMES)
    || new Set(central.map(({ name }) => name)).size !== central.length) {
    throw new Error('Colored ZIP record encounter order, uniqueness, or cardinality is invalid');
  }
  let localCursor = 0;
  for (const record of central) {
    const offset = record.localOffset;
    if (offset !== localCursor || offset + 30 > centralOffset || view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error('Colored ZIP local record coverage is not canonical or gap-free');
    }
    const localNameLength = view.getUint16(offset + 26, true);
    const localExtraLength = view.getUint16(offset + 28, true);
    const localDataStart = offset + 30 + localNameLength + localExtraLength;
    const localDataEnd = localDataStart + record.compressedSize;
    const localName = bytes.subarray(offset + 30, offset + 30 + localNameLength);
    if ((record.flags & 0x8) !== 0 || localExtraLength !== 0 || localDataEnd > centralOffset
      || view.getUint16(offset + 6, true) !== record.flags
      || view.getUint16(offset + 8, true) !== record.method
      || view.getUint16(offset + 10, true) !== record.modifiedTime
      || view.getUint16(offset + 12, true) !== record.modifiedDate
      || view.getUint32(offset + 14, true) !== record.crc32
      || view.getUint32(offset + 18, true) !== record.compressedSize
      || view.getUint32(offset + 22, true) !== record.uncompressedSize
      || localNameLength !== record.rawName.length
      || !localName.every((value, index) => value === record.rawName[index])) {
      throw new Error('Colored ZIP local and central records do not exactly match');
    }
    localCursor = localDataEnd;
  }
  if (localCursor !== centralOffset) throw new Error('Colored ZIP local record coverage contains an orphan or trailing gap');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.entries(zip.files);
  if (entries.length !== 4 || entries.some(([, entry]) => entry.dir)
    || exact(entries.map(([name]) => name)) !== exact(EXPECTED_ZIP_NAMES)) {
    throw new Error('Colored ZIP contains an unsafe, duplicate, extra, or missing file');
  }
  return Promise.all(entries.map(async ([name, entry]) => {
    const original = entry.unsafeOriginalName ?? name;
    if (original !== name || name !== exactZipName(new TextEncoder().encode(name))) {
      throw new Error('Colored ZIP original record name is unsafe or was sanitized');
    }
    assertPublicText(name, 'Colored ZIP record name');
    return { name: name as typeof EXPECTED_ZIP_NAMES[number], payload: await entry.async('uint8array') };
  }));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exteriorForLayer(entities: readonly ColoredEntityRecord[], layer: ColoredLayerRecord): ColoredEntityRecord {
  const exterior = entities.find((entity) => entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK');
  if (!exterior) throw new Error('Colored artifact layer has no black exterior');
  return exterior;
}

function polygonArea(points: readonly (readonly number[])[]): number {
  return Math.abs(signedArea(points));
}

function nearlyEqual(left: number | undefined, right: number): boolean {
  if (left === undefined || !Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 4096 * Number.EPSILON);
}

function entityBounds(entity: ColoredEntityRecord): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = entity.points.map((point) => point[0]), ys = entity.points.map((point) => point[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function expectedPdfStroke(
  role: ColoredRole | undefined,
  color: readonly [number, number, number],
  thickness: number,
  dashArray: readonly number[],
  start: readonly [number, number],
  end: readonly [number, number],
): PdfStrokeRecord {
  return { role, color, thickness, dashArray, dashPhase: 0, start, end };
}

function roleStroke(
  role: ColoredRole,
  start: readonly [number, number],
  end: readonly [number, number],
): PdfStrokeRecord {
  return expectedPdfStroke(role, PDF_ROLE_RGB[role], role === 'CUT_BLACK' ? 0.8 : 1.2, [], start, end);
}

function assertPdfStrokeRecords(actual: readonly PdfStrokeRecord[], expected: readonly PdfStrokeRecord[], kind: string): void {
  if (actual.length !== expected.length) throw new Error(`Colored ${kind} PDF drawing cardinality does not reconcile with SVG`);
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index], right = expected[index];
    if (left.role !== right.role || !nearlyEqual(left.thickness, right.thickness)
      || !nearlyEqual(left.dashPhase, right.dashPhase)
      || left.color.length !== right.color.length || left.dashArray.length !== right.dashArray.length
      || left.start.length !== right.start.length || left.end.length !== right.end.length
      || left.color.some((value, component) => !nearlyEqual(value, right.color[component]))
      || left.dashArray.some((value, component) => !nearlyEqual(value, right.dashArray[component]))
      || left.start.some((value, component) => !nearlyEqual(value, right.start[component]))
      || left.end.some((value, component) => !nearlyEqual(value, right.end[component]))) {
      throw new Error(`Colored ${kind} PDF drawing ${index + 1} does not exactly reconcile with SVG geometry`);
    }
  }
}

function reconcilePdf(
  pdf: ParsedColoredPdf,
  svg: ParsedColoredArtifact,
): void {
  const expectedLayers = svg.layers.map(({ id, order }) => ({ id, order }));
  if (exact(pdf.layerRecords.map(({ id, order }) => ({ id, order }))) !== exact(expectedLayers)) {
    throw new Error(`Colored ${pdf.kind} PDF layer metadata does not reconcile with SVG`);
  }
  if (pdf.kind === 'preview') {
    const exteriors = svg.layers.map((layer) => exteriorForLayer(svg.entities, layer));
    const maximumWidth = Math.max(...exteriors.map((entity) => {
      const bounds = entityBounds(entity);
      return bounds.maxX - bounds.minX;
    }));
    const totalHeight = exteriors.reduce((sum, entity) => {
      const bounds = entityBounds(entity);
      return sum + bounds.maxY - bounds.minY + 12;
    }, 16);
    const expectedPageSize: readonly [number, number] = [(maximumWidth + 34) * MM_TO_POINTS, totalHeight * MM_TO_POINTS];
    if (!nearlyEqual(pdf.pageSize[0], expectedPageSize[0]) || !nearlyEqual(pdf.pageSize[1], expectedPageSize[1])
      || pdf.textBlockCount !== svg.layers.length + 1) {
      throw new Error('Colored preview PDF page dimensions or label cardinality do not reconcile with SVG');
    }
    const expectedStrokes: PdfStrokeRecord[] = [];
    let cursorY = expectedPageSize[1] - 12 * MM_TO_POINTS;
    for (const [layerIndex, layer] of svg.layers.entries()) {
      const bounds = entityBounds(exteriors[layerIndex]);
      const height = bounds.maxY - bounds.minY;
      const originX = 12 * MM_TO_POINTS, originY = cursorY - height * MM_TO_POINTS;
      for (const entity of svg.entities.filter(({ physicalLayerId }) => physicalLayerId === layer.id)) {
        entity.points.forEach((point, index) => {
          const next = entity.points[(index + 1) % entity.points.length];
          expectedStrokes.push(roleStroke(
            entity.role,
            [originX + (point[0] - bounds.minX) * MM_TO_POINTS, originY + (point[1] - bounds.minY) * MM_TO_POINTS],
            [originX + (next[0] - bounds.minX) * MM_TO_POINTS, originY + (next[1] - bounds.minY) * MM_TO_POINTS],
          ));
        });
      }
      cursorY = originY - 12 * MM_TO_POINTS;
    }
    assertPdfStrokeRecords(pdf.strokeRecords, expectedStrokes, 'preview');
    return;
  }
  pdf.layerRecords.forEach((record, index) => {
    const layer = svg.layers[index];
    const exterior = exteriorForLayer(svg.entities, layer);
    const xs = exterior.points.map((point) => point[0]), ys = exterior.points.map((point) => point[1]);
    const black = svg.entities.filter((entity) => entity.physicalLayerId === layer.id && entity.role === 'CUT_BLACK');
    const expectedHole = black[1] ? Number((2 * Math.sqrt(polygonArea(black[1].points) / Math.PI)).toFixed(3)) : null;
    if (!nearlyEqual(record.thickness, layer.zEnd - layer.zStart)
      || !nearlyEqual(record.width, Math.max(...xs) - Math.min(...xs))
      || !nearlyEqual(record.height, Math.max(...ys) - Math.min(...ys))
      || record.holeDiameter !== expectedHole) {
      throw new Error('Colored exploded PDF layer dimensions or central-hole record does not reconcile with SVG');
    }
  });
  const expectedPageSize: readonly [number, number] = [297 * MM_TO_POINTS, 210 * MM_TO_POINTS];
  if (!nearlyEqual(pdf.pageSize[0], expectedPageSize[0]) || !nearlyEqual(pdf.pageSize[1], expectedPageSize[1])
    || pdf.textBlockCount !== svg.layers.length + 4) {
    throw new Error('Colored exploded PDF page dimensions or label cardinality do not reconcile with SVG');
  }
  const centerX = 120 * MM_TO_POINTS, baseY = 36 * MM_TO_POINTS;
  const gapMm = svg.layers.length <= 1 ? 0 : Math.min(20, 120 / (svg.layers.length - 1));
  const exteriors = svg.layers.map((layer) => exteriorForLayer(svg.entities, layer));
  const exteriorBounds = exteriors.map(entityBounds);
  const maximumWidth = Math.max(...exteriorBounds.map((bounds) => bounds.maxX - bounds.minX));
  const maximumHeight = Math.max(...exteriorBounds.map((bounds) => bounds.maxY - bounds.minY));
  const drawingScale = Math.min(1, 95 / maximumWidth, 58 / maximumHeight);
  const topY = baseY + (svg.layers.length - 1) * gapMm * MM_TO_POINTS + 40 * MM_TO_POINTS;
  const expectedStrokes: PdfStrokeRecord[] = [expectedPdfStroke(
    undefined,
    [0.35, 0.35, 0.35],
    0.6,
    [3, 3],
    [centerX, baseY - 8 * MM_TO_POINTS],
    [centerX, topY],
  )];
  svg.layers.forEach((layer, layerIndex) => {
    const bounds = exteriorBounds[layerIndex];
    const offsetX = centerX - ((bounds.maxX - bounds.minX) / 2) * drawingScale * MM_TO_POINTS
      + layerIndex * Math.min(4, 22 / Math.max(1, svg.layers.length - 1)) * MM_TO_POINTS;
    const offsetY = baseY + layerIndex * gapMm * MM_TO_POINTS;
    const project = (point: readonly number[]): readonly [number, number] => [
      offsetX + (point[0] - bounds.minX) * drawingScale * MM_TO_POINTS
        + (point[1] - bounds.minY) * 0.28 * drawingScale * MM_TO_POINTS,
      offsetY + (point[1] - bounds.minY) * 0.5 * drawingScale * MM_TO_POINTS,
    ];
    for (const entity of svg.entities.filter(({ physicalLayerId }) => physicalLayerId === layer.id)) {
      entity.points.forEach((point, index) => {
        expectedStrokes.push(roleStroke(entity.role, project(point), project(entity.points[(index + 1) % entity.points.length])));
      });
    }
  });
  COLORED_ROLES.forEach((role, index) => expectedStrokes.push(expectedPdfStroke(
    role,
    PDF_ROLE_RGB[role],
    1.2,
    [],
    [18 * MM_TO_POINTS, (192 - index * 7) * MM_TO_POINTS],
    [28 * MM_TO_POINTS, (192 - index * 7) * MM_TO_POINTS],
  )));
  assertPdfStrokeRecords(pdf.strokeRecords, expectedStrokes, 'exploded');
}

function assertPublicText(value: string, label: string): void {
  let decoded = value;
  try {
    for (let pass = 0; pass < 4 && decoded.includes('%'); pass += 1) decoded = decodeURIComponent(decoded);
  } catch {
    throw new Error(`${label} contains malformed percent encoding`);
  }
  const pathScanText = decoded.replace(/<\/[A-Za-z][A-Za-z0-9:._-]*\s*>/g, '');
  const checks = [
    ['percent encoding', /%[0-9a-f]{2}/i, decoded],
    ['email', /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/, decoded],
    ['file URI', /\bfile:\/\//i, decoded],
    ['private POSIX path', /(?:^|[^\p{L}\p{N}_/])\/(?![/>])/u, pathScanText],
    ['private Windows path', /(?:^|[^\p{L}\p{N}_\\/])(?:[A-Za-z]:[\\/]|\\{2,}(?!\\)[^\\\s"'<>]+\\+(?!\\)[^\\\s"'<>]+)/u, pathScanText],
    ['machine or source claim', /80\s*%|40\s*%|\bpower\b|\bspeed\b|\bpasses?\b|\bmaterial\b|\.stl\b|\.json\b|manifest/i, decoded.normalize('NFKC')],
  ] as const;
  const failed = checks.find(([, pattern, candidate]) => pattern.test(candidate));
  if (failed) {
    throw new Error(`${label} contains forbidden ${failed[0]} text`);
  }
}

export async function inspectColoredArtifacts(payloads: ColoredArtifactPayloads): Promise<DownloadedOutline> {
  const svg = parseColoredOutlineSvgArtifact(payloads.svg);
  const dxf = parseColoredOutlineDxfArtifact(payloads.dxf);
  const entityTuple = (entity: ColoredEntityRecord) => [
    entity.physicalLayerId, entity.order, entity.index, entity.zStart, entity.zEnd,
    entity.role, entity.id, entity.points,
  ];
  if (exact(svg.entities.map(entityTuple)) !== exact(dxf.entities.map(entityTuple))
    || exact(svg.entityCounts) !== exact(dxf.entityCounts)) {
    throw new Error('Colored SVG and DXF entities do not exactly reconcile');
  }
  const fingerprints: ColoredFingerprints = {
    sourceHash: svg.sourceHash,
    featureEvidenceFingerprint: svg.featureEvidenceFingerprint,
    diagnosticsFingerprint: svg.diagnosticsFingerprint,
  };
  if (exact(fingerprints) !== exact({
    sourceHash: dxf.sourceHash,
    featureEvidenceFingerprint: dxf.featureEvidenceFingerprint,
    diagnosticsFingerprint: dxf.diagnosticsFingerprint,
  })) throw new Error('Colored SVG and DXF fingerprints do not reconcile');
  const previewPdf = await parseColoredOutlinePdf(payloads.previewPdf, 'preview');
  const explodedPdf = await parseColoredOutlinePdf(payloads.explodedPdf, 'exploded');
  if (exact(previewPdf.fingerprints) !== exact(fingerprints) || exact(explodedPdf.fingerprints) !== exact(fingerprints)) {
    throw new Error('Colored PDF fingerprints do not reconcile with SVG and DXF');
  }
  reconcilePdf(previewPdf, svg);
  reconcilePdf(explodedPdf, svg);
  assertPublicText(payloads.svg, 'Colored SVG');
  assertPublicText(payloads.dxf, 'Colored DXF');
  const zipRecords = await parseColoredZipRecords(payloads.zip);
  const individual = new Map<typeof EXPECTED_ZIP_NAMES[number], Uint8Array>([
    ['cut-and-engrave.svg', new TextEncoder().encode(payloads.svg)],
    ['cut-and-engrave.dxf', new TextEncoder().encode(payloads.dxf)],
    ['preview.pdf', payloads.previewPdf],
    ['exploded-view.pdf', payloads.explodedPdf],
  ]);
  const reconciledZip = zipRecords.map((record) => ({
    ...record,
    byteIdentical: bytesEqual(record.payload, individual.get(record.name)!),
  }));
  if (reconciledZip.some(({ byteIdentical }) => !byteIdentical)) {
    throw new Error('Colored ZIP payloads are not byte-identical to the four individual downloads');
  }
  return {
    ...fingerprints,
    layers: svg.layers,
    entities: svg.entities,
    entityCounts: svg.entityCounts,
    previewPdf,
    explodedPdf,
    zipRecords: reconciledZip,
    sha256: createHash('sha256').update(payloads.zip).digest('hex'),
  };
}

export async function selectModel(page: Page, fixture: string | { name: string; mimeType: string; buffer: Buffer }, beforeSetInput?: () => Promise<void>) {
  await beforeSetInput?.();
  await page.getByLabel('選擇 STL 模型').setInputFiles(fixture);
}

export async function installWorkerResultProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type ProbeSummary = {
      mode: 'exact' | 'outline-2.5d';
      status: 'success' | 'warning';
      removedComponentCount: number;
      coloredLayers: Array<{
        id: string;
        widthMm: number;
        planarDiameterMm: number;
        cellSizeMm: number;
        exteriorPoints: Array<[number, number]>;
        hole: {
          status: 'retained' | 'omitted';
          equivalentDiameterMm?: number;
          axisDistanceMm?: number;
          areaMm2?: number;
          points?: Array<[number, number]>;
        };
        hasDeep: boolean;
        hasLight: boolean;
      }>;
    };
    type ProbeState = {
      results: ProbeSummary[];
      errorCodes: string[];
      created: number;
      terminated: number;
      packageRequests: number;
      packageCheckpoints: string[];
      replacementTriggered: number;
      replacementCheckpoint?: string;
      applyPaths: string[];
      replacement?: { name: string; mimeType: string; bytes: number[] };
    };
    const state: ProbeState = {
      results: [], errorCodes: [], created: 0, terminated: 0,
      packageRequests: 0, packageCheckpoints: [], replacementTriggered: 0, applyPaths: [],
    };
    Object.assign(window, { __shapeCutWorkerProbe: state });
    const inspect = (candidate: unknown, seen = new WeakSet<object>()): void => {
      if (typeof candidate !== 'object' || candidate === null || ArrayBuffer.isView(candidate)
        || candidate instanceof ArrayBuffer || candidate instanceof MessagePort || seen.has(candidate)) return;
      seen.add(candidate);
      const value = candidate as Record<string, unknown>;
      if (value.name === 'AutomaticOutlineError' && typeof value.code === 'string'
        && ['INVALID_STL', 'NO_OUTLINE', 'RESOURCE_LIMIT', 'TIME_LIMIT'].includes(value.code)
        && !state.errorCodes.includes(value.code)) state.errorCodes.push(value.code);
      if ((value.mode === 'exact' || value.mode === 'outline-2.5d')
        && (value.status === 'success' || value.status === 'warning')
        && Number.isSafeInteger(value.removedComponentCount)
        && Array.isArray(value.coloredLayers)) {
        const layers = value.coloredLayers.flatMap((item): ProbeSummary['coloredLayers'] => {
          if (typeof item !== 'object' || item === null) return [];
          const layer = item as Record<string, unknown>;
          const exterior = layer.exterior as {
            outer?: unknown;
            boundsMm?: { minX?: unknown; minY?: unknown; maxX?: unknown; maxY?: unknown };
          } | undefined;
          const centralHole = layer.centralHole as { outer?: unknown; areaMm2?: unknown } | undefined;
          const diagnostics = layer.diagnostics as {
            hole?: Record<string, unknown>;
            depth?: { cellSizeMm?: unknown };
          } | undefined;
          const hole = diagnostics?.hole;
          const validPoints = (points: unknown): points is Array<[number, number]> => Array.isArray(points)
            && points.length >= 3
            && points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
          if (typeof layer.id !== 'string' || !hole || (hole.status !== 'retained' && hole.status !== 'omitted')
            || typeof exterior?.boundsMm?.minX !== 'number' || typeof exterior.boundsMm.minY !== 'number'
            || typeof exterior.boundsMm.maxX !== 'number' || typeof exterior.boundsMm.maxY !== 'number'
            || !validPoints(exterior.outer) || typeof diagnostics?.depth?.cellSizeMm !== 'number'
            || hole.status === 'retained' && (!validPoints(centralHole?.outer) || typeof centralHole?.areaMm2 !== 'number')) return [];
          return [{
            id: layer.id,
            widthMm: exterior.boundsMm.maxX - exterior.boundsMm.minX,
            planarDiameterMm: Math.hypot(
              exterior.boundsMm.maxX - exterior.boundsMm.minX,
              exterior.boundsMm.maxY - exterior.boundsMm.minY,
            ),
            cellSizeMm: diagnostics.depth.cellSizeMm,
            exteriorPoints: exterior.outer,
            hole: {
              status: hole.status,
              ...(typeof hole.equivalentDiameterMm === 'number' ? { equivalentDiameterMm: hole.equivalentDiameterMm } : {}),
              ...(typeof hole.axisDistanceMm === 'number' ? { axisDistanceMm: hole.axisDistanceMm } : {}),
              ...(hole.status === 'retained' ? { areaMm2: centralHole!.areaMm2 as number, points: centralHole!.outer as Array<[number, number]> } : {}),
            },
            hasDeep: typeof layer.deepFeature === 'object' && layer.deepFeature !== null,
            hasLight: typeof layer.lightFeature === 'object' && layer.lightFeature !== null,
          }];
        });
        if (layers.length === value.coloredLayers.length) state.results.push({
          mode: value.mode,
          status: value.status,
          removedComponentCount: value.removedComponentCount as number,
          coloredLayers: layers,
        });
        return;
      }
      for (const nested of Object.values(value)) inspect(nested, seen);
    };
    const triggerReplacement = (checkpoint: string): void => {
      const replacement = state.replacement;
      if (!replacement) return;
      state.replacement = undefined;
      state.replacementTriggered += 1;
      state.replacementCheckpoint = checkpoint;
      queueMicrotask(() => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="選擇 STL 模型"]');
        if (!input) return;
        const files = new DataTransfer();
        files.items.add(new File([Uint8Array.from(replacement.bytes)], replacement.name, { type: replacement.mimeType }));
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    const NativeWorker = window.Worker;
    class ProbedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.created += 1;
        super.addEventListener('message', (event) => {
          const message = typeof event.data === 'object' && event.data !== null
            ? event.data as Record<string, unknown>
            : undefined;
          if (message?.type === 'SHAPECUT_PACKAGE_CHECKPOINT' && typeof message.label === 'string') {
            state.packageCheckpoints.push(message.label);
            if (message.label === 'pdf:create:before') triggerReplacement(message.label);
          }
          inspect(event.data);
        });
      }

      override terminate(): void {
        state.terminated += 1;
        super.terminate();
      }

      override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
        const record = typeof message === 'object' && message !== null ? message as Record<string, unknown> : undefined;
        const path = Array.isArray(record?.path) ? record.path.filter((part): part is string => typeof part === 'string').join('.') : '';
        if (record?.type === 'APPLY') {
          state.applyPaths.push(path);
          if (path.endsWith('packageOutline')) {
            state.packageRequests += 1;
          }
        }
        if (transferOrOptions === undefined) super.postMessage(message);
        else if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
        else super.postMessage(message, transferOrOptions);
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: ProbedWorker });
  });
}

export async function armWorkerPackageReplacement(
  page: Page,
  fixture: { readonly name: string; readonly mimeType: string; readonly buffer: Uint8Array },
): Promise<void> {
  await page.evaluate(({ name, mimeType, bytes }) => {
    const state = (window as unknown as {
      __shapeCutWorkerProbe: { replacement?: { name: string; mimeType: string; bytes: number[] } };
    }).__shapeCutWorkerProbe;
    state.replacement = { name, mimeType, bytes };
  }, { name: fixture.name, mimeType: fixture.mimeType, bytes: Array.from(fixture.buffer) });
}

export async function readWorkerProbeState(page: Page): Promise<WorkerProbeState> {
  return page.evaluate(() => {
    const state = (window as unknown as { __shapeCutWorkerProbe: WorkerProbeState }).__shapeCutWorkerProbe;
    return {
      results: state.results,
      errorCodes: state.errorCodes,
      created: state.created,
      terminated: state.terminated,
      packageRequests: state.packageRequests,
      packageCheckpoints: state.packageCheckpoints,
      replacementTriggered: state.replacementTriggered,
      replacementCheckpoint: state.replacementCheckpoint,
      applyPaths: state.applyPaths,
    };
  });
}

export async function readLatestWorkerResultSummary(page: Page): Promise<WorkerResultSummary> {
  await page.waitForFunction(() => (
    (window as unknown as { __shapeCutWorkerProbe?: { results: unknown[] } }).__shapeCutWorkerProbe?.results.length ?? 0
  ) > 0, undefined, { timeout: 60_000 });
  return page.evaluate(() => {
    const results = (window as unknown as { __shapeCutWorkerProbe: { results: WorkerResultSummary[] } }).__shapeCutWorkerProbe.results;
    return results.at(-1)!;
  });
}

export async function expectNoEngineeringControls(page: Page) {
  for (const name of [/修復/, /軸心/, /下一步/, /材料/, /拆件/, /輸出確認/]) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
}

export async function expectResult(page: Page, status: '成功' | '需注意', mode: '精確切片' | '2.5D 外形') {
  await expect(page.getByRole('heading', { name: '轉換完成' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(status, { exact: true })).toBeVisible();
  await expect(page.getByText(mode, { exact: true })).toBeVisible();
  await expectNoEngineeringControls(page);
}

async function captureDownload(page: Page, linkName: string, expectedFileName: string): Promise<Uint8Array> {
  const event = page.waitForEvent('download');
  await page.getByRole('link', { name: linkName, exact: true }).click();
  const download: Download = await event;
  expect(download.suggestedFilename()).toBe(expectedFileName);
  const path = await download.path();
  expect(path).not.toBeNull();
  return new Uint8Array(await readFile(path!));
}

export async function downloadAndInspectOutline(page: Page): Promise<DownloadedOutline> {
  const expectedLinks = [
    ['下載 ZIP 製作套件', 'shapecut-files.zip'],
    ['下載 SVG', 'cut-and-engrave.svg'],
    ['下載 DXF', 'cut-and-engrave.dxf'],
    ['下載 平面預覽 PDF', 'preview.pdf'],
    ['下載 爆炸圖 PDF', 'exploded-view.pdf'],
  ] as const;
  await expect(page.locator('a[download]')).toHaveCount(5);
  const downloads = new Map<string, Uint8Array>();
  for (const [label, fileName] of expectedLinks) {
    downloads.set(fileName, await captureDownload(page, label, fileName));
  }
  const decode = (name: string): string => new TextDecoder('utf-8', { fatal: true }).decode(downloads.get(name)!);
  return inspectColoredArtifacts({
    zip: downloads.get('shapecut-files.zip')!,
    svg: decode('cut-and-engrave.svg'),
    dxf: decode('cut-and-engrave.dxf'),
    previewPdf: downloads.get('preview.pdf')!,
    explodedPdf: downloads.get('exploded-view.pdf')!,
  });
}

export function expectFiniteClosedSingleContours(output: DownloadedOutline) {
  expect(output.entities).toHaveLength(Object.values(output.entityCounts).reduce((sum, count) => sum + count, 0));
  for (const entity of output.entities) {
    expect(entity.points.length).toBeGreaterThanOrEqual(3);
    expect(entity.points.every((point) => point.length === 2 && point.every(Number.isFinite))).toBe(true);
    expect(new Set(entity.points.map((point) => point.join(','))).size).toBe(entity.points.length);
  }
}

type Point2 = readonly [number, number];

function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const squared = dx * dx + dy * dy;
  if (squared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const factor = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / squared));
  return Math.hypot(point[0] - (start[0] + factor * dx), point[1] - (start[1] + factor * dy));
}

function cross2(start: Point2, end: Point2, point: Point2): number {
  return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0]);
}

function segmentsTouchOrIntersect(a: Point2, b: Point2, c: Point2, d: Point2, epsilon: number): boolean {
  const abC = cross2(a, b, c), abD = cross2(a, b, d), cdA = cross2(c, d, a), cdB = cross2(c, d, b);
  if (abC * abD < -epsilon * epsilon && cdA * cdB < -epsilon * epsilon) return true;
  return pointSegmentDistance(c, a, b) <= epsilon || pointSegmentDistance(d, a, b) <= epsilon
    || pointSegmentDistance(a, c, d) <= epsilon || pointSegmentDistance(b, c, d) <= epsilon;
}

function isSimplePolygon(points: readonly Point2[], epsilon: number): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsTouchOrIntersect(points[first], points[firstNext], points[second], points[secondNext], epsilon)) return false;
    }
  }
  return true;
}

function strictlyInsidePolygon(point: Point2, polygon: readonly Point2[], epsilon: number): boolean {
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index], end = polygon[(index + 1) % polygon.length];
    if (pointSegmentDistance(point, start, end) <= epsilon) return false;
    if ((start[1] > point[1]) !== (end[1] > point[1])) {
      const intersectionX = start[0] + ((point[1] - start[1]) * (end[0] - start[0])) / (end[1] - start[1]);
      if (intersectionX > point[0]) inside = !inside;
    }
  }
  return inside;
}

function polygonCentroid(points: readonly Point2[]): { readonly area: number; readonly centroid: Point2 } {
  let twiceArea = 0, weightedX = 0, weightedY = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length];
    const cross = point[0] * next[1] - next[0] * point[1];
    twiceArea += cross;
    weightedX += (point[0] + next[0]) * cross;
    weightedY += (point[1] + next[1]) * cross;
  }
  if (!Number.isFinite(twiceArea) || Math.abs(twiceArea) <= Number.EPSILON) throw new Error('Retained hole has zero or non-finite area');
  return { area: twiceArea / 2, centroid: [weightedX / (3 * twiceArea), weightedY / (3 * twiceArea)] };
}

function minimumBoundaryDistance(first: readonly Point2[], second: readonly Point2[], epsilon: number): number {
  let minimum = Infinity;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex += 1) {
    const a = first[firstIndex], b = first[(firstIndex + 1) % first.length];
    for (let secondIndex = 0; secondIndex < second.length; secondIndex += 1) {
      const c = second[secondIndex], d = second[(secondIndex + 1) % second.length];
      if (segmentsTouchOrIntersect(a, b, c, d, epsilon)) return 0;
      minimum = Math.min(
        minimum,
        pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
        pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
      );
    }
  }
  return minimum;
}

export type RetainedHoleEvidence = {
  readonly minimumDiameterMm: number;
  readonly polygonEquivalentDiameterMm: number;
  readonly minimumClearanceMm: number;
  readonly measuredClearanceMm: number;
  readonly recomputedAxisDistanceMm: number;
  readonly axisDistanceRatio: number;
};

export function expectRetainedHoleGeometry(
  layer: WorkerResultSummary['coloredLayers'][number],
): RetainedHoleEvidence {
  if (layer.hole.status !== 'retained' || !layer.hole.points || layer.hole.areaMm2 === undefined
    || layer.hole.equivalentDiameterMm === undefined || layer.hole.axisDistanceMm === undefined) {
    throw new Error(`Layer ${layer.id} does not expose complete retained-hole evidence`);
  }
  const exterior = layer.exteriorPoints, hole = layer.hole.points;
  const epsilon = Math.max(1e-9, layer.planarDiameterMm * 1e-10);
  expect(exterior.every((point) => point.length === 2 && point.every(Number.isFinite))).toBe(true);
  expect(hole.every((point) => point.length === 2 && point.every(Number.isFinite))).toBe(true);
  expect(new Set(exterior.map((point) => point.join(','))).size).toBe(exterior.length);
  expect(new Set(hole.map((point) => point.join(','))).size).toBe(hole.length);
  expect(isSimplePolygon(exterior, epsilon)).toBe(true);
  expect(isSimplePolygon(hole, epsilon)).toBe(true);
  expect(signedArea(exterior)).toBeLessThan(0);
  expect(signedArea(hole)).toBeGreaterThan(0);
  hole.forEach((point, index) => {
    expect(strictlyInsidePolygon(point, exterior, epsilon)).toBe(true);
    const next = hole[(index + 1) % hole.length];
    expect(strictlyInsidePolygon([(point[0] + next[0]) / 2, (point[1] + next[1]) / 2], exterior, epsilon)).toBe(true);
  });
  const minimumClearanceMm = Math.max(layer.cellSizeMm, layer.planarDiameterMm * 0.001);
  const measuredClearanceMm = minimumBoundaryDistance(exterior, hole, epsilon);
  expect(measuredClearanceMm + epsilon).toBeGreaterThanOrEqual(minimumClearanceMm);
  const mass = polygonCentroid(hole), polygonAreaMm2 = Math.abs(mass.area);
  expect(Math.abs(polygonAreaMm2 - layer.hole.areaMm2)).toBeLessThanOrEqual(Math.max(1e-8, polygonAreaMm2 * 1e-9));
  const polygonEquivalentDiameterMm = 2 * Math.sqrt(polygonAreaMm2 / Math.PI);
  const minimumDiameterMm = Math.max(0.5, layer.widthMm * 0.01);
  expect(polygonEquivalentDiameterMm + epsilon).toBeGreaterThanOrEqual(minimumDiameterMm);
  expect(layer.hole.equivalentDiameterMm + epsilon).toBeGreaterThanOrEqual(minimumDiameterMm);
  expect(Math.abs(polygonEquivalentDiameterMm - layer.hole.equivalentDiameterMm))
    .toBeLessThanOrEqual(Math.max(2 * layer.cellSizeMm, layer.planarDiameterMm * 0.002, 1e-8));
  const recomputedAxisDistanceMm = Math.hypot(mass.centroid[0], mass.centroid[1]);
  expect(Math.abs(recomputedAxisDistanceMm - layer.hole.axisDistanceMm)).toBeLessThanOrEqual(Math.max(1e-8, layer.planarDiameterMm * 1e-9));
  const axisDistanceRatio = recomputedAxisDistanceMm / layer.planarDiameterMm;
  expect(axisDistanceRatio).toBeGreaterThanOrEqual(0);
  expect(axisDistanceRatio).toBeLessThan(1);
  return {
    minimumDiameterMm,
    polygonEquivalentDiameterMm,
    minimumClearanceMm,
    measuredClearanceMm,
    recomputedAxisDistanceMm,
    axisDistanceRatio,
  };
}
