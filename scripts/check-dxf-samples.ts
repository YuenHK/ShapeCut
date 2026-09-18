import { readFile } from 'node:fs/promises';
import { convertAutomatically } from '../src/domain/pipeline/automatic-outline-pipeline';
import { GEOMETRY_ESTIMATE_MATERIALS } from '../src/domain/materials/geometry-estimates';
import { createOutlinePackage } from '../src/export/outline-package';
for (const name of ['sample1', 'sample2']) {
  const file = await readFile(new URL(`../public/samples/${name}.stl`, import.meta.url));
  const start = performance.now();
  const result = await convertAutomatically({ bytes: file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength), material: GEOMETRY_ESTIMATE_MATERIALS[0], launcherFitOffsetMm: 0 });
  const packaged = await createOutlinePackage(result);
  if (result.assembly.launcher.templateVersion !== 3 || result.layers.length !== 3) {
    throw new Error('Sample did not use the three-layer DXF reference');
  }
  console.log(JSON.stringify({ name, elapsedMs: performance.now()-start, status: result.status,
    warnings: result.warnings, featureWarnings: result.featureWarnings,
    templateVersion: result.assembly.launcher.templateVersion,
    layerCount: result.layers.length, packageKeys: Object.keys(packaged) }));
}
