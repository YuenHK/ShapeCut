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
