# Launcher Exterior Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both Knight Fortress references accept the fixed launcher template by applying the smallest safe shared uniform exterior offset to the top two physical layers.

**Architecture:** Extend the existing fixed-launcher planner so it can return canonical top-two exterior overrides plus normalized expansion evidence. Keep extracted `OutlineLayer` geometry as immutable source evidence; carry expanded exteriors through the existing black-cut planning boundary into colored canonical layers, validation, artifacts, UI, and persistence. Exporters continue to consume canonical geometry and never construct or infer expansion independently.

**Tech Stack:** TypeScript, React, Vite, Vitest, Playwright, Comlink worker boundary, IndexedDB/Dexie, canonical SVG/DXF/PDF/ZIP writers.

## Global Constraints

- Only the exterior cut contours of the top two physical layers may expand.
- Both affected layers use one shared uniform outward offset.
- The shared offset is the smallest safe `0.01 mm` value and is rounded upward.
- The inclusive expansion range is `0.00 mm` through `6.00 mm`.
- The fixed launcher template, central holes, red/blue decoration coordinates, and every lower layer remain unchanged.
- Material `minWebMm`, kerf, launcher fit offset, topology, deadline, cancellation, point-budget, and deterministic-ordering checks remain mandatory.
- Preview, SVG, DXF, both PDFs, ZIP, `project.json`, and `manifest.json` consume one canonical expanded geometry.
- Unsafe, excessive, or unreproducible expansion blocks all downloads.
- The UI retains `依 Knight Fortress 樣本建立，待官方發射器實物校準` until physical acceptance succeeds.
- No new runtime dependency is permitted.

---

## File Structure

- Create `src/domain/outline-assembly/launcher-exterior-expansion.ts`: constants, normalized evidence, exterior-offset helper, and typed excessive-expansion error.
- Create `src/domain/outline-assembly/launcher-exterior-expansion.test.ts`: grid rounding, shared-offset, limit, topology, and bounded-runtime unit tests.
- Modify `src/domain/outline-assembly/launcher.ts`: search fixed-template rotations against shared expanded exteriors and return the selected canonical exterior overrides.
- Modify `src/domain/outline-assembly/launcher.test.ts`: prove minimum-offset selection and unchanged launcher geometry/ranking.
- Modify `src/domain/outline-2.5d/extract.ts`: allow a black-cut plan to replace a colored exterior without mutating extracted source evidence.
- Modify `src/domain/pipeline/automatic-outline-pipeline.ts`: propagate expanded exteriors, summary evidence, and the typed error.
- Modify `src/domain/pipeline/automatic-outline-pipeline.test.ts`: prove only final-two colored exteriors change.
- Modify `src/domain/outline-features/types.ts`: validate normalized expansion evidence and independently reconstruct expanded exteriors.
- Modify `src/domain/outline-features/types.test.ts`: mutation and source-versus-canonical geometry tests.
- Modify `src/export/colored-outline-document.ts`: copy expansion evidence into the canonical document.
- Modify `src/export/outline-package.ts`: include expansion decisions in project and manifest JSON.
- Modify `src/export/outline-package.test.ts`: verify and mutate expansion metadata and exterior bytes.
- Modify `src/persistence/one-click-project-repository.ts`: persist expansion evidence, migrate the existing record to regeneration-required, and reject drift.
- Modify `src/persistence/one-click-project-repository.test.ts`: migration and strict round-trip tests.
- Modify `src/app/OneClickConverter.tsx`: show the applied shared expansion and save it.
- Modify `src/app/OneClickConverter.test.tsx`: UI, save, reopen, and mismatch-gate tests.
- Modify `src/test/launcher-runtime-validation.test.ts`: cross-format expansion reconciliation.
- Modify `src/export/real-fixtures.integration.test.ts`: require both Knight references to succeed.
- Modify `src/test/validate-fixtures-release.test.ts`: release artifact and manifest reconciliation.
- Modify `e2e/helpers.ts` and `e2e/happy-path.spec.ts`: parse and compare expansion evidence in browser downloads.

---

### Task 1: Shared Exterior Expansion Domain Planner

**Files:**
- Create: `src/domain/outline-assembly/launcher-exterior-expansion.ts`
- Create: `src/domain/outline-assembly/launcher-exterior-expansion.test.ts`
- Modify: `src/domain/outline-assembly/launcher.ts`
- Modify: `src/domain/outline-assembly/launcher.test.ts`

**Interfaces:**
- Consumes: `FeatureContour`, `simpleMiterPolygonKernel`, `validatePolygon`, `contourBounds`, `signedArea`, `launcherCutsArePhysicallySafe()`, and the existing fixed-template rotation ranking.
- Produces:

```ts
export const LAUNCHER_EXTERIOR_EXPANSION_MODE = 'shared-uniform' as const;
export const LAUNCHER_EXTERIOR_EXPANSION_STEP_MM = 0.01 as const;
export const LAUNCHER_EXTERIOR_EXPANSION_MAX_MM = 6 as const;

export type LauncherExteriorExpansion = {
  readonly mode: 'shared-uniform';
  readonly offsetMm: number;
  readonly maxOffsetMm: 6;
  readonly affectedLayerIds: readonly [string, string];
};

export class LauncherExteriorExpansionExceededError extends RangeError {
  readonly name = 'LauncherExteriorExpansionExceededError';
  readonly code = 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED';
  constructor(readonly requiredOffsetMm: number);
}

export function expandLauncherExterior(
  exterior: FeatureContour,
  offsetMm: number,
  deadline?: number,
  checkpoint?: () => void,
): FeatureContour;
```

`FixedLauncherPlan` gains:

```ts
readonly exteriorExpansion: LauncherExteriorExpansion;
readonly expandedTopExterior: FeatureContour;
readonly expandedSecondExterior: FeatureContour;
```

- [ ] **Step 1: Write failing normalization and geometry tests**

Add cases that assert:

```ts
expect(normalizeLauncherExteriorExpansionMm(0)).toBe(0);
expect(normalizeLauncherExteriorExpansionMm(0.001)).toBe(0.01);
expect(normalizeLauncherExteriorExpansionMm(5.999)).toBe(6);
expect(() => normalizeLauncherExteriorExpansionMm(6.001))
  .toThrow(LauncherExteriorExpansionExceededError);

const expanded = expandLauncherExterior(squareExterior('top', 20), 1);
expect(expanded.boundsMm).toEqual({ minX: -11, minY: -11, maxX: 11, maxY: 11 });
expect(expanded.areaMm2).toBeCloseTo(484, 10);
expect(original.outer).toEqual(originalPoints);
```

Also assert that collapsed, multi-polygon, non-simple, non-finite, negative, and over-limit offsets fail without returning partial geometry.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx vitest run src/domain/outline-assembly/launcher-exterior-expansion.test.ts
```

Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement constants, upward grid normalization, and one-contour offset**

Implement exact integer-grid normalization rather than free-form floating comparison:

```ts
export function normalizeLauncherExteriorExpansionMm(requiredMm: number): number {
  if (!Number.isFinite(requiredMm) || requiredMm < 0) {
    throw new RangeError('Launcher exterior expansion must be finite and non-negative');
  }
  const hundredths = Math.ceil((requiredMm - 1e-12) * 100);
  if (hundredths > LAUNCHER_EXTERIOR_EXPANSION_MAX_MM * 100) {
    throw new LauncherExteriorExpansionExceededError(hundredths / 100);
  }
  return hundredths / 100;
}
```

`expandLauncherExterior()` must use the existing miter kernel, require exactly one valid polygon, restore clockwise winding, recompute bounds and area, preserve the exterior ID and role, and call the supplied checkpoint throughout.

- [ ] **Step 4: Run normalization and geometry tests GREEN**

Run:

```bash
npx vitest run src/domain/outline-assembly/launcher-exterior-expansion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing planner tests for shared minimum selection**

Add real planner tests with asymmetric rectangular exteriors:

```ts
const result = planFixedLauncherClearance(request({
  topExterior: rectangleExterior('top', 45, 46),
  secondExterior: rectangleExterior('second', 43, 44),
}));

expect(result.exteriorExpansion).toEqual({
  mode: 'shared-uniform',
  offsetMm: expect.any(Number),
  maxOffsetMm: 6,
  affectedLayerIds: ['second', 'top'],
});
expect(result.exteriorExpansion.offsetMm * 100).toBeInteger();
expect(result.expandedTopExterior.boundsMm.maxX - top.boundsMm.maxX)
  .toBeCloseTo(result.exteriorExpansion.offsetMm, 10);
expect(result.expandedSecondExterior.boundsMm.maxX - second.boundsMm.maxX)
  .toBeCloseTo(result.exteriorExpansion.offsetMm, 10);
```

Add cases for:

- original-safe exteriors returning `0.00 mm` and byte-equivalent exterior geometry;
- one layer needing less expansion than the other;
- exactly `6.00 mm` succeeding;
- the first safe grid value being selected instead of the next larger value;
- a required value above `6.00 mm` throwing `LauncherExteriorExpansionExceededError`;
- a central-hole or inter-prong conflict still failing as `LauncherCompatibilityError`;
- 4,096-point contours respecting checkpoint interruption and deadline;
- launcher cut coordinates remaining identical when only the exterior requirement changes;
- ranking remaining structural clearance, decoration overlap, then rotation.

- [ ] **Step 6: Run planner tests and verify RED**

Run:

```bash
npx vitest run src/domain/outline-assembly/launcher.test.ts
```

Expected: FAIL because `planFixedLauncherClearance()` does not expand or return exterior evidence.

- [ ] **Step 7: Implement bounded shared-offset search**

Refactor candidate construction so launcher geometry for each of the 120 rotations is materialized once. Search grid offsets from `0` through `600` hundredths in ascending order. Cache the two expanded exteriors per tested grid offset. For each offset:

1. build or retrieve both shared-offset exterior contours;
2. reject invalid offset topology for that grid value;
3. rank the already-materialized rotation candidates using the established comparator;
4. select the first ranked candidate whose central-hole, inter-prong, and expanded-exterior safety checks all pass;
5. return immediately, proving the selected grid offset is minimal.

If at least one valid candidate would need more than the final grid value, compute the sanitized next required hundredth and throw `LauncherExteriorExpansionExceededError`. If expansion cannot repair a non-exterior structural conflict, throw the existing `LauncherCompatibilityError`.

Do not build a second launcher template, move the axis, scale cuts, or relax `minWebMm`.

- [ ] **Step 8: Run all Task 1 tests GREEN**

Run:

```bash
npx vitest run \
  src/domain/outline-assembly/launcher-exterior-expansion.test.ts \
  src/domain/outline-assembly/launcher.test.ts \
  --maxWorkers=1 --fileParallelism=false
```

Expected: PASS with no unhandled errors.

- [ ] **Step 9: Commit Task 1**

```bash
git add \
  src/domain/outline-assembly/launcher-exterior-expansion.ts \
  src/domain/outline-assembly/launcher-exterior-expansion.test.ts \
  src/domain/outline-assembly/launcher.ts \
  src/domain/outline-assembly/launcher.test.ts
git commit -m "feat: plan shared launcher exterior expansion"
```

---

### Task 2: Canonical Pipeline and Independent Validation

**Files:**
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/outline-2.5d/extract.test.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.test.ts`
- Modify: `src/domain/outline-features/types.ts`
- Modify: `src/domain/outline-features/types.test.ts`
- Modify: `src/export/colored-outline-document.ts`
- Modify: `src/export/colored-outline-document.test.ts`

**Interfaces:**
- Consumes: Task 1 `FixedLauncherPlan.exteriorExpansion`, `expandedTopExterior`, and `expandedSecondExterior`.
- Produces: `ExistingBlackCuts.exteriorOverride?: FeatureContour` and public `AutomaticLauncherAssembly.exteriorExpansion: LauncherExteriorExpansion`.

- [ ] **Step 1: Write failing extraction tests for exterior overrides**

Extend `ExistingBlackCuts` and test the desired behavior before implementation:

```ts
const result = colorizeExteriorLayers(layers, 0, deadline, checkpoint, [], [], [{
  launcherCuts: [],
  fastenerHoles: [],
  exteriorOverride: expandedExterior,
}]);

expect(result[0].exterior).toEqual(expandedExterior);
expect(layers[0].contour.outer).toEqual(originalOuter);
```

Reject an override whose ID, role, finite/simple topology, or layer association is invalid.

- [ ] **Step 2: Run extraction test and verify RED**

Run:

```bash
npx vitest run src/domain/outline-2.5d/extract.test.ts
```

Expected: FAIL because `ExistingBlackCuts` has no exterior override contract.

- [ ] **Step 3: Implement the black-cut exterior override boundary**

Add:

```ts
export type ExistingBlackCuts = {
  readonly launcherCuts: readonly FeatureContour[];
  readonly fastenerHoles: readonly FeatureContour[];
  readonly exteriorOverride?: FeatureContour;
  readonly engravingProtection?: PhysicalCutProtection;
};
```

`colorizeExteriorLayers()` uses `exteriorOverride` only after validating that its ID is `${layer.id}-exterior`, its role is `CUT_BLACK`, and its geometry is a finite simple clockwise contour. The extracted `OutlineLayer` remains unchanged source evidence.

- [ ] **Step 4: Write failing pipeline tests**

Add a synthetic model case that requires expansion and assert:

```ts
expect(result.assembly.launcher.exteriorExpansion.offsetMm).toBeGreaterThan(0);
expect(result.assembly.launcher.exteriorExpansion.maxOffsetMm).toBe(6);
expect(result.coloredLayers.slice(0, -2).map((layer) => layer.exterior.outer))
  .toEqual(originalColoredLayers.slice(0, -2).map((layer) => layer.exterior.outer));
expect(result.coloredLayers.at(-1)!.exterior.outer)
  .not.toEqual(result.layers.at(-1)!.contour.outer);
expect(result.coloredLayers.at(-2)!.exterior.outer)
  .not.toEqual(result.layers.at(-2)!.contour.outer);
```

Assert the central holes, launcher cuts, and retained decoration coordinates are unchanged between a large original-safe fixture and the same fixture whose exterior alone requires expansion.

Add a case that requires more than `6.00 mm` and expects:

```ts
await expect(convertAutomatically(request)).rejects.toMatchObject({
  code: 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
});
```

- [ ] **Step 5: Run pipeline tests and verify RED**

Run:

```bash
npx vitest run src/domain/pipeline/automatic-outline-pipeline.test.ts
```

Expected: FAIL because expansion is not carried into canonical layers or typed errors.

- [ ] **Step 6: Wire expansion through planning and error attribution**

In `planAssemblyBlackCuts()`:

- replace the final two bare-layer exteriors with Task 1 expanded exteriors before fastener planning;
- set `exteriorOverride` on exactly the final two black-cut records;
- create engraving protection from the overridden exterior;
- copy `launcher.exteriorExpansion` into the summary.

Extend:

```ts
export type AutomaticOutlineErrorCode =
  | 'INVALID_STL'
  | 'NO_OUTLINE'
  | 'RESOURCE_LIMIT'
  | 'TIME_LIMIT'
  | 'LAUNCHER_INCOMPATIBLE'
  | 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED';
```

Map `LauncherExteriorExpansionExceededError` before generic range/resource handling and preserve a message containing the required value and `6.00 mm` limit.

- [ ] **Step 7: Write failing strict-validation mutation tests**

Extend `AutomaticLauncherAssembly` with:

```ts
readonly exteriorExpansion: LauncherExteriorExpansion;
```

Test that `validateAutomaticColoredResult()` rejects:

- missing or extra expansion keys;
- non-grid, negative, non-finite, or over-limit offsets;
- wrong mode or maximum;
- wrong/reversed/duplicated affected layer IDs;
- an unchanged top exterior when offset is positive;
- a changed lower-layer exterior;
- independently expanded top layers;
- an expanded contour that is not the exact deterministic offset of the extracted source contour;
- expansion metadata mutation with unchanged geometry;
- launcher, central-hole, or decoration-coordinate mutation.

- [ ] **Step 8: Run validation tests and verify RED**

Run:

```bash
npx vitest run \
  src/domain/outline-features/types.test.ts \
  src/export/colored-outline-document.test.ts
```

Expected: FAIL because assembly validation and canonical copying do not recognize expansion.

- [ ] **Step 9: Implement independent expansion reconstruction**

Update strict validation to:

1. validate the exact expansion object keys and normalized values;
2. require affected IDs to equal `[layers.at(-2)!.id, layers.at(-1)!.id]`;
3. independently call `expandLauncherExterior()` on the matching extracted source exteriors using the recorded offset;
4. compare every point, bounds value, area, ID, and role with the colored canonical exteriors;
5. require all lower colored exteriors to remain equal to extracted source exteriors;
6. run existing launcher physical safety against the expanded colored exteriors.

Update feature fingerprints and `copyAssembly()` so expansion evidence cannot be dropped or changed.

- [ ] **Step 10: Run all Task 2 tests GREEN**

Run:

```bash
npx vitest run \
  src/domain/outline-2.5d/extract.test.ts \
  src/domain/pipeline/automatic-outline-pipeline.test.ts \
  src/domain/outline-features/types.test.ts \
  src/export/colored-outline-document.test.ts \
  --maxWorkers=1 --fileParallelism=false
```

Expected: PASS.

- [ ] **Step 11: Commit Task 2**

```bash
git add \
  src/domain/outline-2.5d/extract.ts \
  src/domain/outline-2.5d/extract.test.ts \
  src/domain/pipeline/automatic-outline-pipeline.ts \
  src/domain/pipeline/automatic-outline-pipeline.test.ts \
  src/domain/outline-features/types.ts \
  src/domain/outline-features/types.test.ts \
  src/export/colored-outline-document.ts \
  src/export/colored-outline-document.test.ts
git commit -m "feat: carry expanded exteriors into canonical geometry"
```

---

### Task 3: Artifacts, UI, and Persistence

**Files:**
- Modify: `src/export/outline-package.ts`
- Modify: `src/export/outline-package.test.ts`
- Modify: `src/persistence/one-click-project-repository.ts`
- Modify: `src/persistence/one-click-project-repository.test.ts`
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/App.test.tsx`

**Interfaces:**
- Consumes: Task 2 `AutomaticLauncherAssembly.exteriorExpansion`.
- Produces: versioned stored expansion evidence, visible `X.XX mm` status, and reconciled project/manifest decisions.

- [ ] **Step 1: Write failing package grammar and mutation tests**

Require `project.json`:

```json
{
  "assembly": {
    "launcher": {
      "exteriorExpansion": {
        "mode": "shared-uniform",
        "offsetMm": 0.00,
        "maxOffsetMm": 6,
        "affectedLayerIds": ["layer-N-1", "layer-N"]
      }
    }
  }
}
```

Require `manifest.json.decisions` to carry the same four normalized fields. Mutate each field, remove one member, reorder affected IDs, replace one expanded exterior path, and expect `verifyColoredOutlinePackage()` to reject the package.

- [ ] **Step 2: Run package tests and verify RED**

Run:

```bash
npx vitest run src/export/outline-package.test.ts
```

Expected: FAIL because manifest decisions do not include exterior expansion.

- [ ] **Step 3: Add expansion to project and manifest reconciliation**

`coloredProjectJson()` may continue serializing the complete canonical launcher object. Add explicit manifest decisions:

```ts
launcherExteriorExpansionMode: document.assembly.launcher.exteriorExpansion.mode,
launcherExteriorExpansionMm: document.assembly.launcher.exteriorExpansion.offsetMm,
launcherExteriorExpansionMaxMm: document.assembly.launcher.exteriorExpansion.maxOffsetMm,
launcherExteriorExpansionLayerIds:
  document.assembly.launcher.exteriorExpansion.affectedLayerIds,
```

Extend verification to compare those values with project JSON, canonical document evidence, and parsed SVG/DXF/PDF exterior geometry.

- [ ] **Step 4: Write failing persistence migration tests**

Introduce a current stored record with:

```ts
readonly schemaVersion: 2;
readonly launcherExteriorExpansion: LauncherExteriorExpansion | null;
```

Test:

- a valid v2 record round-trips without mutation;
- a v1 record loads as v2 with `launcherExteriorExpansion: null` and `status: 'regeneration-required'`;
- non-grid, over-limit, wrong-mode, wrong-max, or duplicated-layer evidence is rejected;
- `launcherExteriorExpansion: null` is rejected unless status is `regeneration-required`;
- template or expansion evidence mismatch remains regeneration-required after source reattachment;
- saving a regenerated v2 project permits reopening only when canonical expansion agrees.

- [ ] **Step 5: Run persistence tests and verify RED**

Run:

```bash
npx vitest run src/persistence/one-click-project-repository.test.ts src/app/App.test.tsx
```

Expected: FAIL because records are schema v1 and have no expansion evidence.

- [ ] **Step 6: Implement stored-project v2 and fail-closed migration**

Use a discriminated v1/v2 parser. Never persist STL bytes, filenames, preview meshes, provisional decoration evidence, or artifact bytes. A v1 record migrates only to a regeneration-required v2 shell with `launcherExteriorExpansion: null`; it must not claim a canonical affected-layer pair it never stored. A newly saved ready record must always contain non-null normalized expansion evidence.

After a successful canonical conversion, save:

```ts
launcherExteriorExpansion: structuredClone(
  result.assembly.launcher.exteriorExpansion,
),
```

On reopen, source reattachment alone does not clear a mismatch. Only a successful canonical regeneration whose expansion object equals the stored decision enables downloads.

- [ ] **Step 7: Write failing UI tests**

Assert:

```ts
expect(screen.getByText('頂部兩層外框已共同擴大 2.35 mm')).toBeVisible();
expect(screen.getByText('頂部兩層外框已共同擴大 0.00 mm')).toBeVisible();
expect(screen.getByText('依 Knight Fortress 樣本建立，待官方發射器實物校準'))
  .toBeVisible();
```

Test the sanitized over-limit message, persisted save payload, reload/regeneration gate, discard/new-model flow, and the absence of expansion labels inside fabrication SVG/DXF/PDF content.

- [ ] **Step 8: Run UI tests and verify RED**

Run:

```bash
npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx
```

Expected: FAIL because the UI and save payload omit expansion.

- [ ] **Step 9: Implement the result status and persistence gate**

Render the normalized value with `toFixed(2)`. Add:

```ts
LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED:
  '頂部兩層外框需要擴大超過 6.00 mm，已停止所有輸出。',
```

Keep conversion disabled during persistence load, keep corrupted-record deletion scoped to `one-click-current`, and re-arm the fingerprint/expansion gate after every replacement save.

- [ ] **Step 10: Run all Task 3 tests GREEN**

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
```

Expected: all focused tests PASS; typecheck and build exit `0`.

- [ ] **Step 11: Commit Task 3**

```bash
git add \
  src/export/outline-package.ts \
  src/export/outline-package.test.ts \
  src/persistence/one-click-project-repository.ts \
  src/persistence/one-click-project-repository.test.ts \
  src/app/OneClickConverter.tsx \
  src/app/OneClickConverter.test.tsx \
  src/app/App.test.tsx
git commit -m "feat: report and persist launcher exterior expansion"
```

---

### Task 4: Knight Fixtures and Release Verification

**Files:**
- Modify: `src/test/launcher-runtime-validation.test.ts`
- Modify: `src/export/real-fixtures.integration.test.ts`
- Modify: `src/test/validate-fixtures-release.test.ts`
- Modify: `e2e/helpers.ts`
- Modify: `e2e/happy-path.spec.ts`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: all canonical and artifact contracts from Tasks 1–3.
- Produces: fresh evidence that both Knight references succeed across the real browser and release artifact matrix.

- [ ] **Step 1: Change the two Knight fixture expectations to success**

For each reference STL, assert:

```ts
expect(result.assembly.launcher.exteriorExpansion).toMatchObject({
  mode: 'shared-uniform',
  maxOffsetMm: 6,
});
expect(result.assembly.launcher.exteriorExpansion.offsetMm).toBeGreaterThan(0);
expect(result.assembly.launcher.exteriorExpansion.offsetMm).toBeLessThanOrEqual(6);
expect(result.layers.slice(-2).map(({ id }) => id))
  .toEqual(result.assembly.launcher.exteriorExpansion.affectedLayerIds);
expect(result.coloredLayers.slice(-2).every(
  (layer) => layer.launcherCuts.length === 3,
)).toBe(true);
```

Capture the original source contours before conversion comparison and prove only the top-two canonical exteriors changed.

- [ ] **Step 2: Run the Knight integration tests and verify RED**

Run:

```bash
npx vitest run src/export/real-fixtures.integration.test.ts \
  --maxWorkers=1 --fileParallelism=false
```

Expected before the complete implementation: FAIL with `LAUNCHER_INCOMPATIBLE`.

- [ ] **Step 3: Extend cross-format parsers and browser checks**

Update helpers to extract exterior contours and expansion decisions from:

- preview state;
- SVG layer groups;
- DXF layer/entity records;
- both PDFs' canonical metadata;
- ZIP `project.json`;
- ZIP `manifest.json`.

Compare transformed geometry rather than only string keywords. Require the two top exteriors and launcher decisions to reconcile with the canonical document. Confirm no human-readable expansion label was added to fabrication SVG/DXF/PDF.

- [ ] **Step 4: Run release and E2E tests GREEN**

Run:

```bash
npx vitest run \
  src/test/launcher-runtime-validation.test.ts \
  src/export/real-fixtures.integration.test.ts \
  src/test/validate-fixtures-release.test.ts \
  --maxWorkers=1 --fileParallelism=false
npx playwright test e2e/happy-path.spec.ts --project=chromium
```

Expected: both Knight cases and all cross-format checks PASS.

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

Expected:

- all assertions pass;
- no product-test failure is hidden by the known Vitest RPC post-assertion timeout;
- typecheck and build exit `0`;
- Chromium tests pass;
- diff check is empty;
- only intentional progress-ledger changes remain before commit.

If the Vitest RPC timeout recurs after completed assertions, record its exact output and exit code separately. Do not call it a passing full suite and do not change product geometry to mask infrastructure failure.

- [ ] **Step 6: Record physical acceptance as outstanding**

Update `.superpowers/sdd/progress.md` with:

- the exact Knight offsets selected;
- focused, browser, artifact, typecheck, build, and full-suite evidence;
- whether the Vitest RPC issue recurred;
- `physical coupon + official launcher latch/release/play/damage test: outstanding`.

- [ ] **Step 7: Commit Task 4**

```bash
git add \
  src/test/launcher-runtime-validation.test.ts \
  src/export/real-fixtures.integration.test.ts \
  src/test/validate-fixtures-release.test.ts \
  e2e/helpers.ts \
  e2e/happy-path.spec.ts \
  .superpowers/sdd/progress.md
git commit -m "test: verify expanded Knight launcher artifacts"
```

---

## Final Review Gate

Before proposing integration:

1. Generate a whole-branch review package from `3dc11a0` to the final head.
2. Request a read-only review against:
   - `docs/superpowers/specs/2026-07-27-official-three-prong-launcher-cut-design.md`;
   - `docs/superpowers/specs/2026-07-28-launcher-exterior-expansion-design.md`; and
   - this plan.
3. Fix every Critical or Important implementation issue with a focused RED/GREEN cycle and re-review.
4. Keep physical official-launcher testing and any reproducible Vitest RPC infrastructure failure separate from implementation-quality findings.
5. Do not merge or call the release physically accepted without the user's explicit integration decision and the physical test evidence.
