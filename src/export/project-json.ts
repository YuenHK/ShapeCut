import type { ManufacturingProject } from './layers';

export function writeProjectJson(project: ManufacturingProject): string {
  return JSON.stringify({ schemaVersion: project.schemaVersion, name: project.name, sourceSha256: project.sourceSha256, settings: project.settings, document: project.document }, null, 2);
}
