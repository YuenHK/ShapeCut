# Protected-Cut Decoration Omission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish exact concave launcher-exterior expansion and allow only a layer-specific protected-cut work-budget condition to omit red/blue decoration while retaining every canonical black cut.

**Architecture:** Keep the launcher-only exact planar offset adapter and exact-safe candidate prefilter as prerequisites. Convert the protected-cut work-budget condition into one typed error, catch only that error at the per-layer depth-feature boundary, and carry an ordered omission decision through strict canonical validation, artifacts, UI, and versioned persistence. Every other geometry, resource, deadline, or cancellation failure remains fatal.

**Tech Stack:** TypeScript, React, Vite, Vitest, Playwright, Comlink, Dexie/IndexedDB, SVG/DXF/PDF/ZIP canonical artifact writers.

## Global Constraints

- Only `ProtectedCutWorkBudgetError` may downgrade to decoration omission.
- The stable error and omission code is `PROTECTED_CUT_WORK_BUDGET`.
- The warning is exactly `三爪孔保護運算量超出上限，已省略此層紅藍裝飾`.
- Omission is per layer; unaffected layers retain valid red and blue decoration.
- An affected layer has zero `DEEP_RED` and zero `LIGHT_BLUE` contours.
- Exterior, central hole, launcher cuts, fastener holes, material, launcher template, rotation, fit offset, and shared expansion remain unchanged.
- Deadline, cancellation, invalid topology, coordinates, all other resource limits, launcher incompatibility, and expansion above `6.00 mm` remain fatal.
- `AutomaticOutlineAssembly.decorationOmissions` is ordered by physical layer and participates in the feature fingerprint.
- Project, manifest, preview, SVG, DXF, both PDFs, and ZIP reconcile the same canonical decision and geometry.
- SVG, DXF, and PDFs receive no human-readable omission warning.
- Raw STL bytes, filenames, preview payloads, provisional decoration evidence, and central-hole source evidence remain excluded from persistence and artifact metadata.
- Both Knight references must finish within the existing 30-second automatic-conversion deadline.
- The exact concave offset uses no convex hull, raster approximation, launcher resize, dependency, deadline increase, or general-kernel behavior change.
- Physical official-launcher acceptance remains outstanding.

---

## File Structure

- Keep `src/domain/outline-assembly/launcher-exterior-offset-adapter.ts` focused on deterministic planar-face resolution for collapsed concave miter loops.
- Modify `src/domain/layout/polygon-kernel.ts` only to expose bounded raw miter construction; existing kernel outputs and validation remain unchanged.
- Modify `src/domain/outline-assembly/launcher-exterior-expansion.ts` to use the adapter only after the existing simple miter reports a collapsed/self-intersected outward offset.
- Modify `src/domain/outline-assembly/launcher.ts` to exact-prefilter unsafe candidates before structural scoring.
- Modify `src/domain/outline-features/depth-field.ts` for the typed budget error and exact per-layer omission.
- Modify `src/domain/outline-features/types.ts` for ordered canonical omission evidence and strict reconciliation.
- Modify `src/domain/pipeline/automatic-outline-pipeline.ts` to derive omission evidence and warning status.
- Modify `src/export/outline-package.ts` for project/manifest/artifact reconciliation.
- Modify `src/persistence/one-click-project-repository.ts` for schema v3 and fail-closed v2 migration.
- Modify `src/app/OneClickConverter.tsx` to report affected layer IDs and retained black geometry.
- Extend focused domain, pipeline, artifact, persistence, UI, real-fixture, browser-worker, and E2E tests.
- Remove `src/export/task-4-launcher-diagnostic.test.ts` after permanent regressions contain all required evidence.

---

### Task 1: Finalize Exact Concave Exterior Expansion

**Files:**
- Create: `src/domain/outline-assembly/launcher-exterior-offset-adapter.ts`
- Modify: `src/domain/layout/polygon-kernel.ts`
- Modify: `src/domain/outline-assembly/launcher-exterior-expansion.ts`
- Modify: `src/domain/outline-assembly/launcher-exterior-expansion.test.ts`
- Modify: `src/domain/outline-assembly/launcher.ts`
- Modify: `src/domain/outline-assembly/launcher.test.ts`
- Do not commit: `src/export/task-4-launcher-diagnostic.test.ts`

**Interfaces:**
- Consumes: approved Task 1 expansion constants, existing simple miter kernel, exact polygon validation, fixed launcher candidate ranking.
- Produces:

```ts
export function constructRawMiterOffset(
  polygon: Polygon2,
  mm: number,
  checkpoint?: () => void,
): readonly Point2[];

export function resolveLauncherExteriorMiterOffset(
  source: Polygon2,
  rawOffset: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): Polygon2;
```

- [ ] **Step 1: Preserve and verify the recorded RED cases**

The current worktree contains pre-commit RED/GREEN evidence from systematic debugging. Confirm the permanent tests contain:

```ts
expect(() => simpleMiterPolygonKernel.offset(
  { points: collapsedNotchExterior().outer },
  2.10,
)).toThrow('Offset collapsed or self-intersected the polygon');

const resolved = expandLauncherExterior(collapsedMultiNotchExterior(), 5.74);
expect(validatePolygon({ points: resolved.outer })).toBe(true);
expect(resolved.areaMm2).toBeCloseTo(1470.0823732768595, 9);
expect(expandLauncherExterior(collapsedMultiNotchExterior(), 5.74)).toEqual(resolved);
```

Keep the simple-kernel failure as a contract proving the new behavior is launcher-only.

- [ ] **Step 2: Run focused tests before cleanup**

Run:

```bash
npx vitest run \
  src/domain/outline-assembly/launcher-exterior-expansion.test.ts \
  src/domain/outline-assembly/launcher.test.ts \
  --maxWorkers=1 --fileParallelism=false
```

Expected: all permanent adapter/planner assertions pass. If they do not, stop and return to systematic debugging; do not add a fourth geometry algorithm.

- [ ] **Step 3: Complete the bounded half-edge contract**

The adapter must:

1. split all proper crossings and collinear overlaps;
2. preserve signed raw traversal multiplicity;
3. create twin half-edges and sort outgoing edges by deterministic polar half-plane, cross product, coordinate, and source index;
4. trace every planar face;
5. identify the unique unbounded face;
6. propagate integer winding across face adjacency without midpoint sampling;
7. retain only positive-to-nonpositive interfaces, oriented with filled material on the left;
8. trace interfaces into cycles;
9. discard non-containing collapsed loops;
10. require exactly one clockwise, simple, source-containing outer cycle;
11. simplify only forward-collinear vertices; and
12. poll deadline/cancellation while enforcing `4,096` raw, arrangement, and output point bounds.

`simpleMiterPolygonKernel.offset()` must retain its old behavior. `expandLauncherExterior()` invokes the adapter only for the exact collapsed/self-intersected outward-offset error.

- [ ] **Step 4: Preserve exact-safe prefilter ordering**

For each unchanged sequential `0.01 mm` expansion grid:

```ts
const exactlyContained = boundsEligible.filter((candidate) =>
  finishedCutsFitExpandedExteriors(
    candidate.finishedCuts,
    expandedExteriors,
    clearances.toolpathBoundaryMm,
    deadline,
    checkpoint,
  ));

const ranked = exactlyContained
  .map(scoreCandidateAgainstExpandedExteriors)
  .sort(compareLauncherPlacementScores);

const selected = ranked.find(runIndependentFullPhysicalSafety);
```

Do not skip grids, change the comparator, reuse final removal envelopes, or extend the product deadline.

- [ ] **Step 5: Run Task 1 regression tests**

Run:

```bash
npx vitest run \
  src/domain/layout/polygon-kernel.test.ts \
  src/domain/outline-assembly/launcher-exterior-expansion.test.ts \
  src/domain/outline-assembly/launcher.test.ts \
  --maxWorkers=1 --fileParallelism=false
npm run typecheck
git diff --check
```

Expected: PASS. Record exact timing of the multi-notch and planner cases.

- [ ] **Step 6: Remove diagnostic-only test and commit**

Delete `src/export/task-4-launcher-diagnostic.test.ts`. Stage only Task 1 product/permanent-test files:

```bash
git add \
  src/domain/layout/polygon-kernel.ts \
  src/domain/outline-assembly/launcher-exterior-offset-adapter.ts \
  src/domain/outline-assembly/launcher-exterior-expansion.ts \
  src/domain/outline-assembly/launcher-exterior-expansion.test.ts \
  src/domain/outline-assembly/launcher.ts \
  src/domain/outline-assembly/launcher.test.ts
git commit -m "fix: expand concave launcher exteriors exactly"
```

---

### Task 2: Typed Per-Layer Decoration Omission and Canonical Evidence

**Files:**
- Modify: `src/domain/outline-features/depth-field.ts`
- Modify: `src/domain/outline-features/depth-field.test.ts`
- Modify: `src/domain/outline-2.5d/extract.test.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.test.ts`
- Modify: `src/domain/outline-features/types.ts`
- Modify: `src/domain/outline-features/types.test.ts`
- Modify: `src/export/colored-outline-document.ts`
- Modify: `src/export/colored-outline-document.test.ts`

**Interfaces:**
- Produces:

```ts
export class ProtectedCutWorkBudgetError extends RangeError {
  readonly name = 'ProtectedCutWorkBudgetError';
  readonly code = 'PROTECTED_CUT_WORK_BUDGET';
}

export type DepthFeatureOmissionCode =
  | 'INSUFFICIENT_DEPTH_DATA'
  | 'INSUFFICIENT_CONTRAST'
  | 'UNRELIABLE_DEPTH_GEOMETRY'
  | 'PROTECTED_CUT_WORK_BUDGET';

export type DecorationOmission = {
  readonly layerId: string;
  readonly reason: 'protected-cut-work-budget';
  readonly roles: readonly ['DEEP_RED', 'LIGHT_BLUE'];
};
```

`AutomaticOutlineAssembly` gains:

```ts
readonly decorationOmissions: readonly DecorationOmission[];
```

- [ ] **Step 1: Write the typed-error RED tests**

Add a request whose `protectedPointCount * width * height` exceeds the existing bound:

```ts
expect(() => buildDepthField(projected, oversizedProtectedRequest))
  .toThrow(ProtectedCutWorkBudgetError);
```

Also assert every existing raster, hit, component, topology, deadline, and cancellation error is not an instance of that class.

- [ ] **Step 2: Run RED**

Run:

```bash
npx vitest run src/domain/outline-features/depth-field.test.ts
```

Expected: FAIL because the typed error does not exist.

- [ ] **Step 3: Throw and catch only the typed condition**

At the exact work-product guard:

```ts
if (protectedPointCount * width * height > MAX_DEPTH_COMPONENT_BYTES) {
  throw new ProtectedCutWorkBudgetError(
    'Depth feature extraction exceeds the protected cut work budget',
  );
}
```

In `extractAdaptiveDepthFeatures()`, wrap only `buildDepthField()`:

```ts
let field: DepthField;
try {
  field = buildDepthField(projected, effectiveRequest);
} catch (error) {
  if (!(error instanceof ProtectedCutWorkBudgetError)) throw error;
  return omission(
    'PROTECTED_CUT_WORK_BUDGET',
    '三爪孔保護運算量超出上限，已省略此層紅藍裝飾',
    {
      cellSizeMm: request.cellSizeMm,
      contrastMm: 0,
      redThresholdMm: 0,
      blueThresholdMm: 0,
    },
  );
}
```

- [ ] **Step 4: Verify per-layer GREEN and fatal-error propagation**

Test two or more layers where only one layer triggers the typed error:

```ts
expect(affected.red).toEqual([]);
expect(affected.blue).toEqual([]);
expect(affected.omissionCode).toBe('PROTECTED_CUT_WORK_BUDGET');
expect(unaffected.red.length + unaffected.blue.length).toBeGreaterThan(0);
```

Use exact thrown instances to prove deadline, cancellation, invalid topology, and other resource errors still propagate.

- [ ] **Step 5: Write canonical-evidence RED tests**

Require:

```ts
expect(result.assembly.decorationOmissions).toEqual([{
  layerId: affectedLayer.id,
  reason: 'protected-cut-work-budget',
  roles: ['DEEP_RED', 'LIGHT_BLUE'],
}]);
expect(result.status).toBe('warning');
expect(result.featureWarnings).toContain(
  '三爪孔保護運算量超出上限，已省略此層紅藍裝飾',
);
```

Mutation tests must reject missing/extra keys, duplicated/reordered/unknown layer IDs, wrong reason/roles, decoration present on an omitted layer, cleared decoration without evidence, missing warning, wrong diagnostic code, and changed black contours.

- [ ] **Step 6: Derive, fingerprint, copy, and strictly validate evidence**

In `withResultEvidence()`, derive the ordered array from `extraction.depthFeatures` and `coloredLayers`. Do not accept omission evidence from callers.

Extend exact assembly-key validation, feature fingerprint input, canonical copy, warning reconciliation, and per-layer role/diagnostic checks. Require an empty array when no layer has this omission.

- [ ] **Step 7: Run Task 2 GREEN**

Run:

```bash
npx vitest run \
  src/domain/outline-features/depth-field.test.ts \
  src/domain/outline-2.5d/extract.test.ts \
  src/domain/pipeline/automatic-outline-pipeline.test.ts \
  src/domain/outline-features/types.test.ts \
  src/export/colored-outline-document.test.ts \
  --maxWorkers=1 --fileParallelism=false
npm run typecheck
```

Expected: all assertions pass. If the monolithic process encounters the known Vitest RPC timeout after assertions, rerun exhaustive focused shards and report both results separately.

- [ ] **Step 8: Commit Task 2**

```bash
git add \
  src/domain/outline-features/depth-field.ts \
  src/domain/outline-features/depth-field.test.ts \
  src/domain/outline-2.5d/extract.test.ts \
  src/domain/pipeline/automatic-outline-pipeline.ts \
  src/domain/pipeline/automatic-outline-pipeline.test.ts \
  src/domain/outline-features/types.ts \
  src/domain/outline-features/types.test.ts \
  src/export/colored-outline-document.ts \
  src/export/colored-outline-document.test.ts
git commit -m "feat: omit over-budget decoration per layer"
```

---

### Task 3: Artifacts, UI, and Versioned Persistence

**Files:**
- Modify: `src/export/outline-package.ts`
- Modify: `src/export/outline-package.test.ts`
- Modify: `src/persistence/one-click-project-repository.ts`
- Modify: `src/persistence/one-click-project-repository.test.ts`
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/App.test.tsx`

**Interfaces:**
- Consumes: Task 2 `AutomaticOutlineAssembly.decorationOmissions`.
- Produces: manifest decision `decorationOmissions`, stored schema v3, and visible affected-layer warnings.

- [ ] **Step 1: Write artifact mutation RED tests**

Require project and manifest to contain the identical ordered array. For every mutation, rebuild the project member, member SHA-256/length, manifest, and ZIP wrappers:

```ts
[
  ['wrong-layer', [{ layerId: 'missing', reason, roles }]],
  ['wrong-reason', [{ layerId, reason: 'other', roles }]],
  ['wrong-roles', [{ layerId, reason, roles: ['DEEP_RED'] }]],
  ['reordered', [...omissions].reverse()],
  ['missing', undefined],
]
```

Mutate SVG, DXF, both PDFs, and ZIP-only geometry by adding one red or blue contour to an omitted layer; verification must reject each synchronized forgery.

- [ ] **Step 2: Run artifact RED**

Run:

```bash
npx vitest run src/export/outline-package.test.ts
```

Expected: FAIL because manifest decisions and semantic verification omit the new evidence.

- [ ] **Step 3: Add canonical project/manifest reconciliation**

Add `decorationOmissions: document.assembly.decorationOmissions` beside
`launcher`, `fastener`, and `topFeatures` in project JSON. Add the same explicit
manifest decision:

```ts
decorationOmissions: document.assembly.decorationOmissions,
```

Verify exact equality among canonical document, project, manifest, member hashes, ZIP bytes, and parsed artifact roles. Do not add warning text to fabrication outputs.

- [ ] **Step 4: Write persistence v3 RED tests**

Current records become:

```ts
type StoredOneClickProjectV3 = {
  readonly schemaVersion: 3;
  // existing fields...
  readonly launcherExteriorExpansion: LauncherExteriorExpansion;
  readonly decorationOmissions: readonly DecorationOmission[] | null;
  readonly status: 'ready' | 'regeneration-required';
};
```

Test:

- valid ready v3 requires a non-null normalized ordered array, including `[]`;
- strict v2 migrates in memory to v3 with `decorationOmissions: null` and regeneration-required;
- null is allowed only for regeneration-required;
- invalid keys, duplicates, ordering, layer IDs, reason, or roles fail;
- canonical mismatch saves a replacement regeneration-required record before packaging;
- matching explicit regeneration enables downloads and re-arms the gate.

- [ ] **Step 5: Implement v3 parser and save gate**

Use a discriminated v2/v3 parser. Never invent old omission decisions. On successful canonical conversion save:

```ts
decorationOmissions: structuredClone(
  result.assembly.decorationOmissions,
),
```

Compare exact ordered decisions before packaging. Source reattachment alone cannot clear a mismatch.

- [ ] **Step 6: Write UI RED tests**

Assert:

```ts
expect(screen.getByText(
  '三爪孔保護運算量超出上限，已省略此層紅藍裝飾',
)).toBeVisible();
expect(screen.getByText(`受影響層：${layerId}`)).toBeVisible();
expect(screen.getByText('官方三爪孔及黑色切割幾何已保留')).toBeVisible();
```

Require the result to be styled/labeled as warning, not complete success. Test multiple ordered affected IDs, no warning for `[]`, v2 migration gate, replacement-save propagation, discard/new-source flow, and physical-calibration note.

- [ ] **Step 7: Implement UI and run Task 3 GREEN**

Run:

```bash
npx vitest run \
  src/export/outline-package.test.ts \
  src/persistence/one-click-project-repository.test.ts \
  src/app/OneClickConverter.test.tsx \
  src/app/App.test.tsx \
  --maxWorkers=1 --fileParallelism=false
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass; typecheck/build/diff check exit `0`.

- [ ] **Step 8: Commit Task 3**

```bash
git add \
  src/export/outline-package.ts \
  src/export/outline-package.test.ts \
  src/persistence/one-click-project-repository.ts \
  src/persistence/one-click-project-repository.test.ts \
  src/app/OneClickConverter.tsx \
  src/app/OneClickConverter.test.tsx \
  src/app/App.test.tsx
git commit -m "feat: report protected decoration omissions"
```

---

### Task 4: Knight and Release Verification

**Files:**
- Modify: `src/export/real-fixtures.integration.test.ts`
- Modify: `src/test/launcher-runtime-validation.test.ts`
- Modify: `src/test/validate-fixtures-release.test.ts`
- Modify: `src/workers/geometry-worker.browser.test.ts`
- Modify: `e2e/helpers.ts`
- Modify: `e2e/happy-path.spec.ts`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: all approved contracts from Tasks 1–3.
- Produces: fresh Knight offsets, omission-layer evidence, cross-format equality, browser verification, and explicit physical-test blocker.

- [ ] **Step 1: Keep the two Knight expectations as RED-to-GREEN acceptance**

For both reference files:

```ts
expect(result.assembly.launcher.exteriorExpansion.offsetMm)
  .toBeGreaterThan(0);
expect(result.assembly.launcher.exteriorExpansion.offsetMm)
  .toBeLessThanOrEqual(6);
expect(result.coloredLayers.slice(-2).every(
  (layer) => layer.launcherCuts.length === 3,
)).toBe(true);
expect(result.assembly.decorationOmissions.every((omission) =>
  result.coloredLayers.some((layer) =>
    layer.id === omission.layerId
      && layer.deepFeatures.length === 0
      && layer.lightFeatures.length === 0,
  ),
)).toBe(true);
```

Snapshot every black contour before package generation and require byte-equivalent geometry afterward.

- [ ] **Step 2: Run focused Knight GREEN**

Run:

```bash
npx vitest run src/export/real-fixtures.integration.test.ts \
  --maxWorkers=1 --fileParallelism=false
```

Expected: both Knight cases pass within the existing per-conversion 30-second deadline. Record exact elapsed times, offsets, rotations, and omission layer IDs.

- [ ] **Step 3: Extend worker and artifact grammar checks**

Verify:

- public worker transfer includes canonical omission evidence but excludes central-hole source evidence and private decoration evidence;
- preview, SVG, DXF, PDFs, project, manifest, and ZIP agree on affected layers and contain no red/blue contours there;
- unaffected layers retain canonical roles;
- launcher and exterior-expansion geometry remains identical across formats;
- all mutation cases fail verification.

- [ ] **Step 4: Run focused browser and release matrices**

Run:

```bash
npx vitest run \
  src/test/launcher-runtime-validation.test.ts \
  src/export/real-fixtures.integration.test.ts \
  src/test/validate-fixtures-release.test.ts \
  --maxWorkers=1 --fileParallelism=false
npx vitest run --config vitest.browser.config.ts \
  src/workers/geometry-worker.browser.test.ts
npx playwright test e2e/happy-path.spec.ts --project=chromium
```

Expected: all assertions pass. Report browser-provider/RPC infrastructure failures separately from product assertions.

- [ ] **Step 5: Run proportionate full verification**

Run:

```bash
npx vitest run --maxWorkers=1 --fileParallelism=false
npm run typecheck
npm run build
npx playwright test --project=chromium
git diff --check 3dc11a0..HEAD
git status --short
```

Expected: no product assertion failure; typecheck/build/Chromium/diff check pass. If the known post-assertion Vitest RPC timeout recurs, preserve the exact assertion summary and nonzero process result without calling the command passed.

- [ ] **Step 6: Update ledger and commit verification**

Record:

- exact Knight offsets, rotations, elapsed times, and omission layer IDs;
- focused, artifact, browser, E2E, typecheck, build, and full-suite results;
- any reproducible Vitest RPC infrastructure result; and
- `physical coupon + official launcher latch/release/play/damage test: outstanding`.

Commit:

```bash
git add \
  src/export/real-fixtures.integration.test.ts \
  src/test/launcher-runtime-validation.test.ts \
  src/test/validate-fixtures-release.test.ts \
  src/workers/geometry-worker.browser.test.ts \
  e2e/helpers.ts \
  e2e/happy-path.spec.ts \
  .superpowers/sdd/progress.md
git commit -m "test: verify protected Knight launcher output"
```

---

## Final Review Gate

1. Generate a review package from `3dc11a0` to the final head.
2. Review against all three approved specs:
   - `2026-07-27-official-three-prong-launcher-cut-design.md`;
   - `2026-07-28-launcher-exterior-expansion-design.md`;
   - `2026-07-28-protected-cut-decoration-omission-design.md`.
3. Include both implementation plans and the SDD progress ledger.
4. Fix every Critical or Important implementation finding in one focused wave and re-review.
5. Triage the Task 3 PDF positive-anchor Minor from the earlier review.
6. Keep physical official-launcher acceptance and any verified Vitest RPC infrastructure failure separate from implementation quality.
7. Do not merge or claim physical compatibility without explicit user integration direction and physical-test evidence.
