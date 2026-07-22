# Task 4 report: Three-hook detection and versioned Knight fallback

## Status and commit

- Completed and committed as `e0b96ca` (`feat: detect launcher clearance with safe fallback`).
- Base was `d354020`.
- The two supplied STL files remained outside this worktree and were never staged, modified, or committed.

## Implementation

- Added bounded `detectLauncherTemplate()` for projected three-loop candidate groups. It requires finite simple closed loops, at most 4,096 points per loop, successive inclusive 112--128 degree center gaps, a common radial band, finite support, and a shared deadline/checkpoint. It scores central alignment, threefold gap quality, radial consistency, and source support, then chooses the strongest candidate deterministically.
- Added rigid normalization that translates to the common center, rotates one deterministic first hook to +X, sorts hook order, canonicalizes winding/vertex rotation, and never scales.
- Added `planLauncherClearance()` with detected-first/versioned-fallback selection, existing inside-cut kerf compensation plus the fixed 0.20 mm radial assembly allowance, three `CUT_BLACK` contours, and all-or-none validation against both top and second layer exteriors, central holes, inter-hook clearance, and minimum web. One tuple is returned for identical use on both layers.
- Added strict two-reference fallback compatibility: exactly three loops, at most 5% corresponding center-radius difference, at most 10% corresponding area difference, and at most 0.50 mm symmetric mean point distance. Any incompatible reference fails before averaging.
- Added deterministic common-count arc-length resampling and pointwise averaging. The published V1 fallback has three 96-point normalized numeric loops and two SHA-256 provenance hashes only.
- Added `scripts/generate-launcher-template.ts`. It reads only the two opt-in environment paths, projects using the existing outline basis, searches 48 bounded axial slabs for reliable three-loop void evidence, simplifies each candidate once, generates the compatible numeric template, and prints no source path or metadata.
- Extended `scripts/validate-fixtures.ts` so supplying both environment variables regenerates the fallback in a bounded child process and requires byte-for-byte equality with the committed numeric initializer. Supplying only one input fails closed.

## TDD evidence

### Initial detector/template RED

Command:

```sh
npx vitest run src/domain/outline-assembly/launcher.test.ts src/domain/outline-assembly/launcher-template.test.ts
```

Observed expected failure: both suites failed import resolution because `launcher.ts` and `launcher-template.ts` did not exist.

The first implementation run then exposed four meaningful geometry mismatches in the new tests. Root-cause analysis corrected percent-denominator semantics and floating tolerances, preserved already-common point samples, and changed the rotated-rectangle allowance assertion from an axis-aligned bounding width to invariant area. This was not treated as completion until the focused suite passed.

### Generator RED

Adding the numeric-only renderer test failed because `scripts/generate-launcher-template.ts` did not exist. After the initial script was created, the first real fixture command exited 0 with empty stdout because vite-node entry-module detection did not execute `main`. A regression proved the path heuristic issue; the design was simplified so the CLI file is an unconditional executable entry while the pure renderer remains in the tested template module.

### Runtime-bound RED

The first real mesh search was stopped manually with exit 130 after it exceeded its intended deadline and had produced no output. Investigation showed O(n^2) polygon validation was not receiving the detector checkpoint and raster loops were being revalidated across combinations.

New tests then failed as expected:

- detector inner-loop checkpoint: expected `mid-loop checkpoint`, but the invalid candidate returned omitted;
- template inner-loop checkpoint: expected `template inner-loop checkpoint`, but validation returned the generic invalid-loop error.

GREEN propagates the same deadline/checkpoint through detector and template polygon validation, symmetric point distance, planner offset/containment/clearance loops, caches detector loop validity, and simplifies each real-fixture void once to at most 96 points. Real generation then completed in seconds rather than running past the budget.

### Common-point-count RED

The published-template regression initially received loop counts `{96, 87, 86}` instead of one common count. Averaging now chooses one bounded maximum across all six reference loops, producing three 96-point loops.

## Fresh focused and build verification

Final focused command:

```sh
npx vitest run src/domain/outline-assembly/launcher.test.ts src/domain/outline-assembly/launcher-template.test.ts
```

Result: 2 files passed, 21 tests passed.

```sh
npm run typecheck
npm run build
```

Result: both exited 0; Vite transformed 141 modules and completed the production build.

`git diff --check` and the staged diff check both exited 0 before commit.

## Deterministic generator and real-fixture evidence

Both final runs used the brief's source-root pattern:

```sh
source_fixture_root=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
KNIGHT_FORTRESS_STL="$source_fixture_root/Copy of Beyblade X Knight Fortress.stl" \
KNIGHT_FORTRESS_GROUP_STL="$source_fixture_root/Copy of Beyblade X Knight Fortress Group.stl" \
npx vite-node scripts/generate-launcher-template.ts
```

The two complete stdout files compared byte-for-byte equal. Both SHA-256 values were:

```text
a62907554809ab8554c57cc2716908c6f00ac83c0812b915aa503519c202f5e2
```

The stdout privacy scan returned `PRIVACY_SCAN_ZERO_MATCHES` for absolute Unix/Windows paths, `.stl`, `Copy of`, and email-like metadata.

Opt-in fixture validation returned:

```text
autoSuccess: 8
outputComparisonPass: true
launcherTemplatePass: true
```

## Full suite (run once)

Command:

```sh
npm test
```

Result: 46 test files / 1,181 tests; 1,180 passed and 1 failed. Every Task 4 test passed, as did the automatic outline pipeline and Knight repair regression.

The sole failure was outside Task 4: `OneClickConverter > requires material selection before conversion and resets the chooser for a replacement file`. The test synchronously queried `選擇製作材料` while the DOM still showed the replacement file's `正在讀取模型` state. This replacement-read race is documented in earlier task reports and no UI or unrelated test was changed to mask it. Per the brief, the full suite was not rerun.

## Self-review and concerns

- Confirmed no production string or generated stdout contains either private fixture path or filename; only the approved normalized numeric fallback and two SHA-256 hashes are committed.
- Confirmed all detector/template compatibility quadratic loops receive bounded checkpoints; planner containment and pairwise clearance also share the caller deadline.
- Confirmed fallback generation fails rather than averaging topology, radius, area, or point-distance incompatibility.
- Confirmed planning does not scale geometry and omits the complete three-cut group if either layer rejects any cut.
- An independent read-only review was requested under the review skill, but its scan of the large generated numeric block did not return before the parent-requested conclusion; it was interrupted rather than delaying the task. The local requirements audit and fresh verification above found no Task 4 blocker.
- Only known concern is the unrelated full-suite UI race described above.

---

## Review remediation (2026-07-22)

This follow-up addresses every critical, important, and minor review finding. The follow-up commit subject is `fix: harden launcher fallback safety`.

### Safety geometry and reliability

- Planning now constructs the required finished opening as the normalized hook plus `0.20 mm`, validates that envelope, then derives the emitted inside-cut path by offsetting it by `-kerf / 2`. Exterior, central-hole, and inter-hook minimum-web checks use the finished envelope on both layers; the returned cuts remain the exact kerf-compensated paths.
- The polygon offset adapter accepts the caller checkpoint and propagates it through input validation, vertex construction, and output validation. Planner deadline exhaustion and arbitrary cancellation both propagate instead of being converted into an omission.
- Detector evidence now has explicit nonzero loop/group reliability floors and a final score floor. A bounded size term breaks otherwise equal evidence in favor of the larger credible geometry; unreliable detection still selects the fallback.
- Regressions cover exact nonzero-kerf output bounds/area, finished-envelope exterior rejection, central-hole clearance rejection, inter-hook clearance rejection, zero/tiny evidence, equal-score size selection, fallback selection, deadline expiry, and cancellation.

### Canonicalization, sampling, and provenance

- Normalization evaluates all three cyclic hook starts and chooses the lexicographically smallest canonical group. Tests cover asymmetric hooks rotated past 120 degrees and across the `atan2` branch.
- Both references are uniformly arc-length resampled to one common bounded count before distance comparison and averaging. Cyclic point phase is aligned deterministically, the best cyclic group correspondence is selected without scaling, and every averaged loop is revalidated after numeric rounding.
- Tests cover different tessellations and phases, forward/reverse deterministic averaging, and an averaged loop that becomes invalid after canonical numeric rounding.
- Averaging and rendering now require exactly two lowercase 64-character hexadecimal provenance hashes at runtime. Uppercase, short, and extra hashes fail closed.

### One caller-owned generator budget

- The importable generator core is separated into `scripts/launcher-template-generator.ts`; the CLI remains a thin executable.
- Environment generation establishes one 120-second deadline before file loading. The same deadline/checkpoint is used before and after axis discovery and projection, through raster/simplification candidate work, detector geometry kernels, template compatibility, and averaging. No per-reference or per-stage deadline is reset.
- RED first failed because the importable generator module did not exist. GREEN proves an already-expired deadline is checked exactly once before mesh analysis and arbitrary cancellation propagates before analysis begins.

### Review RED/GREEN evidence

- Launcher RED: 7 expected failures exposed zero/tiny evidence acceptance, missing size tie-breaking, missing fallback selection, safety checks against kerf-shrunken paths, and swallowed cancellation. GREEN: 19/19 launcher tests passed.
- Template RED exposed noncanonical cyclic starts, tessellation-sensitive comparison, invalid averaged-loop acceptance, and permissive provenance hashes. GREEN: 13/13 template tests passed.
- Generator RED failed module resolution for the new importable core. GREEN: 2/2 generator deadline/cancellation tests passed.
- Final focused command passed 3 files / 34 tests.

### Determinism, fixtures, privacy, and final verification

- Two complete real-STL generator runs compared byte-for-byte equal. Both generated-output SHA-256 values were `32a4ae7dca2619fbd0f2be2c1527f5e3a2d3bd0692d4056e91addcd79d80f810`.
- The regenerated numeric V1 template remains three 96-point loops with exactly two SHA-256 provenance hashes. The stdout scan found zero absolute Unix/Windows paths, `.stl`, supplied filenames, or email-like strings.
- Opt-in fixture validation passed with `autoSuccess: 8`, `outputComparisonPass: true`, and `launcherTemplatePass: true`.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0; Vite transformed 141 modules.
- Fresh full suite, run once after all remediation: 47 files / 1,196 tests passed. The formerly observed unrelated `OneClickConverter` race did not recur.
- `git diff --check`: exit 0 after removing the generated trailing blank line.

No review-remediation blocker remains. The two private STL inputs remain outside the worktree and are neither staged nor committed.
