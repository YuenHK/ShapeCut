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
