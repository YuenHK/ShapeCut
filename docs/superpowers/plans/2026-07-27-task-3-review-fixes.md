# Task 3 Review Fixes Implementation Plan

**Goal:** Make fixed-launcher overlap counters exactly reproducible from bounded internal evidence while keeping that evidence out of every public/artifact boundary, and update the release/runtime validation contract accordingly.

**Architecture:** Preserve at most 12 provisional red and 12 provisional blue contours from the top layer in an internal-only `AutomaticOutlineResult` evidence field. Strict validation recomputes all four overlap counters from that evidence, retained decoration, and finished launcher envelopes. The worker caches the internal result by source/fingerprint, returns a selected-key public result, and reattaches cached evidence only inside `packageOutline`.

**Tech Stack:** TypeScript, Vite, Vitest, Comlink workers, Playwright, JSZip/PDF artifact validators.

---

### Task 1: Lock internal evidence and counter recomputation

**Files:**
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/domain/outline-features/types.ts`
- Test: `src/domain/pipeline/automatic-outline-pipeline.test.ts`

1. Add failing tests that mutate each of clipped-red, clipped-blue, removed-red, and removed-blue while recomputing the public fingerprint; strict validation must still reject.
2. Add a bounded internal provisional-evidence type and retain selected top-layer provisional contours.
3. Reuse one exact bounded classification function during extraction and validation.
4. Validate evidence shape, roles, geometry, count limits, deadlines, and exact recomputation.
5. Run focused pipeline validation tests.

### Task 2: Prove non-disclosure across worker and artifacts

**Files:**
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry.worker.ts`
- Test: `src/workers/geometry-api.test.ts`
- Test: `src/export/outline-package.test.ts`

1. Add failing tests for a public worker result without internal evidence and a public package request that cannot contain it.
2. Add failing sentinel tests covering colored document, SVG, DXF, both PDFs, ZIP, manifest, and project JSON.
3. Introduce the selected-key public result type and bounded worker-local cache/reconciliation.
4. Run focused worker and artifact/privacy tests.

### Task 3: Replace legacy runtime validation

**Files:**
- Modify: `scripts/launcher-runtime-validation.ts`
- Modify: `scripts/validate-fixtures.ts`
- Test: `src/test/launcher-runtime-validation.test.ts`
- Test: `src/test/validate-fixtures-release.test.ts`

1. Replace detected/fallback/omitted expectations with the fixed official template contract.
2. Independently validate fixed metadata, fit quantization/range, rotation range, top-two placement, physical safety, and six artifact cuts.
3. Remove candidate-probe/fallback planning inputs from the new validation path.
4. Run focused runtime and public fixture-flag tests.

### Task 4: Close the serialized browser callback boundary

**Files:**
- Modify: `e2e/helpers.ts`
- Test: `src/test/e2e-helpers.test.ts`

1. Add a failing closure test which serializes and executes the `addInitScript` callback without module scope.
2. Pass official template/fit constants as explicit serialized arguments.
3. Validate rotation, fit range, fit step, and finished allowance inside the browser callback.
4. Run focused helper tests and the relevant Playwright probe.

### Task 5: Documentation, cleanup, verification, and commit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-official-three-prong-launcher-cut-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-official-three-prong-launcher-cut.md`
- Modify: `.superpowers/sdd/task-3-report.md`

1. Document the narrowly scoped internal-evidence exception and all prohibited destinations.
2. Remove stale imports/comments found by typecheck.
3. Append RED/GREEN and exact verification evidence to the Task 3 report.
4. Run focused Vitest suites, typecheck/build, Playwright helper/probe, and the public fixture flag.
5. Commit as a new fix commit without amending `6cf9e7e`.
