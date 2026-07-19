import type { ManufacturingDocument, ManufacturingSheet } from './layers';
import { usedLayers } from './layers';

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function writeSheetSvg(sheet: ManufacturingSheet): string {
  const groups = usedLayers(sheet).map((layer) => {
    const paths = sheet.entities.filter((entity) => entity.layer === layer).map((entity) => {
      const points = entity.polygon.points.map(([x, y]) => `${x},${y}`).join(' ');
      return `<polygon id="${escape(entity.id)}" data-part-id="${escape(entity.partId)}" points="${points}"/>`;
    }).join('');
    return `<g id="layer-${layer}" data-process="${layer}">${paths}</g>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm" viewBox="0 0 ${sheet.width} ${sheet.height}">${groups}</svg>`;
}

export function writePartsMapSvg(document: ManufacturingDocument): string {
  const rows = document.manifest.map((item, index) => `<text x="10" y="${20 + index * 8}" font-size="5">${escape(item.partId)} x ${item.quantity} / order ${item.assemblyOrder}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">${rows}</svg>`;
}
