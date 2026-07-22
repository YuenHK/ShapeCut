# Launcher, Fasteners, Top Features, and Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add required per-upload material selection, up to 12 red and 12 blue top-layer features, safe three-hook launcher clearance, degrading 3/2/1/0 screw fixation, and an eight-second half-speed processing presentation to the one-click converter.

**Architecture:** Extend the bounded colored-geometry contract with ordered cut and engraving arrays, then place launcher and fastener planning between shared-hole reconciliation and depth-feature extraction. A required material subset crosses the worker boundary and drives the existing kerf/minimum-web rules. A cancellable UI timeline presents real monotonic worker progress without changing geometry deadlines.

**Tech Stack:** TypeScript 5.9, React 19, Three.js 0.179, Zod 4, Comlink, Vitest, Vitest Browser with Chromium, Playwright, pdf-lib, JSZip, Vite.

## Global Constraints

- Every upload requires explicit selection of a valid material profile before conversion starts.
- Only profile ID/name, thickness, kerf, minimum feature, minimum web, and fit allowances cross the worker boundary.
- The top layer may retain at most 12 `DEEP_RED` and 12 `LIGHT_BLUE` contours; every other layer retains at most one of each.
- Launcher clearance uses one detected three-hook group or the versioned Knight Fortress fallback, appears identically on the top two layers, and is never scaled to force a fit.
- Unsafe launcher clearance is omitted as one group with a sanitized compatibility warning.
- Finished screw-hole diameter is 3.00 mm; patterns degrade 3 at 120 degrees, 2 at 180 degrees, 1 at the thickest common location, then 0 with a warning.
- Every retained screw center is identical through all layers.
- Black cut geometry has priority over engraving; invalid clipped engraving is omitted.
- Processing lasts at least 8,000 ms, each of five stages is shown at least 1,500 ms for fast jobs, and automatic rotation runs at 50% of its current speed.
- Replacing a file cancels worker, preview, timers, result hold, and material confirmation.
- Actual geometry is never fabricated before parsing; manual camera controls remain absent.
- SVG, DXF, preview PDF, exploded PDF, and the exact four-entry ZIP derive from one canonical document.
- Both supplied Knight Fortress STL files remain untracked, private, and mandatory real-model regressions.

---

### Task 1: Required Material Selection and Worker Contract

**Files:**
- Create: `src/domain/materials/manufacturing-profile.ts`
- Create: `src/domain/materials/manufacturing-profile.test.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry-client.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `src/workers/geometry-api.test.ts`
- Modify: `src/workers/geometry-worker.browser.test.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Produces `ManufacturingGeometryProfile` and `manufacturingGeometryProfile(profile: MaterialProfile): ManufacturingGeometryProfile`.
- Changes `AutomaticOutlineRequest` to `{ bytes: ArrayBuffer; material: ManufacturingGeometryProfile }`.
- Changes `OneClickConverterServices.convert` to `(bytes, material, onProgress?)`.
- Adds view state `{ kind: 'material'; fileName: string; bytes: ArrayBuffer }`.

- [ ] **Step 1: Add failing material-subset tests**

```ts
const geometry = manufacturingGeometryProfile(validProfile);
expect(geometry).toEqual({
  id: validProfile.id,
  name: validProfile.materialName,
  thicknessMm: validProfile.thicknessMm,
  kerfMm: validProfile.kerfMm,
  minFeatureMm: validProfile.minFeatureMm,
  minWebMm: validProfile.minWebMm,
  fitAllowanceMm: validProfile.fitAllowanceMm,
});
expect(JSON.stringify(geometry)).not.toMatch(/operator|batch|signature|manufacturer/i);
expect(() => validateManufacturingGeometryProfile({ ...geometry, kerfMm: -1 })).toThrow(/kerf/i);
```

Add structured-clone worker tests that reject unknown keys, non-finite values, forbidden strings, and profiles exceeding 500-character ID/name bounds.

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run src/domain/materials/manufacturing-profile.test.ts src/workers/geometry-api.test.ts`

Expected: FAIL because the manufacturing subset and request field do not exist.

- [ ] **Step 3: Implement the bounded subset and worker revalidation**

```ts
export type ManufacturingGeometryProfile = {
  readonly id: string;
  readonly name: string;
  readonly thicknessMm: number;
  readonly kerfMm: number;
  readonly minFeatureMm: number;
  readonly minWebMm: number;
  readonly fitAllowanceMm: Readonly<Record<'loose' | 'slip' | 'snug' | 'press', number>>;
};

export function validateManufacturingGeometryProfile(value: unknown): ManufacturingGeometryProfile;
export function manufacturingGeometryProfile(profile: MaterialProfile): ManufacturingGeometryProfile;
```

Use the existing material Zod schema before projection and a strict dedicated Zod schema after structured cloning. Include material evidence in the feature fingerprint using only this subset.

- [ ] **Step 4: Add the required material UI flow**

After file size/name validation, store copied bytes in `kind: 'material'`. Render built-in and saved profiles that pass existing safety validation. Selecting a profile immediately calls `processFile(bytes, profileSubset)`. A replacement file calls `services.cancel()`, clears old bytes/profile, and opens a fresh chooser.

Component tests must assert:

```ts
await user.upload(fileInput, file);
expect(convert).not.toHaveBeenCalled();
await user.selectOptions(screen.getByLabelText('選擇製作材料'), profile.id);
expect(convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), expectedSubset, expect.any(Function));
await user.upload(screen.getByLabelText('選擇 STL 模型'), replacement);
expect(screen.getByLabelText('選擇製作材料')).toHaveValue('');
```

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run src/domain/materials/manufacturing-profile.test.ts src/workers/geometry-api.test.ts src/app/App.test.tsx src/app/OneClickConverter.test.tsx`

Expected: PASS.

Run: `npm run test:browser -- src/workers/geometry-worker.browser.test.ts`

Expected: PASS.

```bash
git add src/domain/materials/manufacturing-profile.ts src/domain/materials/manufacturing-profile.test.ts src/domain/pipeline/automatic-outline-pipeline.ts src/workers src/app/App.tsx src/app/App.test.tsx src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx src/styles.css
git commit -m "feat: require material before outline conversion"
```

---

### Task 2: Multi-Contour Colored Geometry Contract

**Files:**
- Modify: `src/domain/outline-features/types.ts`
- Modify: `src/domain/outline-features/types.test.ts`
- Modify: `src/domain/outline-features/validate.ts`
- Modify: `src/domain/outline-features/validate.test.ts`
- Modify: `src/export/colored-outline-document.ts`
- Modify: `src/export/colored-outline-document.test.ts`
- Modify: `src/export/colored-outline-test-fixture.ts`
- Modify: `src/preview/OutlineProcessViewport.tsx`
- Modify: `src/preview/OutlineProcessViewport.test.tsx`
- Modify: `src/preview/outline-process-scene.ts`
- Modify: `src/preview/outline-process-scene.test.ts`

**Interfaces:**
- Replaces optional single contours with `deepFeatures`, `lightFeatures`, `launcherCuts`, and `fastenerHoles` arrays.
- Produces `migrateColoredOutlineLayer(value): ColoredOutlineLayer` for legacy zero/one values.

- [ ] **Step 1: Write contract and migration failures**

```ts
expect(migrateColoredOutlineLayer({ ...legacy, deepFeature: red, lightFeature: blue }))
  .toMatchObject({ deepFeatures: [red], lightFeatures: [blue], launcherCuts: [], fastenerHoles: [] });
expect(() => validateAutomaticColoredResult(withTopFeatures(13, 0))).toThrow(/12.*deep/i);
expect(() => validateAutomaticColoredResult(withLowerFeatures(2, 0))).toThrow(/one.*deep/i);
expect(() => validateAutomaticColoredResult(withUnexpectedLegacyAndArrays())).toThrow(/unexpected|legacy/i);
```

Also assert a maximum of three launcher cuts, three fastener holes, globally unique IDs, correct roles, bounded points, deterministic array order, preview equality, and fingerprint sensitivity to array order/geometry.

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run src/domain/outline-features/types.test.ts src/domain/outline-features/validate.test.ts src/export/colored-outline-document.test.ts`

Expected: FAIL on missing array fields and migration.

- [ ] **Step 3: Implement strict array validation and compatibility read**

```ts
export type ColoredOutlineLayer = {
  readonly id: string;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly exterior: FeatureContour;
  readonly centralHole?: FeatureContour;
  readonly launcherCuts: readonly FeatureContour[];
  readonly fastenerHoles: readonly FeatureContour[];
  readonly deepFeatures: readonly FeatureContour[];
  readonly lightFeatures: readonly FeatureContour[];
  readonly removedComponentCount: number;
  readonly diagnostics: LayerFeatureDiagnostics;
};
```

Production writers accept only arrays. Migration is restricted to explicit legacy import/structured-clone boundaries and removes legacy properties before validation.

- [ ] **Step 4: Update preview and canonical writers**

Iterate in canonical order: exterior, central hole, launcher cuts, fastener holes, red features, blue features. Preserve black/red/blue colors and result-layer highlighting in WebGL and SVG fallback.

- [ ] **Step 5: Run focused suites and commit**

Run: `npx vitest run src/domain/outline-features/types.test.ts src/domain/outline-features/validate.test.ts src/export/colored-outline-document.test.ts src/preview/OutlineProcessViewport.test.tsx src/preview/outline-process-scene.test.ts`

Expected: PASS.

```bash
git add src/domain/outline-features src/export/colored-outline-document.ts src/export/colored-outline-document.test.ts src/export/colored-outline-test-fixture.ts src/preview
git commit -m "feat: support bounded multi-contour outline features"
```

---

### Task 3: Top-Layer Multi-Feature Extraction and Protected Cuts

**Files:**
- Create: `src/domain/outline-features/top-feature-planner.ts`
- Create: `src/domain/outline-features/top-feature-planner.test.ts`
- Modify: `src/domain/outline-features/depth-field.ts`
- Modify: `src/domain/outline-features/depth-field.test.ts`
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/outline-2.5d/extract.test.ts`

**Interfaces:**
- Extends `DepthFeatureRequest` with `maximumFeaturesPerRole` and `protectedCuts`.
- Changes `DepthFeatureResult` to ordered `red` and `blue` arrays plus retained/omitted counts.
- Produces `rankTopFeatures(candidates, limit, deadline)`.

- [ ] **Step 1: Add failing ranking, clipping, and layer-limit tests**

Create stepped/noisy surfaces yielding at least 14 disconnected candidates. Assert the top layer keeps exactly 12 per role in deterministic area/contrast/ambiguity/min-coordinate order, while a lower layer keeps one. Add protected cut polygons crossing candidates and assert retained contours do not overlap those polygons or their required clearance.

```ts
const result = extractAdaptiveDepthFeatures(surface, {
  ...request,
  maximumFeaturesPerRole: 12,
  protectedCuts: [centralHole, ...launcherCuts, ...fastenerHoles],
});
expect(result.red).toHaveLength(12);
expect(result.blue).toHaveLength(12);
expect(result.red.map(({ id }) => id)).toEqual(expectedDeterministicOrder);
```

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run src/domain/outline-features/top-feature-planner.test.ts src/domain/outline-features/depth-field.test.ts src/domain/outline-2.5d/extract.test.ts`

Expected: FAIL because extraction returns one contour per role and masks only the central hole.

- [ ] **Step 3: Implement bounded component collection and ranking**

Retain component evidence already produced by the depth raster. Trace at most 64 candidates per role, simplify each under 4,096 points, clip/mask before tracing, reject invalid fragments, then rank and slice to `maximumFeaturesPerRole`. Account for all live component memory under the existing 64 MiB cap and shared deadline.

- [ ] **Step 4: Integrate top-layer identification**

In both exact and projected extraction, identify `layers.length - 1` as top after ordered validation. Pass `12` only there and `1` elsewhere. Preserve omission warnings only when no reliable contour remains; publish top retained/omitted counts in diagnostics.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/domain/outline-features/top-feature-planner.test.ts src/domain/outline-features/depth-field.test.ts src/domain/outline-2.5d/extract.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts`

Expected: PASS.

```bash
git add src/domain/outline-features/top-feature-planner.ts src/domain/outline-features/top-feature-planner.test.ts src/domain/outline-features/depth-field.ts src/domain/outline-features/depth-field.test.ts src/domain/outline-2.5d/extract.ts src/domain/outline-2.5d/extract.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts
git commit -m "feat: preserve multiple top-layer engraving contours"
```

---

### Task 4: Three-Hook Detection and Versioned Knight Fallback

**Files:**
- Create: `src/domain/outline-assembly/launcher.ts`
- Create: `src/domain/outline-assembly/launcher.test.ts`
- Create: `src/domain/outline-assembly/launcher-template.ts`
- Create: `src/domain/outline-assembly/launcher-template.test.ts`
- Create: `scripts/generate-launcher-template.ts`
- Modify: `scripts/validate-fixtures.ts`

**Interfaces:**
- Produces `detectLauncherTemplate(request): LauncherDetection`.
- Produces `planLauncherClearance(request): LauncherPlan`.
- Publishes `KNIGHT_FORTRESS_LAUNCHER_TEMPLATE` with version, three normalized loops, and non-private numeric provenance hashes.

```ts
export type LauncherPlan =
  | { readonly status: 'detected' | 'fallback'; readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour]; readonly assemblyAllowanceMm: 0.2 }
  | { readonly status: 'omitted'; readonly cuts: readonly []; readonly warning: string };
```

- [ ] **Step 1: Write failing synthetic detector tests**

Test three loops at 112–128 degree gaps, reject gaps outside the ±8 degree rule, reject non-simple/open loops, prefer stronger centered evidence, normalize rotation deterministically, and enforce 4,096-point/runtime bounds.

- [ ] **Step 2: Write failing template compatibility tests**

Assert compatibility requires three-loop topology, ≤5% corresponding radius difference, ≤10% area difference, and ≤0.50 mm symmetric mean point distance. Assert incompatible references fail rather than average.

- [ ] **Step 3: Implement detector, normalization, and safe two-layer planning**

Use existing projection basis and containment kernel. Offset the chosen cuts using existing material compensation plus 0.20 mm radial assembly allowance. Apply identical geometry to top and second layer; omit all three if either layer rejects any cut. Never scale.

- [ ] **Step 4: Generate the numeric fallback from external files**

Run:

```bash
source_fixture_root=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
KNIGHT_FORTRESS_STL="$source_fixture_root/Copy of Beyblade X Knight Fortress.stl" \
KNIGHT_FORTRESS_GROUP_STL="$source_fixture_root/Copy of Beyblade X Knight Fortress Group.stl" \
npx vite-node scripts/generate-launcher-template.ts
```

The script prints a deterministic TypeScript initializer and hashes. Add only normalized numeric output to `launcher-template.ts` with `apply_patch`. It must never write or print absolute input paths.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/domain/outline-assembly/launcher.test.ts src/domain/outline-assembly/launcher-template.test.ts`

Expected: PASS.

Run the generator twice and compare stdout hashes; expected identical.

```bash
git add src/domain/outline-assembly scripts/generate-launcher-template.ts scripts/validate-fixtures.ts
git commit -m "feat: detect launcher clearance with safe fallback"
```

---

### Task 5: Safe 3/2/1/0 Screw-Hole Planner

**Files:**
- Create: `src/domain/outline-assembly/fasteners.ts`
- Create: `src/domain/outline-assembly/fasteners.test.ts`
- Create: `src/domain/outline-assembly/protected-region.ts`
- Create: `src/domain/outline-assembly/protected-region.test.ts`

**Interfaces:**
- Produces `planFastenerHoles(request): FastenerPlan`.
- Consumes every layer exterior, central hole, launcher cuts, and `ManufacturingGeometryProfile`.

```ts
export type FastenerPlan = {
  readonly count: 0 | 1 | 2 | 3;
  readonly holes: readonly FeatureContour[];
  readonly centers: readonly Point2[];
  readonly finishedDiameterMm: 3;
  readonly pathDiameterMm: number;
  readonly radiusMm?: number;
  readonly rotationRad?: number;
  readonly warning?: string;
};
```

- [ ] **Step 1: Add RED tests for each degradation level**

Use nested synthetic exteriors/protected zones to force 3, 2, 1, and 0 outcomes. Assert 120/180-degree center geometry, equal radii, deterministic rotation, maximum safe radius, thickest single location, and identical centers across all layers.

- [ ] **Step 2: Add kerf and budget RED tests**

Assert `pathDiameterMm` uses the existing inside-cut compensation to target 3.00 mm and remains positive. Reject profiles whose kerf/minimum-web makes a safe finished hole impossible. Bound angular/radial candidates and call the shared deadline checkpoint.

- [ ] **Step 3: Implement deterministic search**

Search count before radius: 3-hole rotations/radii, then 2-hole rotations/radii, then the maximum-clearance one-hole grid candidate. Candidate circles use a fixed 48-point loop. Every loop must pass all-layer containment and clearance against all protected regions.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run src/domain/outline-assembly/fasteners.test.ts src/domain/outline-assembly/protected-region.test.ts`

Expected: PASS.

```bash
git add src/domain/outline-assembly/fasteners.ts src/domain/outline-assembly/fasteners.test.ts src/domain/outline-assembly/protected-region.ts src/domain/outline-assembly/protected-region.test.ts
git commit -m "feat: plan safe degrading screw fixation"
```

---

### Task 6: Assembly Integration, Canonical Exports, and Result Summary

**Files:**
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.test.ts`
- Modify: `src/domain/outline-features/types.ts`
- Modify: `src/export/colored-outline-document.ts`
- Modify: `src/export/colored-outline-document.test.ts`
- Modify: `src/export/svg.ts`
- Modify: `src/export/dxf.ts`
- Modify: `src/export/exploded-pdf.ts`
- Modify: `src/export/exploded-pdf.test.ts`
- Modify: `src/export/outline-package.ts`
- Modify: `src/export/outline-package.test.ts`
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`

**Interfaces:**
- Adds `AutomaticOutlineResult.assembly` with material, launcher, fastener, and top-feature summaries.
- Adds assembly geometry before depth extraction so cuts become engraving masks.

- [ ] **Step 1: Write failing end-to-end pipeline contract tests**

Assert detected/fallback/omitted launcher modes, identical top-two cuts, common 3/2/1 holes on every layer, top feature counts, material summary, warning provenance, preview equality, fingerprint sensitivity, and fail-closed mixed forgery rejection.

- [ ] **Step 2: Integrate planner order**

Refactor extraction/pipeline to build exteriors and shared hole, compute launcher, compute fasteners, then compute depth arrays using all black cuts as `protectedCuts`. Colorization assigns launcher arrays only to the top two layers and fastener arrays to every layer.

- [ ] **Step 3: Update canonical writers and validators**

Every writer emits arrays in canonical order. PDF safety notes include launcher/fastener omissions. Package verification independently reconciles all roles and still requires exactly:

```ts
['cut-and-engrave.svg', 'cut-and-engrave.dxf', 'preview.pdf', 'exploded-view.pdf']
```

- [ ] **Step 4: Add result summary UI**

Display material name/kerf, launcher detected/fallback/omitted, fastener 3/2/1/0, top red/blue retained and omitted counts, and sanitized warnings. Do not add download options or geometry controls.

- [ ] **Step 5: Run focused integration and commit**

Run: `npx vitest run src/domain/pipeline/automatic-outline-pipeline.test.ts src/export/colored-outline-document.test.ts src/export/exploded-pdf.test.ts src/export/outline-package.test.ts src/app/OneClickConverter.test.tsx`

Expected: PASS.

```bash
git add src/domain/outline-2.5d/extract.ts src/domain/pipeline/automatic-outline-pipeline.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/domain/outline-features/types.ts src/export src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx
git commit -m "feat: integrate launcher fasteners and top features"
```

---

### Task 7: Cancellable Eight-Second Processing Timeline

**Files:**
- Create: `src/app/processing-timeline.ts`
- Create: `src/app/processing-timeline.test.ts`
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/preview/outline-process-scene.ts`
- Modify: `src/preview/outline-process-scene.test.ts`
- Modify: `src/preview/OutlineProcessViewport.browser.test.tsx`

**Interfaces:**
- Produces `createProcessingTimeline(clock): ProcessingTimeline` with `advance`, `finish`, and `cancel`.
- Keeps worker callbacks non-blocking; presentation timing lives only in UI state.

```ts
export type ProcessingTimeline = {
  readonly advance: (stage: AutomaticOutlineProgressStage, preview?: OutlinePreviewPayload) => void;
  readonly finish: () => Promise<void>;
  readonly cancel: () => void;
};
```

- [ ] **Step 1: Add fake-clock RED tests**

Assert a fast job shows each stage for 1,500 ms and resolves no earlier than 8,000 ms; a 10-second real job does not receive a second eight-second delay; out-of-order events never regress; cancel clears every timer and rejects/settles pending finish without updating UI.

- [ ] **Step 2: Implement the timeline**

Use an injected `now`, `setTimeout`, and `clearTimeout`. Queue only stages actually reached by the worker. `finish()` drains the minimum presentation schedule and final hold. For jobs already past 8,000 ms, skip remaining artificial holds while preserving monotonic final state.

- [ ] **Step 3: Integrate file replacement and material reset**

Store timeline beside request ID. File replacement calls `cancel()` before service cancellation and returns to material selection. Stale timer callbacks compare request ID before state updates.

- [ ] **Step 4: Halve automatic rotation**

Change the single scene angular-speed constant from its current value to exactly 50%. Keep reduced motion, visibility suspension, stage explosion, and absence of manual controls unchanged.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/app/processing-timeline.test.ts src/app/OneClickConverter.test.tsx src/preview/outline-process-scene.test.ts`

Expected: PASS.

Run: `npm run test:browser -- src/preview/OutlineProcessViewport.browser.test.tsx src/app/App.browser.test.tsx`

Expected: PASS.

```bash
git add src/app/processing-timeline.ts src/app/processing-timeline.test.ts src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx src/preview/outline-process-scene.ts src/preview/outline-process-scene.test.ts src/preview/OutlineProcessViewport.browser.test.tsx
git commit -m "feat: slow and extend processing presentation"
```

---

### Task 8: Real Models, Release Matrix, and Privacy Gate

**Files:**
- Modify: `e2e/one-click-outline.spec.ts`
- Modify: `e2e/happy-path.spec.ts`
- Modify: `e2e/helpers.ts`
- Modify: `src/test/e2e-helpers.test.ts`
- Modify: `scripts/validate-fixtures.ts`

**Interfaces:**
- Consumes the complete runtime result and all five downloads.
- Produces release evidence for launcher, fastener, top features, timing, material, and artifact reconciliation.

- [ ] **Step 1: Extend bounded E2E inspection**

Validate launcher all-or-none on exactly top two layers, fastener count 0–3 with identical centers on all layers, 3.00 mm target metadata, top feature array caps, material subset, warning provenance, and canonical transformations across SVG/DXF/PDF/ZIP.

- [ ] **Step 2: Run both supplied STL cases**

```bash
source_fixture_root=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
KNIGHT_FORTRESS_STL="$source_fixture_root/Copy of Beyblade X Knight Fortress.stl" \
KNIGHT_FORTRESS_GROUP_STL="$source_fixture_root/Copy of Beyblade X Knight Fortress Group.stl" \
npm run test:e2e -- e2e/one-click-outline.spec.ts --workers=1
```

Expected: 2 PASS, zero skips. Each result must report detected or fallback launcher geometry, or a justified safe omission warning; no unsafe partial group is accepted.

- [ ] **Step 3: Run complete verification**

Run: `npm test -- --maxWorkers=1 --minWorkers=1`

Expected: all unit tests PASS.

Run: `npm run test:browser -- --maxWorkers=1 --minWorkers=1`

Expected: all Chromium tests PASS.

Run: `npm run typecheck && npm run build`

Expected: exit 0 and production bundle created.

Run with both STL environment variables: `npm run test:e2e -- --workers=1`

Expected: all E2E tests PASS without skipping either real model.

Run: `npm run test:performance && npm run validate:fixtures`

Expected: all performance and fixture checks PASS with `outputComparisonPass=true`.

- [ ] **Step 4: Audit privacy and diff**

Run: `git diff --check BASE..HEAD`, `git status --short`, and a patch scan for `/Users/`, email addresses, STL names, batch notes, operator names, and signatures.

Expected: no implementation leak; both STL files and existing user output files remain untracked and unstaged.

- [ ] **Step 5: Commit release coverage**

```bash
git add e2e/one-click-outline.spec.ts e2e/happy-path.spec.ts e2e/helpers.ts src/test/e2e-helpers.test.ts scripts/validate-fixtures.ts
git commit -m "test: verify launcher fasteners and top features"
```

---

### Task 9: Final Whole-Branch Review

**Files:**
- Review: every change from the plan base through Task 8

- [ ] **Step 1: Generate a full review package**

Use the Subagent-Driven Development `review-package` script with the recorded branch base and current HEAD. Include the approved spec, this plan, complete diff, test evidence, and any accumulated Minor findings.

- [ ] **Step 2: Request highest-capability read-only review**

Invoke `superpowers:requesting-code-review`. Require explicit checks for geometry safety, material/privacy boundaries, bounded work, migration compatibility, timer cancellation, real-model evidence, and exact artifact cardinality.

- [ ] **Step 3: Fix and re-review findings**

Dispatch one fix agent for the complete final finding list. Every Critical or Important issue requires a focused RED/GREEN regression, covering test output, a commit, and re-review. Do not integrate with open Critical or Important findings.

- [ ] **Step 4: Fresh completion verification**

Run `npm test -- --maxWorkers=1 --minWorkers=1` on the final reviewed commit. Confirm clean status and user assets before offering merge, PR, keep, or discard options through `superpowers:finishing-a-development-branch`.
