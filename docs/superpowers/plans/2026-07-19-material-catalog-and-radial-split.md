# Material Catalog and Radial Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production-ready stored material profiles usable by the real App and make the split-position control change manufacturing geometry.

**Architecture:** The App shares one Dexie database between project and material repositories and exposes validated material catalog operations through `WizardServices`. Decomposition interprets split position as a radial hub boundary and carries it through the real worker/pipeline path.

**Tech Stack:** TypeScript 5.9, React 19, Dexie 4, Zod 4, Vitest, Vitest Browser with Chromium, JSZip, Playwright, Vite.

## Global Constraints

- Built-in material profiles remain read-only and pending.
- Stored profiles use the complete strict `MaterialProfileV1` schema.
- Invalid JSON and missing identity, coupon, or qualified-operator evidence remain fail-closed.
- Package construction independently revalidates material readiness.
- `splitPositionPercent` is finite and within 10–90 inclusive.
- Unsafe split-derived geometry fails closed through existing typed decomposition errors.
- Production code is written only after the corresponding test has failed for the expected reason.

---

### Task 1: Validated material repository JSON boundary

**Files:**
- Modify: `src/persistence/material-repository.ts`
- Test: `src/persistence/material-repository.test.ts`

**Interfaces:**
- Consumes: `MaterialProfileSchema.parse(value)` and Dexie `materials` table.
- Produces: `MaterialRepository.importJson(source: string): Promise<MaterialProfileV1>`.

- [ ] **Step 1: Write failing JSON boundary tests**

Add tests proving valid complete JSON round-trips, malformed JSON writes nothing, schema-invalid JSON writes nothing, and incomplete physical evidence remains stored but classified non-ready.

```ts
await expect(repository.importJson(JSON.stringify(completeProfile))).resolves.toEqual(completeProfile);
await expect(repository.importJson('{broken')).rejects.toThrow(/JSON/i);
await expect(repository.importJson(JSON.stringify({ ...completeProfile, operatorApproval: undefined })))
  .resolves.toMatchObject({ physicalCouponVerified: true });
```

- [ ] **Step 2: Run RED**

Run: `npm run test -- src/persistence/material-repository.test.ts`

Expected: FAIL because `importJson` does not exist.

- [ ] **Step 3: Implement the minimal JSON boundary**

Parse JSON with a controlled error, then call the existing schema-validating `put` method. Do not change readiness classification.

```ts
async importJson(source: string): Promise<MaterialProfileV1> {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error('Material profile JSON is invalid'); }
  return this.put(value);
}
```

- [ ] **Step 4: Run GREEN and commit**

Run: `npm run test -- src/persistence/material-repository.test.ts`

Expected: all repository tests pass.

Commit: `fix: expose validated material profile imports`

### Task 2: Repository-backed App material catalog

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/app/Wizard.tsx`
- Modify: `src/app/steps/EngravingStep.tsx`
- Test: `src/app/Wizard.test.tsx`
- Test: `src/app/App.browser.test.tsx`

**Interfaces:**
- Consumes: `MaterialRepository.list`, `MaterialRepository.get`, `MaterialRepository.importJson`, `DEFAULT_PENDING_MATERIAL_PROFILES`, `classifyMaterialReadiness`.
- Produces on `WizardServices`:
  - `listMaterials(): Promise<readonly MaterialCatalogEntry[]>`
  - `saveMaterialJson(source: string): Promise<MaterialCatalogEntry>`
  - existing `createArtifacts(...)`, now resolving the selected repository profile before the pending fallback.

```ts
export type MaterialCatalogEntry = {
  readonly source: 'builtin' | 'stored';
  readonly profile: MaterialProfileV1;
  readonly readiness: MaterialReadiness;
};
```

- [ ] **Step 1: Write failing Wizard tests**

Cover stored-profile options/readiness, loading a selected profile into the editor, parse/schema error display, reserved built-in ID rejection, save-and-select behavior, and a pending saved profile leaving export blocked.

```tsx
expect(await screen.findByRole('option', { name: /TEST ready.*ready/i })).toBeVisible();
await user.type(screen.getByLabelText('材料設定檔 JSON'), '{broken');
await user.click(screen.getByRole('button', { name: '驗證並儲存材料設定檔' }));
expect(await screen.findByRole('alert')).toHaveTextContent(/JSON/);
```

- [ ] **Step 2: Run Wizard RED**

Run: `npm run test -- src/app/Wizard.test.tsx`

Expected: FAIL because material catalog/editor service and UI do not exist.

- [ ] **Step 3: Write the real Chromium App RED**

Use `symmetric-smooth.stl`, the real worker, real repository, and real package builder. Paste a complete signed profile marked `TEST ONLY`, save/select it, run the real pipeline, intercept the downloaded Blob, open it with JSZip, and assert the stored material ID, ready preflight, and CUT payloads. Add negative cases for malformed JSON and profiles missing identity/coupon/operator evidence.

```ts
const zip = await JSZip.loadAsync(await downloadedBlob.arrayBuffer());
expect(JSON.parse(await zip.file('03-settings/project-settings.json')!.async('string')))
  .toMatchObject({ preflight: { materialReadiness: { status: 'ready' } } });
```

- [ ] **Step 4: Run Chromium RED**

Run: `npm run test:browser -- --run --browser=chromium src/app/App.browser.test.tsx`

Expected: FAIL because the real App exposes no material import/storage path.

- [ ] **Step 5: Implement the catalog and UI minimally**

Construct one shared database in `App`, pass it to both repositories, and inject material list/save/resolve operations into services. Reject saved profiles whose IDs collide with built-in IDs. In `Wizard`, refresh catalog state after save, select the saved ID, invalidate prior artifacts, and render errors. In `EngravingStep`, render readiness-labelled options, the JSON textarea, load button, and save button.

- [ ] **Step 6: Run focused GREEN and commit**

Run:

```bash
npm run test -- src/persistence/material-repository.test.ts src/app/Wizard.test.tsx
npm run test:browser -- --run --browser=chromium src/app/App.browser.test.tsx
```

Expected: focused unit and Chromium suites pass, including ZIP revalidation.

Commit: `fix: wire calibrated materials into the app`

### Task 3: Radial split geometry semantics

**Files:**
- Modify: `src/domain/decomposition/types.ts`
- Modify: `src/domain/decomposition/generate-parts.ts`
- Modify: `src/domain/pipeline/manufacturing-pipeline.ts`
- Test: `src/domain/decomposition/generate-parts.test.ts`
- Test: `src/domain/pipeline/manufacturing-pipeline.test.ts`

**Interfaces:**
- Consumes: `ManufacturingSettings.splitPositionPercent`.
- Produces: `DecompositionOptions.splitPositionPercent` and actual hub/rib/CUT geometry derived from it.

- [ ] **Step 1: Write the domain geometry-oracle RED**

Compare actual hub radii and rib polygon coordinates for 30% and 60% on a generous profile. Also reject 9, 91, `NaN`, and infinity.

```ts
const low = generateParts(profile, material, { ...options, splitPositionPercent: 30 });
const high = generateParts(profile, material, { ...options, splitPositionPercent: 60 });
expect(maximumRadius(lowHub.outline)).toBeCloseTo(outerRadius * 0.30, 8);
expect(maximumRadius(highHub.outline)).toBeCloseTo(outerRadius * 0.60, 8);
expect(highRib.outline.points).not.toEqual(lowRib.outline.points);
```

- [ ] **Step 2: Run domain RED**

Run: `npm run test -- src/domain/decomposition/generate-parts.test.ts`

Expected: FAIL because options do not carry split position and the hub remains `outer * 0.4`.

- [ ] **Step 3: Write the pipeline CUT-oracle RED**

Run the same mesh/material at 30% and 60%; compare numeric CUT polygon coordinates and extents after kerf/nesting. Assert the source mesh and material remain equal so the changed split is the causal input.

- [ ] **Step 4: Run pipeline RED**

Run: `npm run test -- src/domain/pipeline/manufacturing-pipeline.test.ts`

Expected: FAIL because only provenance changes.

- [ ] **Step 5: Implement radial split minimally**

Add and validate the field on `DecompositionOptions`, pass it from the pipeline, and replace the fixed hub radius:

```ts
const hub = outer * options.splitPositionPercent / 100;
```

Keep all shaft, notch, annulus, collision, and structural-margin checks unchanged.

- [ ] **Step 6: Run focused GREEN and commit**

Run:

```bash
npm run test -- src/domain/decomposition/generate-parts.test.ts src/domain/pipeline/manufacturing-pipeline.test.ts
npm run test:browser -- --run --browser=chromium src/workers/geometry-worker.browser.test.ts
```

Expected: geometry oracles and worker boundary pass.

Commit: `fix: apply split position to radial geometry`

### Task 4: Final matrix and evidence

**Files:**
- Modify: `docs/validation/software-results.md`
- Modify: `.superpowers/sdd/final-fix-report.md` (gitignored evidence file)

**Interfaces:**
- Consumes: completed R1/R2 commits and fresh command output.
- Produces: final re-review evidence, exact counts, performance status, and honest remaining physical blocker.

- [ ] **Step 1: Run the complete fresh matrix**

```bash
npm run typecheck
npm run build
npm run test
npm run test:browser -- --run --browser=chromium
npm run test:e2e -- --workers=1
npm run validate:fixtures
```

Expected: every command exits 0; any non-fatal stderr is recorded verbatim rather than hidden.

- [ ] **Step 2: Re-run physical and geometry safety regressions**

Confirm malformed material JSON, incomplete evidence, pending defaults, Knight, invalid mesh, out-of-range split, and unsafe split geometry all remain blocked.

- [ ] **Step 3: Update evidence documents**

Append R1/R2 RED and GREEN evidence, focused commit hashes, fresh counts, and the unchanged external material/coupon/operator blocker.

- [ ] **Step 4: Verify and commit tracked evidence**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intentionally untracked screenshot directories and the ignored report remain outside tracked commits.

Commit: `docs: record material and split re-review results`
