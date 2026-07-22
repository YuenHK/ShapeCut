# Task 5 report — safe 3/2/1/0 screw-hole planner

## Status and scope

- Task 5 is complete on top of `9ec5e97`.
- Added the standalone all-layer fastener planner and protected-region geometry only. Automatic pipeline/export integration remains Task 6.
- The intended commit subject is `feat: plan safe degrading screw fixation`.

## Implementation

- `planFastenerHoles()` consumes every ordered layer exterior, optional central hole, ordered launcher cuts, the canonical axis point, and one fully validated `ManufacturingGeometryProfile`.
- It searches counts before radii: 3 holes at 120 degrees, then 2 holes at 180 degrees, then one maximum-clearance grid location, then a zero-hole omission with one sanitized warning.
- Three- and two-hole searches use 128 bounded radial candidates and 48 bounded rotations per radius. Radius is searched from the common exterior bound inward. At the first safe radius, every rotation is evaluated and the greatest-minimum-clearance rotation wins; equal scores retain the lower deterministic rotation.
- The one-hole fallback uses a bounded 32-by-32 interval grid over the common exterior bounds and selects the point with the greatest minimum planar material thickness to every exterior/protected boundary. Stable x/y iteration resolves exact ties.
- Every retained center is tested against every layer. Protected regions are each layer's central hole plus up to three launcher cuts. Pairwise finished-hole spacing also enforces `minWebMm`.
- Safety uses the 3.00 mm finished physical radius, `minWebMm`, and an additional `kerfMm / 2` loss at every black cut/exterior boundary. It therefore does not mistake the smaller compensated path for the physical safety envelope.
- The emitted inside-cut path diameter is exactly `3.00 - kerfMm`; it must remain positive. The 3.00 mm finished feature must meet `minFeatureMm`. Excessive minimum web degrades to zero rather than emitting unsafe geometry.
- Retained contours are deterministic 48-point `CUT_BLACK` loops. The shared plan contains one ordered center/contour set for identical reuse on all layers.
- Protected-region input is bounded to 24 layers, four protected loops per layer, and 4,096 finite points per loop. Candidate loops and clearance scans share the caller deadline/checkpoint and propagate the exact caller cancellation.

## TDD evidence

### Initial RED

Before any production module existed, this command was run:

```sh
npx vitest run src/domain/outline-assembly/fasteners.test.ts src/domain/outline-assembly/protected-region.test.ts
```

Both suites failed import resolution exactly because `./fasteners` and `./protected-region` did not exist. The tests already covered 3/2/1/0 degradation, symmetry/equal radii, maximum bounded safe radius, safest deterministic rotation, thickest one-hole location, all-layer safety, 48-point output, kerf/minimum-feature behavior, omission warning, deadline/cancellation, and input/candidate bounds.

### Protected-region GREEN

After the minimum protected-region implementation:

```text
1 file passed; 5/5 tests passed
```

This covered signed common material thickness, protected-area rejection, physical circle-plus-web safety, 48-point loops, bounded inputs, deadline expiry, and exact cancellation propagation.

### Planner GREEN refinement

The first complete planner run passed 11/12 tests. The one failure showed that the test incorrectly assumed an axis-aligned two-hole rotation. At the maximum retained radius, the planner selected 3.75 degrees because it has a strictly greater minimum clearance than zero degrees. The assertion was corrected to the required safest bounded auto-rotation; production logic was unchanged.

The next focused run passed 2 files / 12 tests.

### Finished-feature RED/GREEN

Self-review added a regression requiring `minFeatureMm = 2.9` to accept a 3.00 mm finished hole even though its 0.20 mm-kerf toolpath is 2.80 mm. RED failed with `The compensated 3 mm fastener path is below the material minimum feature`, proving the planner was comparing the wrong geometry. GREEN compares `minFeatureMm` with the 3.00 mm finished feature while independently requiring a positive compensated path.

Final focused result:

```text
Test Files  2 passed (2)
Tests       12 passed (12)
```

## Fresh verification

```sh
npm run typecheck
npm run build
```

Both exited 0. Vite transformed 141 modules and completed the production build.

The full suite was run exactly once after the final production/test changes:

```sh
npm test
```

Result: 52 test files / 1,230 tests passed, zero failures.

`git diff --check` passed before staging. The staged diff was also checked before commit.

## Self-review and concerns

- Confirmed count priority is 3, then 2, then 1, then 0; a larger lower-count bolt circle can never displace a safe higher count.
- Confirmed the selected 3/2 radius is the maximum within the documented bounded radial candidate set, and rotation is the safest deterministic bounded candidate at that radius.
- Confirmed one-hole ranking uses the common minimum clearance across all layers, not only the top layer or material profile thickness.
- Confirmed central and launcher black cuts affect the physical-envelope check and cannot be bypassed by nonzero kerf.
- Confirmed malformed material geometry, nonpositive compensated paths, oversized layer/region/point inputs, expired deadlines, and caller cancellation all fail closed.
- Confirmed warnings contain no source path, filename, or model metadata.
- No blocking concern remains. The finite search is intentionally discrete and bounded by the approved brief; Task 6 must apply the returned single ordered hole set to every layer without recomputing it.

---

## Review remediation — search completeness, public IDs, and representable paths

### Root causes

- The original 128 radii were scaled by the most remote exterior vertex. For the review polygon `(-4,-4),(4,-4),(4,-1),(1000,-1),(1000,1),(4,1),(4,4),(-4,4)`, the smallest sample was about 7.81 mm even though a safe three-hole pattern exists near `3.5 / sqrt(3) = 2.02072594 mm`.
- The original single-hole grid divided the entire AABB into 32 intervals. The same remote tail produced x samples `-4, 27.375, ...`, so it never sampled the local chamber.
- Shared holes were `FeatureContour` values with fixed `fastener-hole-1..3` IDs. Reusing them on every layer preserved geometry but violated the existing global public-ID contract.
- A kerf one representable floating value below 3 mm left a formally positive path diameter whose 48 points collapsed at a nonzero large center. The original code returned that zero-area contour without validation.

### Search-completeness RED/GREEN

RED ran the exact review polygon plus equivalent long/narrow two-hole, long-aspect one-hole, and bounded true-zero cases. Results were exactly 0 instead of 3, 0 instead of 2, 0 instead of 1, while the true-zero remained 0.

GREEN defines a 0.25 mm manufacturing search resolution and replaces global-scale-only sampling with:

- the complete feasible low-radius interval beginning at each pattern's pairwise-web minimum;
- bounded coarse remote coverage plus quantized boundary-point and axis-to-segment critical radii;
- 48 deterministic rotations at every evaluated radius;
- Lipschitz-bounded interval subdivision, which proves no higher fixed-rotation candidate exists above the selected radius at the manufacturing resolution;
- boundary-coordinate candidate points plus longest-axis branch-and-bound cells for the one-hole maximum.

The radial search is capped at 2,048 seeds and 4,096 evaluations; single-hole search is capped at 8,192 cells. If those bounds prevent the resolution criterion from being established, planning throws instead of returning a false zero. The exact 3/2/1 long-tail regressions and true-zero all pass, while count priority remains 3 > 2 > 1 > 0.

### ID contract RED/GREEN

RED proved every shared hole still owned an `id`. GREEN changes `FastenerPlan.holes` to ID-free `FastenerHoleGeometry` and adds `materializeFastenerHoles()`.

Materialization reserves every supplied layer ID and exterior/central/launcher/existing-fastener/deep/light feature ID, rejects pre-existing duplicates, and allocates deterministic collision-free per-layer IDs. It reuses the exact shared path points without recomputation. A six-layer regression deliberately reserves the natural first fastener ID, materializes all layers, verifies all public IDs are unique, and passes `validateAutomaticColoredResult()` after recomputing its feature fingerprint.

### Near-3 mm kerf RED/GREEN

RED used `kerfMm = 3 - 2^-51` and axis `(1000000,-1000000)`. The old planner returned collapsed path loops. GREEN validates every retained 48-point contour before return: all points finite and pairwise distinct, polygon simple, bounds nonzero, and signed area finite and positive. A nonrepresentable positive path now throws a fail-closed `RangeError`; the normal 0.20 mm kerf target remains unchanged.

### Final verification

Focused command:

```sh
npx vitest run src/domain/outline-assembly/fasteners.test.ts src/domain/outline-assembly/protected-region.test.ts src/domain/outline-features/types.test.ts
```

Result: 3 files / 57 tests passed.

`npm run typecheck` exited 0. `npm run build` exited 0 and Vite transformed 141 modules.

The full suite was run once after all production/test changes: 52 files / 1,236 tests; 1,235 passed and one unrelated UI test failed. The failure was the previously documented `OneClickConverter > requires material selection before conversion and resets the chooser for a replacement file` race: the test synchronously queried `選擇製作材料` while the replacement UI still showed `正在讀取模型`. Every Task 5, protected-region, and global types/materialization test passed. Per the one-full-suite requirement, it was not rerun and no unrelated UI code/test was changed.

### Self-review and remaining concern

- Search completeness is explicit at 0.25 mm for the fixed 48 rotations rather than implied by remote AABB spacing. Resource caps fail closed instead of silently degrading.
- Physical 3.00 mm envelopes, material minimum web, kerf loss, shared deadline/cancellation, deterministic ordering, and count priority remain intact.
- Shared model-space geometry is now cleanly separated from public per-layer identity, ready for Task 6 integration.
- No Task 5 blocker remains. The only observed concern is the unrelated pre-existing `OneClickConverter` asynchronous replacement race described above.

---

## Review remediation — fail-closed resolution and runtime ID-free validation

### RED evidence

Four regressions failed before production changes:

- a 0.25 mm radial interval whose low/middle/high margins were all `-0.01` still had a positive Lipschitz upper bound, but the planner discarded that unresolved interval;
- the single-hole policy pruned `best = 2.0`, `cell upper = 2.2`, `required = 2.1` even though the cell could still contain a safe center;
- materialization accepted shared geometry forged with its own public `id`;
- an intentionally reduced unresolved radial-evaluation cap was ignored and planning continued instead of throwing.

The focused RED result was 13 passed / 4 failed.

### GREEN implementation

- Pattern subdivision now evaluates low, midpoint, and high margins and derives a conservative Lipschitz upper bound over both half-intervals. An unsafe interval is discarded only when that bound is below the safety margin. Manufacturing-resolution-sized intervals are subdivided further when unresolved; evaluation or representability caps throw instead of allowing count degradation.
- Single-hole branch-and-bound uses `best + 0.25 mm` optimization only after the best sampled clearance is safe. While the best is unsafe, a cell is pruned only when its upper bound is below the required clearance. Unresolved sub-resolution cells continue splitting until certified, a safe point is found, or the bounded cell/representability cap throws.
- The optional bounded search limits are validated as positive safe integers no larger than the production defaults, enabling deterministic cap regression coverage without weakening default bounds.
- Materialization now performs a strict runtime validation of the shared plan: exact permitted plan/geometry/bounds keys, count-array consistency, finite center/radius/rotation/path data, canonical zero/nonzero warning shape, ID-free 48-point `CUT_BLACK` geometry, finite distinct simple points, exact circle/path correspondence, and recomputed bounds/area consistency.
- Any own `id`, unknown string key, symbol key, malformed point/count, or inconsistent geometry is rejected before layer IDs are allocated. Materialized contours are constructed as `{ ...geometry, id }`, so the generated collision-free ID is authoritative.
- The valid materialization regression still recomputes the global feature fingerprint and passes `validateAutomaticColoredResult()`.

### Verification

Focused command:

```sh
npx vitest run src/domain/outline-assembly/fasteners.test.ts src/domain/outline-assembly/protected-region.test.ts src/domain/outline-features/types.test.ts
```

Result: 3 files / 61 tests passed.

`npm run typecheck` exited 0. `npm run build` exited 0; Vite transformed 141 modules.

The full suite was run once after the final production/test changes and passed completely: 52 files / 1,240 tests, zero failures. `git diff --check` also passed.

### Self-review

- A safe higher-count candidate is never lost to an unresolved unsafe seed interval; unresolved proof now fails closed.
- The one-hole resolution optimization cannot suppress discovery of the first safe point.
- Shared geometry cannot smuggle or override a public layer ID, and generated plans continue to satisfy global ID/fingerprint validation.
- No Task 5 blocker remains.
