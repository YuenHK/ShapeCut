# Task 9 report: Final whole-branch review fixes

## Outcome

- Closed the final review findings for material readiness, physical cut priority, canonical launcher/engraving validation, real-model omission evidence, and filename validation.
- Fresh unit suite: 55 files and 1,299 tests passed, including the private-input release child process with no skip.
- Fresh Chromium suite: 5 files and 48 tests passed.
- Fresh E2E suite: 15 tests passed in 2.9 minutes, including both private references, 5 individual downloads, 4 exact ZIP entries, the 8,000 ms presentation gate, the 100k/500k boundaries, and package cancellation/replacement.
- Production build passed. `git diff --check` passed.

## Material readiness and file boundary

- `OneClickConverter` now exposes only profiles for which `classifyMaterialReadiness(profile).status === 'ready'`; pending built-ins and blocked profiles cannot start conversion.
- `App` loads stored profiles through `MaterialRepository` and `listMaterialCatalog`, retains only stored ready entries, sanitizes repository failure output, and ignores stale completion after repository replacement or unmount.
- Browser E2E seeds a complete ready profile into the real IndexedDB record format, reloads the production App/catalog path, and selects that exact ID. It no longer selects a pending built-in by option index.
- Input and drag/drop reject every filename not ending in `.stl`, case-insensitively, before file reading or material selection. Uppercase `.STL` remains accepted.

## Physical cut priority and final validation

- Added bounded material-aware physical cut protection. Exterior engraving clearance is `kerf / 2 + minWeb`; central, launcher, and fastener toolpaths are expanded to finished removal envelopes by `kerf / 2`, with `minWeb` required outside those envelopes.
- Both exact and projected production extraction receive those envelopes before retaining depth features.
- Final canonical result validation independently reconstructs physical envelopes and rejects engraving conflicts against exterior, central, launcher, or fastener cuts even when an attacker recomputes the feature fingerprint.
- Active launcher geometry is independently revalidated against both top-layer exteriors, both central holes, minimum web, and pairwise inter-hook clearance.
- Deadline polling remains bounded and exact caller cancellation objects propagate unchanged.

## Real-model release gate

- The fixture validator now runs both private references through `convertAutomatically` and `createOutlinePackage`, captures bounded extraction candidate evidence, and independently recomputes detected and built-in fallback launcher plans from runtime exterior, central-hole, material, and candidate geometry.
- Runtime omission fails if either recomputed plan is safe. Active detected/fallback results must match the independently recomputed cuts on exactly the top two layers and reconcile to six packaged SVG launcher cuts.
- Synthetic production-planner tests cover safe detected and safe fallback branches, false omission rejection, and genuinely unsafe omission.
- Sanitized private result: both `reference-a` and `reference-b` were `omitted`; detected plan `unavailable`; fallback plan `unsafe`; safe plan count `0`; packaged launcher cut count `0`. No private filename or path is emitted.

## TDD evidence

### RED

- Material/UI run: 6 focused failures showed pending/blocked profiles were selectable, App did not load the stored catalog, and non-STL files were read.
- Canonical geometry run: 8 focused failures showed recomputed exterior/central/launcher/fastener engraving conflicts and three active-launcher safety forgeries were accepted.
- Release run: the new validator module was unresolved and public command output lacked `launcherRuntimeValidation`.
- Browser run: `plywood-3` was absent after the readiness gate, proving the old pending-profile test path no longer worked.
- E2E performance run exposed two reload-state regressions: the ready-profile reload erased the long-task observer and package-replacement arming.

### GREEN

```text
Focused material/App: 37 passed
Focused geometry and canonical validation: 54 passed
Combined changed-path regression: 217 passed, 1 conditional private skip
Synthetic launcher runtime gate: 4 passed
Private fixture validator: reference-a and reference-b passed with zero safe plans
Targeted production IndexedDB E2E: 1 passed, 8.8 s
Targeted stale-fixture corrections: 37 passed
```

## Fresh completion verification

```bash
# Private variables were resolved ephemerally from git-common-dir.
KNIGHT_FORTRESS_STL="$fixture_a" KNIGHT_FORTRESS_GROUP_STL="$fixture_b" \
  npm test -- --maxWorkers=1 --minWorkers=1
# 55 files, 1299/1299 passed

npm run test:browser -- --run
# 5 files, 48/48 passed

KNIGHT_FORTRESS_STL="$fixture_a" KNIGHT_FORTRESS_GROUP_STL="$fixture_b" \
  npx playwright test --workers=1
# 15/15 passed in 2.9 minutes

npm run build
# typecheck and Vite production build passed; 156 modules transformed

git diff --check
# passed
```

`npx eslint .` was also attempted, but this repository has no `eslint.config.js`, `.mjs`, or `.cjs`; ESLint 9 exited before linting because no configuration exists. This is not a configured project gate.

## Privacy and self-review

- No supplied private STL is present in the worktree, tracked-file list, staged set, or patch.
- Patch scans found no real private filename, local account path, Google Drive path, or email. The only `/Users/private` and example email strings are deliberate synthetic sanitization inputs in `App.test.tsx`.
- The release summary uses only `reference-a` and `reference-b`; errors are converted to sanitized case IDs.
- No screenshot or generated Playwright report is staged. Five download names and four ZIP entries remain unchanged.
- No Critical, Important, or Minor issue remains open from this fix pass.
