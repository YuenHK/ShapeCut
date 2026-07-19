import type { ManufacturingSheet } from './layers';
import { usedLayers } from './layers';

export function writeSheetDxf(sheet: ManufacturingSheet): string {
  const layerTable = usedLayers(sheet).map((layer) => `0\nLAYER\n2\n${layer}\n70\n0\n62\n7\n6\nCONTINUOUS\n`).join('');
  const entities = sheet.entities.map((entity) => {
    const vertices = entity.polygon.points.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join('');
    return `0\nLWPOLYLINE\n8\n${entity.layer}\n90\n${entity.polygon.points.length}\n70\n1\n${vertices}`;
  }).join('');
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${usedLayers(sheet).length}\n${layerTable}0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}
