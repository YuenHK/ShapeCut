# Reference routing diagnosis

## Verified cause

The previous release run established an absence of WASM publication, but did not establish why. On 2026-09-05 both original external references were parsed and passed through `analyzeMeshProblems` and `repairMeshSafe` again.

| Reference | Triangles | Safe repair accepted | Blocking reasons |
| --- | ---: | --- | ---: |
| A | 37,116 | false | 3 |
| B | 40,100 | false | 5 |

The automatic pipeline calls the exact segment source only inside its `safeRepair.accepted` branch. Both references instead use `extractProjectedContours(originalMesh, ...)`. Neither reaches the exact source's minimum-work or Float32 preflight. Their previous attribution to Float32 projection rounding was incorrect.

An open-cylinder regression explicitly checks `repairAccepted === false`, `mode === 'outline-2.5d'`, and zero calls to an injected exact source. The focused regression passed. This preserves existing behavior; no production geometry was changed.

## Implication for approved acceleration work

Changing the exact kernel to accept original Float32 coordinates plus a transform cannot accelerate these references under the existing route. It would improve a different class of repair-accepted meshes. Reference acceleration needs profiling of the projected 2.5D path, while preserving repair decisions, contour tolerances, launcher cuts and all six outputs.

The existing release measurements remain historical measurements. No new speedup, memory reduction, production rollout or physical launcher acceptance is claimed by this diagnosis.

## Exploratory CPU profile

One Node CPU-profiled conversion per reference completed in 15,881 ms and 15,535 ms, both with rejected repair, projected mode and six layers. These are exploratory single runs, not replacement five-run browser benchmarks. Profiles include some runner startup and exclude ZIP/PDF generation.

Feature/depth geometry accounted for approximately 63% of self samples in each run; launcher/protected-region work accounted for about 11%, repair/topology 9%, and projected raster 5%. The largest files were `hole.ts` (about 41%) and `engraving/geometry.ts` (about 18%). Candidate optimization targets are repeated containment, boundary clearance, scale calculation and polygon intersection. Preserve their current predicates and tolerances when testing optimizations.

## Reproduction commands

Read each externally supplied STL as an ArrayBuffer, call `parseSTL`, pass its mesh to `analyzeMeshProblems`, then call `repairMeshSafe(mesh, { beforeReport })`. Report only the case label, triangle count, accepted flag and blocking-reason count. Do not store external paths, filenames or source geometry in committed evidence.

Run the routing regression with:

```sh
npm test -- src/domain/pipeline/automatic-outline-pipeline.test.ts -t 'bypasses the exact segment source' --maxWorkers=1
```
