# Task 6 implementation report

## Scope and ownership

- Production rollout remains unchanged and disabled by default.
- No typography, sizing, colour, or other UI styling changed.
- Binary STL presentation now scans the caller-owned bytes once for bounds and samples at most 2,000 triangles directly. It no longer constructs a full `Float64Array`/`Uint32Array` presentation mesh before discarding almost all of it.
- Pipeline preview limits are exported as an immutable 2,000-triangle / 6,000-vertex contract.
- Existing slice-pool transferable ownership, worker termination, late-progress gating, sequential artifact creation, URL rollback, and replacement revocation remain the canonical cleanup boundaries and were reverified rather than duplicated.

## TDD evidence

### RED

`npm test -- --run src/performance/geometry-memory.test.ts`

- 1 file, 3 tests failed.
- All failures were caused by the absent live-byte estimator/preview-limit contract (`estimateGeometryLiveBytes is not a function`).

Playwright RED before the direct binary preview path:

- 200,000 triangles did not produce the material presentation canvas within the unchanged 30-second boundary.
- The page remained before conversion; this isolated the duplicate full-mesh presentation allocation/parse route rather than the WASM slicing stage.

### GREEN

- Geometry memory contract: 1 file, 2 tests passed after final cleanup.
- Preview + memory focused Node: 2 files, 4 tests passed.
- Focused Node regression: 5 files, 91 tests passed.
- App/client/artifact ownership regression: 6 files, 127 tests passed after final cleanup (App, OneClickConverter, geometry API, timeline, preview and memory).
- Focused Chromium segment/geometry worker regression: 2 files, 51 tests passed.
- Synthetic Playwright responsiveness/cancellation: 3 tests passed in 15.4 seconds.
- TypeScript project typecheck passed.
- Production build passed; 177 modules transformed and the tracked 38.16 kB WASM asset was verified.
- `git diff --check` passed.
- Scoped privacy scan found no local path, account identifier, private fixture name, or credential material.

## Measurements

Fixed Chromium run, one trial per synthetic size, observer installed before file selection. Each case entered conversion, ran for two seconds, then used the real Cancel control and verified deterministic return to file selection.

| Triangles | Presentation reached | Cancelled total | Longest main-thread task | Geometry workers |
| ---: | ---: | ---: | ---: | ---: |
| 200,000 | 75 ms | 2,314 ms | 0 ms | created 2, terminated 2 |
| 500,000 | 144 ms | 2,283 ms | 0 ms | created 2, terminated 2 |
| 1,000,000 | 243 ms | 2,376 ms | 55 ms | created 2, terminated 2 |

All observed main-thread tasks were below 100 ms. Worker termination was complete before the cancellation assertion returned.

The attributable presentation geometry changes from approximately 84 bytes per input triangle (full `Float64` positions plus `Uint32` indices) to a fixed maximum of 96,000 bytes. Including the required binary input buffer, estimated live bytes fall from about 134.0 MB to 50.096 MB at one million triangles, a 62.6% reduction. Presentation-owned geometry alone falls by more than 99%.

## Full performance-suite status and risks

The complete serial `e2e/performance.spec.ts` run is **not claimed green**. Its first pre-existing safe-conversion scenario remained at the reading stage and did not expose `.outline-process-webgl canvas` within its unchanged 30-second assertion; Playwright therefore skipped the remaining serial cases. A standalone rerun reproduced that same failure. The Task 6 synthetic 200k/500k/1M gate was then run independently and passed 3/3 with the measurements above.

Task 7 still owns warmed five-run Knight A/B timing, whole-pipeline peak-live-byte acceptance, and the final release gate. The current change does not enable WASM production rollout and does not use a timeout increase as a performance fix.
