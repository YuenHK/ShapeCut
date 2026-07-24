# Final Whole-Branch Fix Report

Date: 2026-07-19

## Scope and baseline

- Requirements source: `.superpowers/sdd/final-review-findings.md`
- Approved specifications:
  - `docs/superpowers/specs/2026-07-17-top-spinner-laser-cut-tool-design.md`
  - `docs/superpowers/specs/2026-07-19-mesh-repair-and-visualization-design.md`
- Interface plan: `docs/superpowers/plans/2026-07-17-top-spinner-laser-cut-tool.md`
- Starting commit: `15f07db`
- Starting unit baseline: 22 files / 366 tests passed.
- Findings covered: C1-C3, I1-I6, and M1-M3.
- Production status at the start and end of this work: deliberately blocked until the exact physical material is identified, a physical coupon is measured, and a qualified operator signs the evidence. No synthetic or software-only result is accepted as production approval.

## Outcome

All twelve original software findings and both final re-review findings are closed, and the fresh software verification matrix is green. The Knight fixture remains fail-closed. Production manufacturing approval is still blocked only by the required external physical evidence; this is the intended safety outcome, not a software-test failure.

## Fix ledger

### C1 — Connect the real manufacturing pipeline

- RED evidence: the export path used fixed placeholder geometry and lacked end-to-end version provenance; output tests could pass without being derived from the imported mesh and confirmed settings.
- GREEN evidence: the version-owned path now runs mesh import and repair, confirmed axis, profile sampling, worker decomposition, material selection, engraving and balance, kerf and nesting, preflight, document generation, and package creation. A different-mesh regression proves that source geometry changes the resulting CUT geometry and used bounds.
- Key files: `src/domain/pipeline/manufacturing-pipeline.ts`, `src/export/package.ts`, `src/export/layers.ts`, `src/app/Wizard.tsx`.
- Commit: `53bc7af fix: connect production pipeline and material gates`
- Self-review: the package is rebuilt from captured stage results rather than UI placeholders, and every downstream stage retains the source/version relationship needed by I4.

### C2 — Make material readiness and preflight real

- RED evidence: a pending/default material or hard-coded passing preflight could reach a nominal export path without calibrated physical evidence.
- GREEN evidence: complete `MaterialProfile` validation and readiness checks now gate both pipeline execution and package creation. The generated preflight PDF comes from the actual report. Pending profiles remain blocked, and package construction revalidates signed physical evidence.
- Key files: `src/domain/materials/schema.ts`, `src/domain/materials/default-profiles.ts`, `src/domain/preflight/run-preflight.ts`, `src/export/package.ts`.
- Commit: `53bc7af fix: connect production pipeline and material gates`
- Self-review: the `TEST ONLY` synthetic profile exists solely inside the integration test and passes through the real schema/readiness/preflight path; it is not exposed as production approval.

### C3 — Reject winding and self-intersection defects

- RED evidence: reversed tetrahedron winding and interpenetrating tetrahedra were accepted by the previous repair/report path.
- GREEN evidence: oriented-edge consistency and bounded self-intersection analysis reject both counterexamples. Exhausting the analysis budget is fail-closed and is surfaced through the domain, worker, Wizard, and preview layers.
- Key files: `src/domain/mesh/self-intersection.ts`, `src/domain/mesh/problem-report.ts`, `src/domain/mesh/repair-mesh.ts`, `src/workers/geometry.worker.ts`.
- Commit: `6e535e9 fix: reject winding and self-intersection defects`
- Self-review: acceptance is no longer based only on open/non-manifold edge counts; uncertain intersection analysis cannot silently pass.

### I1 — Require explicit, valid axis confirmation

- RED evidence: empty or low-confidence results could fall back to the Z axis, and the manual axis was not a usable validation path.
- GREEN evidence: the fallback was removed. Accessible manual origin/direction fields require finite values and a non-zero direction, normalize the vector, and create an explicit confirmation. The next step uses the exact gate `confirmedAxis?.confirmed === true`.
- Key files: `src/app/steps/AxisStep.tsx`, `src/app/Wizard.tsx`, `src/app/App.tsx`.
- Commit: `09c768c fix: require explicit valid axis confirmation`
- Self-review: real-browser coverage proves low-confidence auto-confirm is unavailable, a zero vector is rejected, and a valid manual vector enables progress.

### I2 — Cancel superseded geometry work

- RED evidence: a deferred operation on a superseded worker could continue and later publish stale work.
- GREEN evidence: superseding, resetting, or unmounting terminates the worker; subsequent work uses a fresh worker instance. Unit and browser-worker tests cover cancellation and recreation.
- Key files: `src/workers/geometry-client.ts`, `src/app/Wizard.tsx`.
- Commit: `524ee7c fix: terminate superseded geometry workers`
- Self-review: cancellation now stops computation at its owner instead of merely ignoring a late result.

### I3 — Verify saved projects before reopening

- RED evidence: repository/store tests had 3 failures, Wizard tests had 5 failures, and legacy migration had 1 failure when saved state was required to prove its source identity and repair provenance.
- GREEN evidence: the saved-project chooser requires source reattachment and SHA-256 fingerprint verification, persists `{mode, algorithmVersion, meshSha256}` repair provenance, replays deterministically, and resumes conservatively. A real page-reload E2E covers the path.
- Key files: `src/persistence/project-repository.ts`, `src/app/project-store.ts`, `src/app/Wizard.tsx`, `e2e/happy-path.spec.ts`.
- Commit: `a39f234 fix: verify saved projects before reopening`
- Self-review: a filename match is insufficient; a fingerprint mismatch is visible and prevents unsafe continuation.

### I4 — Bind artifact jobs to exact settings versions

- RED evidence: 3 of 23 Wizard tests failed when controls could mutate or mixed-version stage results could be assembled during an active artifact job.
- GREEN evidence: relevant controls are disabled while work is active, non-cancel navigation is locked, and source, mesh, repair, axis, and settings versions are captured and rechecked. Mixed pipeline provenance is rejected. Wizard tests are 23/23 green for this group.
- Key files: `src/app/Wizard.tsx`, `src/app/steps/DecompositionStep.tsx`, `src/app/steps/EngravingStep.tsx`.
- Commit: `83b0734 fix: bind artifact jobs to settings versions`
- Self-review: stale results cannot be combined into a package even if each isolated stage result is otherwise valid.

### I5 — Test real geometry and real manufacturing outputs

- RED evidence:
  - performance timing arrays were empty rather than measuring worker work;
  - `hollow-shell.stl` was incorrectly treated as automatic at confidence 0.587;
  - the previous tiny happy path did not satisfy shaft safety and conflicted with the C2 production gate;
  - the initial real 100k-facet run took 3396 ms, above the 3000 ms requirement, because the same problem/self-intersection report was computed twice.
- GREEN evidence:
  - two real STL fixtures run through parse, safe repair, axis selection, worker decomposition, engraving, kerf/nesting, I6 validation, preflight, and package construction;
  - SVG, DXF, PDF, JSON, and ZIP payloads are checked semantically, including layers, IDs, instances, contours, coordinates/extents, assembly order, quantities, and payload equality;
  - the two fixtures produce different profile geometry, CUT geometry hashes, and used bounds;
  - the worker reuses the already-computed problem report rather than relaxing the performance threshold;
  - the hollow-shell confidence is now 0.809758, while dense elliptical and low-symmetry regressions remain below the automatic threshold.
- Key files: `src/export/real-fixtures.integration.test.ts`, `scripts/validate-fixtures.ts`, `src/domain/axis/radial-symmetry.ts`, `src/domain/mesh/repair-mesh.ts`, `e2e/performance.spec.ts`.
- Commit: `68132de test: verify real manufacturing outputs`
- Self-review: integration uses a complete synthetic signed profile marked `TEST ONLY` through the production schema and gates; it does not bypass or weaken production readiness.

### I6 — Validate manufacturing document instances

- RED evidence: 3 newly added validation groups failed while 5 existing export groups passed; ambiguous/duplicate instances and invalid CUT relationships were not rejected.
- GREEN evidence: `LayerEntity` has explicit instance and contour identity; IDs are unique; assembly order is unique and contiguous; each part has outline instances exactly `0..quantity-1`; polygons must be valid and in-sheet; a hole must be strictly inside the matching outline on the same sheet and instance; all other CUT overlap or touching is rejected. Export tests are 9/9 green.
- Key files: `src/export/layers.ts`, `src/export/export.test.ts`, `src/domain/pipeline/manufacturing-pipeline.ts`.
- Commit: `de252f0 fix: validate manufacturing document instances`
- Self-review: validation is performed on the generated manufacturing document, not inferred from upstream intent.

### M1 — Batch preview problem markers

- RED evidence: two markers created 2 geometries and the 2000-marker maximum created 2000 geometries; both regressions expected one batched geometry per category.
- GREEN evidence: each marker category now uses one geometry and one material while retaining `regionId -> Box3` focus lookup and complete disposal. The 2000-marker browser benchmark completes in under 100 ms; focused Chromium coverage is 12/12 green.
- Key files: `src/preview/scene-controller.ts`, `src/preview/SpinnerViewport.browser.test.tsx`.
- Commit: `b227e7a perf: batch preview problem markers`
- Self-review: focus behavior and cleanup remain covered after batching, so the performance fix does not trade away interaction or resource disposal.

### M2 — Remove UI-only axis bypasses

- RED evidence: static review found the Wizard's forward navigation was not expressed as the exact confirmed-axis gate and inherited the former fallback behavior.
- GREEN evidence: the Wizard next control is disabled unless `confirmedAxis?.confirmed === true`; I1 unit and real-browser tests exercise the actual user path.
- Key files: `src/app/Wizard.tsx`, `src/app/steps/AxisStep.tsx`.
- Commit: `09c768c fix: require explicit valid axis confirmation`
- Self-review: the UI and domain now use the same explicit confirmation state rather than parallel heuristics.

### M3 — Make PWA paths deployment-aware

- RED evidence: a real Vite build with base `/school/spinner/` still emitted manifest root paths (`start_url: "/"`) and lacked a deploy-relative scope.
- GREEN evidence: HTML, service-worker registration, manifest start/scope/icons, and service-worker shell URLs derive from the build/deployment base. The programmatic non-root Vite build integration test is green.
- Key files: `index.html`, `src/main.tsx`, `public/manifest.webmanifest`, `public/sw.js`, `src/pwa-paths.test.ts`.
- Commit: `673bb0e fix: make pwa paths deployment-aware`
- Self-review: the test inspects compiled output from a non-root build, not just source-string intent.

## Final re-review follow-up

### R1 — Wire calibrated stored materials into the real App flow

- RED evidence: `MaterialRepository` could persist profiles, but App/Wizard exposed only pending defaults; three Wizard tests and two Chromium tests failed because stored profiles, JSON import/editing, and the real App export path were absent.
- GREEN evidence: App now shares one material database across project and material repositories; Wizard lists readiness-labelled built-ins and stored profiles, validates JSON import/edit/save, keeps built-in IDs reserved, and reloads the exact selected record before pipeline execution. Pending profiles remain blocked.
- Real-browser oracle: raw `symmetric-smooth.stl` passes through the real worker and pipeline. Malformed JSON and missing manufacturer evidence are rejected; a stored profile without physical coupon/operator evidence cannot export; editing the same record to a complete signed `TEST ONLY` profile enables export. The downloaded ZIP is reopened with JSZip and revalidated for `canExport: true`, ready/approved evidence, coupon/operator identity, CUT entities, and the SVG CUT layer.
- Commits: `e20882e fix: expose validated material profile imports`; `46e13cb fix: wire calibrated materials into the app`.

### R2 — Apply split position to physical radial geometry

- RED evidence: ten focused tests failed: 30% still produced the former fixed 12 mm hub on a 30 mm radius profile; 9/91/NaN/Infinity were not rejected at the required boundaries; pipeline and persistence accepted unsafe values.
- GREEN evidence: `DecompositionOptions` now requires `splitPositionPercent`; `hubRadius = outerRadius * splitPositionPercent / 100`; pipeline passes the setting into the worker; domain, pipeline, and persisted-project boundaries enforce 10–90, while all existing shaft/joint/collision checks continue to reject unsafe legal-percentage geometry.
- Geometry oracle: the same 30 mm outer-radius profile produces a 9 mm hub at 30% and an 18 mm hub at 60%. Representative rib outline points and nested CUT polygon coordinates also differ, proving a physical geometry change rather than a fingerprint-only change.
- Commit: `3e6c6f8 fix: apply radial split to generated geometry`.

### Matrix-discovered acceptance caller updates

- Initial full E2E was 7/9 because the old non-exact `材料設定檔` locator also matched the new `材料設定檔 JSON` textarea. Two locators were made exact; the full rerun is 9/9.
- Initial fixture validation was 0/8 automatic because the standalone validator still called the now-strict decomposition API without `splitPositionPercent`. It now supplies an explicit 40% value, preserving its prior physical geometry; the rerun is 8/8 automatic, 10/10 total, with `outputComparisonPass: true`.
- Commit: `00c0227 test: update acceptance callers for final contracts`.

## Fresh final verification matrix

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript | PASS | `npm run typecheck`, exit 0 |
| Production build | PASS | `npm run build`, exit 0; Vite 7.3.6; 343 modules transformed |
| Unit/integration | PASS | `npm run test`; 25 files, 425/425 tests |
| Browser component/worker, Chromium | PASS | `npm run test:browser -- --run --browser=chromium`; 4 files, 33/33 tests |
| End-to-end, one worker | PASS | `npm run test:e2e -- --workers=1`; 9/9 tests |
| Fixture validator | PASS | `npm run validate:fixtures`; 10/10 fixture outcomes and `outputComparisonPass: true` |
| Non-root PWA build | PASS | real build at `/school/spinner/`; 1/1 integration test |
| Knight regression | PASS, fail-closed | unit regression and full E2E both confirm production remains blocked |
| Stored material App/ZIP flow | PASS | real Chromium worker/pipeline plus JSZip revalidation; pending blocked and signed `TEST ONLY` ready profile exported |
| Radial split geometry | PASS | 30%=9 mm and 60%=18 mm hub oracle; rib and nested CUT geometry differ; unsafe values rejected |

### Fixture-oracle results

| Fixture | Expected route | Observed result |
| --- | --- | --- |
| `symmetric-smooth.stl` | automatic | 1.000000 |
| `symmetric-textured.stl` | automatic | 0.983864 |
| `hollow-shell.stl` | automatic | 0.809758 |
| `wide-outer-ring.stl` | automatic | 1.000000 |
| `thin-profile.stl` | automatic | 0.919331 |
| `tall-spindle.stl` | automatic | 0.994014 |
| `squat-disc.stl` | automatic | 0.920410 |
| `stepped-profile.stl` | automatic | 0.955201 |
| `low-symmetry.stl` | manual | 0.523438; automatic confirmation blocked |
| `invalid-open.stl` | invalid | topology block |

### Performance evidence

- 100k-facet import/repair: 2895 ms; longest main-thread task 75 ms; requirement passed without loosening the 3000 ms threshold.
- 500k bounded-input case: 1377 ms; deterministic resource-limit result because unique vertices exceeded 300000.
- Real artifact worker pipeline: 89 ms first-pipeline elapsed time; decomposition 11.600000023841858 ms; engraving 3.299999952316284 ms.
- Preview marker volume: maximum 2000 markers batched by category in under 100 ms.

## Known non-fatal diagnostic

The Chromium browser matrix prints a Dexie `DatabaseClosedError` to stderr during an App smoke-test repository close/list race. The command exits 0 and all 33 browser tests pass. It is recorded here to avoid hiding diagnostic output; it is not an observed product failure and is outside the reviewed findings.

## Production and physical acceptance blocker

There are no unresolved software-matrix failures. Production package approval remains intentionally unavailable until all of the following external evidence exists for the actual job:

1. Exact material identity and measured stock properties are recorded.
2. A physical kerf/engraving coupon is cut and measured on the intended machine/material combination.
3. A qualified operator signs the resulting calibration and approval evidence.

Until those conditions are met, default/pending/forged readiness cannot unlock production output. The Knight fixture also remains blocked by design. No statement in this report constitutes permission to manufacture.

## Commits

1. `53bc7af fix: connect production pipeline and material gates`
2. `6e535e9 fix: reject winding and self-intersection defects`
3. `09c768c fix: require explicit valid axis confirmation`
4. `524ee7c fix: terminate superseded geometry workers`
5. `a39f234 fix: verify saved projects before reopening`
6. `83b0734 fix: bind artifact jobs to settings versions`
7. `de252f0 fix: validate manufacturing document instances`
8. `68132de test: verify real manufacturing outputs`
9. `b227e7a perf: batch preview problem markers`
10. `673bb0e fix: make pwa paths deployment-aware`
11. `4561cb4 docs: record final verification matrix`
12. `1b4c1c5 docs: define final material and split fixes`
13. `a0f3d78 docs: plan material and split re-review fixes`
14. `e20882e fix: expose validated material profile imports`
15. `46e13cb fix: wire calibrated materials into the app`
16. `3e6c6f8 fix: apply radial split to generated geometry`
17. `00c0227 test: update acceptance callers for final contracts`

## Final status

- Software findings C1-C3, I1-I6, M1-M3 and final re-review R1-R2: closed.
- Fresh test/build/fixture matrix: green, with zero failing checks.
- Production manufacturing approval: blocked pending the required physical material, coupon, and qualified-operator evidence.

---

# Geometry Estimate Materials Final Review Fixes

Date: 2026-07-24

## Scope and root cause

- The legacy pending catalog owns `plywood-3`, `acrylic-3`, and `cardboard-2`. `listMaterialCatalog` filtered every stored collision, `saveStoredMaterialJson` rejected every collision, and `resolveMaterialProfile` returned the pending built-in first. A readiness-approved same-ID profile therefore could not travel from the real repository through App to OneClickConverter.
- OneClickConverter used a last-wins map only for built-in estimate collisions, then appended all other ready stored profiles without deduplication.
- Zod clones `fitAllowanceMm`; freezing only the parsed profile left the nested clone mutable.

## RED evidence

Command:

```sh
npm test -- src/app/material-catalog.test.ts src/app/App.test.tsx src/app/OneClickConverter.test.tsx src/domain/materials/geometry-estimates.test.ts
```

Result: expected failure, exit 1. Four test files failed; 5 tests failed and 56 passed.

- Ready `plywood-3` was rejected as a reserved built-in ID.
- App displayed the geometry estimate instead of the repository-supplied ready same-ID profile.
- Two ready non-built-in profiles with the same ID rendered two options and a duplicate React key warning.
- `Object.isFrozen(profile.fitAllowanceMm)` returned false.
- The non-ready collision test initially received the old unconditional reserved-ID error instead of a readiness gate.

## GREEN evidence

Focused regression command:

```sh
npm test -- src/app/material-catalog.test.ts src/app/App.test.tsx src/app/OneClickConverter.test.tsx src/domain/materials/geometry-estimates.test.ts
```

Result: exit 0; 4 files and 61/61 tests passed.

Required catalog/App/Wizard/repository command:

```sh
npm test -- src/app/material-catalog.test.ts src/app/OneClickConverter.test.tsx src/app/App.test.tsx src/app/Wizard.test.tsx src/persistence/material-repository.test.ts src/domain/materials/geometry-estimates.test.ts
```

Result: exit 0; 6 files and 95/95 tests passed.

Full serial unit/integration command:

```sh
npm test -- --maxWorkers=1
```

Result: exit 0; 61/61 files passed, with 1357 tests passed and 1 conditional test skipped.

TypeScript command:

```sh
npm run typecheck
```

Result: exit 0; `tsc -b --pretty false` completed with no diagnostics.

## Implemented policy

- Only a stored profile whose ID is both a legacy built-in collision and an approved geometry-estimate ID may replace that pending built-in, and only when `classifyMaterialReadiness(...).status === 'ready'`.
- Pending, blocked, malformed, and non-estimate reserved collisions are rejected before repository persistence. A ready `cork-3` remains reserved and unavailable.
- Catalog listing and profile resolution prefer an approved stored same-ID replacement; otherwise they retain the pending built-in behavior.
- OneClickConverter keeps the five geometry-estimate slots in catalogue order. For repeated ready stored IDs, the first occurrence determines the extra-profile display position and the last ready occurrence supplies the exact selected profile. Thus every rendered ID is unique and the winner is deterministic.
- Every Zod-produced `fitAllowanceMm` map is frozen before its containing estimate profile; the estimate array, each profile, and each nested map are explicitly tested as frozen.
- The approved five estimates, visible `幾何估算` labels and thicknesses, readiness-only stored flow, and replacement-file chooser reset remain covered. No geometry, export, worker, or artifact source was changed.

## Commit

This report is included in the single final-fix commit. The exact commit hash is recorded in the task handoff because a commit cannot contain its own final hash.

## Concerns

The default parallel `npm test` run hit two existing load-sensitive timing assertions outside this patch: the genuine package reconciliation test exceeded its 5 s timeout, and the 10k-sample decomposition benchmark measured 1516.68 ms against 1500 ms. The exact tests passed immediately in isolation at 2836 ms and 375 ms, and the full serial run passed 61/61 files. No changed file touches either geometry or artifact path.

Independent final review returned no Critical, Important, or Minor findings. It confirmed the five-ID same-ID replacement policy against the approved design, the deterministic last-ready-wins merge, test adequacy, and the absence of geometry, export, worker, or artifact source changes.
