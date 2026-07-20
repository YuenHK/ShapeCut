import type { ManufacturingDocument, ManufacturingProject } from './layers';

export function writeProjectJson(project: ManufacturingProject): string {
  return JSON.stringify({
    schemaVersion: project.schemaVersion,
    name: project.name,
    sourceSha256: project.sourceSha256,
    provenance: project.provenance,
    preflight: project.preflight,
    settings: project.settings,
    document: project.document,
  }, null, 2);
}

export function writeOutlineProjectJson(document: ManufacturingDocument): string {
  if (!document.outline) throw new RangeError('Outline project JSON requires outline document metadata');
  return JSON.stringify({
    schemaVersion: 1,
    sourceHash: document.outline.sourceHash,
    materialIndependent: true,
    document,
  }, null, 2);
}
