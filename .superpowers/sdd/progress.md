# Official Three-Prong Launcher SDD Progress

Branch base: `3dc11a0`
Design and plan: `5e03afa`
Baseline: `npm test -- --maxWorkers=1` — 61 files passed; 1,357 tests passed; 1 skipped; 0 failed.

Task 1: complete (commits 5e03afa..db89233, review clean)
Task 2: complete (commits db89233..5236a96, review clean after cancellation fix)
Task 3: complete (commits 5236a96..9eec23b, review clean after internal-evidence and cache fixes)
Task 4: complete (commits 9eec23b..570dc68, review clean; legacy Chromium fixtures deferred to Task 8)
Task 5: complete (commits 570dc68..7193b13, review clean after canonical E2E and artifact-attribution fixes)
Task 6: complete (commits 7193b13..f323394, review clean after raw-decimal fix)
Task 7: complete (commits f323394..e850791, review clean)
Task 8: complete as verification work (commit e850791..81946c7, review clean; release acceptance blocked by Knight dimensions, physical coupon, and Vitest RPC)

Minor review ledger:
- Task 2: validate invalid fit offsets earlier at the worker/request boundary (owned by Task 4).
- Task 2: final review should confirm ranking coverage and high-point-count rotation performance.

Final whole-branch review fixes:
- Added deterministic `project.json` and `manifest.json` to the colored release ZIP. The manifest records six member identities, byte lengths, SHA-256 hashes, and the canonical launcher/material/overlap decisions; verification rejects metadata and ZIP mutations.
- Wired sanitized OneClick project persistence into the production `App`. Reopen requires source SHA-256 reattachment and an explicit canonical regeneration before downloads return. Raw source bytes and filenames are not stored.
- Persisted both official launcher template version and fingerprint. Unavailable/mismatched template evidence is read as `regeneration-required`; reattachment alone does not clear the gate.
- Unified the public material-ID contract at the geometry-profile boundary so any accepted ID is safe for coupon/package generation and invalid IDs fail before conversion.
- Ranking fixtures and 4,096-point planner/axis budget coverage were confirmed in the existing focused suites.
- Changed-path verification: 100 tests passed; full colored package grammar: 433 passed; `npm run typecheck`, `npm run build`, and `git diff --check` passed. There is no `lint` npm script. The repository-wide serial Vitest command again stopped after the `RUN` banner without a summary (the previously recorded Vitest RPC blocker).

Second final-review round:
- Production `App` now has explicit saved-project `loading | loaded | failed` state. OneClick conversion is not mounted until loading settles; failure stays locked, exposes only a sanitized retry, and cannot overwrite or bypass the unresolved record.
- A completed saved job now exposes an explicit discard action. It deletes `one-click-current`, clears active saved state, and only then permits a different STL; ordinary reload still requires fingerprint reattachment and explicit regeneration.
- The shared 1-80 character public material-ID contract now participates in material readiness. Unsafe legacy stored IDs read without throwing, classify as actionable `block`, never enter OneClick ready profiles, and are rejected at the worker conversion boundary.
- Added an explicit deterministic score-order fixture proving structural clearance precedes decoration overlap, which precedes rotation.
- Removed the approved spec's trailing whitespace; `git diff --check 3dc11a0` now passes across the complete branch range.
- Focused verification: 7 files / 140 tests passed; `npm run typecheck` and `npm run build` passed. The real-browser worker command again reached only the Vitest `RUN` banner without a terminal summary, matching the recorded browser RPC blocker.

Third final-review round:
- The permanent load-failure screen now offers a separate destructive but scoped recovery: delete only `one-click-current`. Conversion remains unmounted until deletion succeeds; deletion errors remain locked, sanitized, and retryable.
- The local discard mask now re-arms whenever a newly saved record changes source SHA-256 or `updatedAt`. The regression fixture covers saved source A -> discard -> save source B -> confirm the source-B fingerprint gate is active before any source C can be selected.
- Removed the stale browser test that expected an unsafe material ID to convert and fail during coupon packaging. Early unsafe-ID rejection is now verified both before client transfer in the reliable node suite and inside the real Chromium worker.
- Focused verification: 8 files / 170 tests passed; targeted Chromium worker: 1 passed / 33 skipped; `npm run typecheck`, `npm run build`, and `git diff --check 3dc11a0` passed.

## Shared Launcher Exterior Expansion

Task 1: complete (commit 5c29b9b..23df4b9, review clean; three pipeline interface-transition failures are owned by Task 2)
Task 2: complete (commits 23df4b9..5b7c38b, review clean after central-hole source-evidence fix; monolithic assertions pass but known Vitest RPC exit persists)
Task 3: complete (commits 5b7c38b..10c5a29, review clean after project/artifact mutation and App propagation fixes)

Expansion minor review ledger:
- Task 3: decoded-PDF negative label test could first assert one known visible label so an empty decoder result cannot pass silently.

## Protected-Cut Decoration Omission

Task 1: complete (commits 980d5b8..c413f51, review clean after topology-only recovery and arrangement-bound fixes)
Task 2: complete (commits c413f51..26ca124, review clean after status, zero-diagnostic, source-evidence, and black-geometry fixes)
Task 3: complete (commit 26ca124..24179bf, review clean; artifacts, UI, and v3 persistence approved)

Task 4: complete (final independent review clean; physical gate outstanding).

Task 4 release evidence:
- Knight reference A: conversion 28,068.937 ms; shared exterior expansion 5.72 mm; launcher rotation 1.413716694115 rad; protected-work omissions `outline-layer-4,outline-layer-5`; black-geometry snapshot 150,324 bytes.
- Knight reference B: conversion 29,297.224 ms; shared exterior expansion 5.70 mm; launcher rotation 1.413716694115 rad; protected-work omissions `outline-layer-4,outline-layer-5`; black-geometry snapshot 148,074 bytes.
- Focused release matrix: 3 files / 20 tests passed. Real Chromium worker: 34/34 passed. Happy-path Chromium: 7/7 passed. Fixture/parser regression matrix: 4 files / 126 tests passed. Replacement/cancellation Chromium regression: 1/1 passed.
- Repository serial Vitest assertions: 65/65 files and 1,655/1,655 tests passed, but the command exited nonzero after the assertions because Vitest reported one unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` RPC error. This command is not recorded as passed.
- The final-review fix wave validates protected topology before budget classification, strictly reconciles every canonical project/manifest decision and privacy boundary, checks omission order by physical layer order (`layer-2` before `layer-10`), and lists all seven ZIP members.
- The follow-up privacy fix rejects bare STL filenames and forward-UNC paths in JSON metadata, with fresh-hash mutation regressions.
- Final-review core matrix: 3 files / 162 tests passed. The covering matrix reached 6/6 files and 774/774 assertions before the known post-assertion Vitest `onTaskUpdate` RPC timeout made the process nonzero.
- `npm run typecheck`, `npm run build`, working-tree `git diff --check`, and complete-range `git diff --check 3dc11a0` passed.
- A supplemental sequential browser rerun passed happy-path Chromium 7/7, then model A timed out with the material selector still disabled and model B was interrupted when that extra run was stopped; the scoped Knight and real-worker release evidence above remains unchanged.
- `physical coupon + official launcher latch/release/play/damage test: outstanding`.
