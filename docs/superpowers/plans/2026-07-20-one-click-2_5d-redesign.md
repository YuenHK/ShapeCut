# One-click 2.5D Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the engineering wizard with a one-upload workflow that automatically produces verified, material-independent Laser Cut outline layers, using exact planar sections for safe meshes and a largest-component 2.5D projection fallback for broken meshes.

**Architecture:** A new pure `outline-2.5d` domain owns axis fallback, layer scheduling, exact/raster contour extraction, simplification, and 2D validation. A worker-side automatic pipeline chooses `exact` or `outline-2.5d`, constructs a shared-provenance manufacturing document and export package, while a three-state React UI consumes only progress and final result data.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, Three.js, Comlink/Web Workers, Vitest, Playwright, existing SVG/DXF/PDF/JSON/ZIP exporters.

## Global Constraints

- One file selection starts the complete workflow; no repair, axis, material, decomposition, engraving, or export-confirmation clicks.
- Safe meshes use exact planar contour extraction; blocked 3D repairs automatically use `outline-2.5d` and always return the `warning` result status when successful.
- 2.5D projection keeps only the largest connected exterior at each layer and ignores holes, internal details, and smaller disconnected components.
- Output is material-independent: no slots, press fits, power, speed, passes, or production-ready material claims.
- Preserve source X/Y dimensions and layer Z positions; never silently rescale the model.
- Every output polygon must be finite, closed by representation, non-self-intersecting, non-degenerate, and within bounded area/bounds drift.
- CPU-heavy geometry runs in the restartable geometry worker; selecting a new file truly terminates the old worker job.
- Export SVG, DXF, PDF, JSON, and ZIP from the same validated contours and provenance.
- Never commit either user Knight Fortress STL, expose an absolute local path, or bundle user files.
- Keep existing exact-repair safety rules; never call a broken mesh a repaired safe 3D solid.
- UI is the approved mint/white A direction with only upload, processing, and result states.

---

## File Map

- Create `src/domain/outline-2.5d/types.ts`: public types, budgets, result modes, warnings, and layer records.
- Create `src/domain/outline-2.5d/axis.ts`: reliable candidate selection and shortest-bounds fallback.
- Create `src/domain/outline-2.5d/layer-schedule.ts`: deterministic 6–24 layer schedule and resource accounting.
- Create `src/domain/outline-2.5d/extract.ts`: exact plane sections and slab raster projections.
- Create `src/domain/outline-2.5d/raster.ts`: bounded triangle rasterization, close/fill, largest component, contour tracing.
- Create `src/domain/outline-2.5d/simplify.ts`: Ramer–Douglas–Peucker simplification and drift checks.
- Create `src/domain/outline-2.5d/validate.ts`: fail-closed polygon/layer validation.
- Create `src/domain/outline-2.5d/*.test.ts`: unit, property, budget, and regression tests.
- Create `src/domain/pipeline/automatic-outline-pipeline.ts`: exact/fallback decision, progress, document, provenance, result status.
- Create `src/domain/pipeline/automatic-outline-pipeline.test.ts`: end-to-end domain tests using synthetic meshes.
- Modify `src/workers/geometry-api.ts`, `src/workers/geometry-client.ts`, `src/workers/geometry.worker.ts`: structured-clone-safe automatic request/result and cancellation.
- Create `src/export/outline-package.ts`: shared-contour SVG/DXF/PDF/JSON/ZIP packaging.
- Create `src/export/outline-package.test.ts`: cross-format provenance and geometry reconciliation.
- Create `src/app/OneClickConverter.tsx`: upload/processing/result state machine.
- Create `src/app/OneClickConverter.test.tsx`: accessible UI behavior and cancellation tests.
- Modify `src/app/App.tsx`, `src/styles.css`: render and style the approved one-click UI.
- Modify `e2e/helpers.ts`, `e2e/happy-path.spec.ts`, `e2e/mesh-repair.spec.ts`, `e2e/performance.spec.ts`: one-click real-browser acceptance.
- Modify `README.md`, `docs/materials/safety.md`: explain universal outline output and limits.

### Task 1: Define outline types, axis selection, and deterministic layer scheduling

**Files:**
- Create: `src/domain/outline-2.5d/types.ts`
- Create: `src/domain/outline-2.5d/axis.ts`
- Create: `src/domain/outline-2.5d/layer-schedule.ts`
- Create: `src/domain/outline-2.5d/axis.test.ts`
- Create: `src/domain/outline-2.5d/layer-schedule.test.ts`

**Interfaces:**
- Consumes: `TriangleMesh`, `AxisCandidate`, `Axis`, `Polygon2` from existing domain modules.
- Produces: `OutlineAxisSelection`, `OutlineLayerSpec`, `OutlineBudgets`, `selectOutlineAxis(mesh, candidates)`, and `scheduleOutlineLayers(mesh, axis, budgets)`.

- [ ] **Step 1: Write failing axis and schedule tests**

Test the exact interfaces below. Require a candidate with confidence `>= 0.8` to win after direction normalization; otherwise require the shortest finite non-zero bounds axis with confidence `0`, `confirmed: true`, and `source: 'shortest-bounds'`. Require `6 <= layerCount <= 24`, contiguous Z ranges, preserved min/max axial extent, and deterministic output under triangle-order reversal.

```ts
const selection = selectOutlineAxis(mesh, [{
  origin: [0, 0, 0], direction: [0, 0, 4], confidence: 0.9, confirmed: false,
  radialRmsError: 0.01, centroidOffset: 0.01, source: 'inertia',
}]);
expect(selection).toMatchObject({ source: 'candidate', axis: { direction: [0, 0, 1], confirmed: true } });
const layers = scheduleOutlineLayers(mesh, selection.axis, DEFAULT_OUTLINE_BUDGETS);
expect(layers[0].zStart).toBeCloseTo(-2);
expect(layers.at(-1)?.zEnd).toBeCloseTo(2);
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npx vitest run src/domain/outline-2.5d/axis.test.ts src/domain/outline-2.5d/layer-schedule.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement exact public types and limits**

```ts
export type OutlineMode = 'exact' | 'outline-2.5d';
export type OutlineResultStatus = 'success' | 'warning' | 'failure';
export type OutlineAxisSelection = { readonly axis: Axis; readonly source: 'candidate' | 'shortest-bounds' };
export type OutlineLayerSpec = { readonly index: number; readonly zStart: number; readonly zEnd: number; readonly zMid: number };
export type OutlineBudgets = {
  readonly minLayers: 6; readonly maxLayers: 24;
  readonly maxRasterWidth: 1024; readonly maxRasterHeight: 1024;
  readonly maxRasterCellsTotal: 16_777_216; readonly maxTriangleLayerTests: 12_000_000;
  readonly maxContourPointsPerLayer: 4096; readonly maxRuntimeMs: 30_000;
};
export const DEFAULT_OUTLINE_BUDGETS: OutlineBudgets = Object.freeze({
  minLayers: 6, maxLayers: 24, maxRasterWidth: 1024, maxRasterHeight: 1024,
  maxRasterCellsTotal: 16_777_216, maxTriangleLayerTests: 12_000_000,
  maxContourPointsPerLayer: 4096, maxRuntimeMs: 30_000,
});
```

Layer count is `clamp(Math.ceil(12 * axialHeight / Math.max(planarDiameter, axialHeight)), 6, 24)`. Reject empty/non-finite/zero-volume bounds and any schedule whose triangle-layer test count exceeds the budget.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run src/domain/outline-2.5d/axis.test.ts src/domain/outline-2.5d/layer-schedule.test.ts && npm run typecheck`

Expected: both files pass; TypeScript reports no diagnostics.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/domain/outline-2.5d
git commit -m "feat: define deterministic outline layers"
```

### Task 2: Extract and validate largest 2.5D contours

**Files:**
- Create: `src/domain/outline-2.5d/raster.ts`
- Create: `src/domain/outline-2.5d/simplify.ts`
- Create: `src/domain/outline-2.5d/validate.ts`
- Create: `src/domain/outline-2.5d/extract.ts`
- Create: `src/domain/outline-2.5d/extract.test.ts`
- Create: `src/domain/outline-2.5d/validate.test.ts`

**Interfaces:**
- Consumes: Task 1 `OutlineAxisSelection`, `OutlineLayerSpec`, `OutlineBudgets`.
- Produces: `OutlineLayer`, `OutlineExtraction`, `extractExactContours`, `extractProjectedContours`, `validateOutlineLayer`.

- [ ] **Step 1: Write failing broken-mesh and largest-component tests**

Create synthetic open, self-intersecting, overlapping, and two-component meshes. Require projected output to keep only the larger component, contain no holes, remain deterministic after triangle shuffling, and reject NaN, empty masks, bow-tie contours, >4096 points, or >3% area/bounds drift.

```ts
const result = extractProjectedContours(twoComponentBrokenMesh(), axis, specs, DEFAULT_OUTLINE_BUDGETS);
expect(result.layers.every((layer) => layer.contour.holes.length === 0)).toBe(true);
expect(result.layers.every((layer) => validateOutlineLayer(layer).ok)).toBe(true);
expect(maxX(result.layers[0].contour.outer)).toBeLessThan(30); // smaller remote component removed
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npx vitest run src/domain/outline-2.5d/extract.test.ts src/domain/outline-2.5d/validate.test.ts`

Expected: FAIL because extraction modules do not exist.

- [ ] **Step 3: Implement bounded raster projection**

Transform vertices into orthonormal axis coordinates. For each layer, project triangles whose axial interval overlaps `[zStart,zEnd]`; rasterize their filled 2D triangles into a bit mask with cell size `clamp(planarDiameter / 512, 0.05, 0.5)` mm and one-cell padding. Perform one 3×3 morphological close, flood-fill exterior zeros so holes become occupied, label 4-connected occupied components, and retain only the greatest area (tie-break by lowest minimum X then Y). Trace its outer boundary clockwise using integer cell edges.

- [ ] **Step 4: Implement exact contours and simplification**

For safe meshes, intersect triangles with `zMid`, join quantized segments, select the greatest closed loop, and reject open segment graphs. Simplify both exact and projected loops with closed-loop RDP tolerance `max(cellSize * 1.5, planarDiameter * 0.001)`, never exceeding 4096 points. Validate simplified area and X/Y bounds differ by no more than 3% from the unsimplified contour.

- [ ] **Step 5: Implement fail-closed validation**

```ts
export type OutlineLayer = {
  readonly id: string; readonly index: number;
  readonly zStart: number; readonly zEnd: number;
  readonly contour: { readonly outer: readonly Point2[]; readonly holes: readonly [] };
  readonly sourceAreaMm2: number; readonly simplifiedAreaMm2: number;
};
export type OutlineExtraction = {
  readonly layers: readonly OutlineLayer[];
  readonly cellSizeMm?: number;
  readonly removedComponentCount: number;
};
export function validateOutlineLayer(layer: OutlineLayer): { readonly ok: boolean; readonly reasons: readonly string[] };
```

Use existing polygon segment-intersection predicates where possible. Reject non-finite coordinates, fewer than three unique points, zero-length edges, duplicate adjacent points, non-positive area, self-intersection, invalid Z order, excessive point count, or >3% drift.

- [ ] **Step 6: Run focused/full domain tests**

Run: `npx vitest run src/domain/outline-2.5d/*.test.ts src/domain/decomposition/generate-parts.test.ts`

Expected: all selected tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/domain/outline-2.5d
git commit -m "feat: extract safe 2.5d exterior contours"
```

### Task 3: Build the automatic worker pipeline and real cancellation

**Files:**
- Create: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Create: `src/domain/pipeline/automatic-outline-pipeline.test.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry-api.test.ts`
- Modify: `src/workers/geometry-client.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `src/workers/geometry-worker.browser.test.ts`

**Interfaces:**
- Consumes: Task 2 extraction APIs, existing parse/problem/safe-repair/axis APIs.
- Produces: `AutomaticOutlineRequest`, `AutomaticOutlineResult`, `GeometryApi.convertAutomatically`, `GeometryClient.convertAutomatically`.

- [ ] **Step 1: Write failing exact/fallback/cancellation tests**

Require a safe symmetric mesh to return `mode: 'exact', status: 'success'`; require open/non-manifold/self-intersecting meshes to return `mode: 'outline-2.5d', status: 'warning'`; require fallback axis warnings; require an empty projection to fail closed. In the browser worker test, start a large conversion, immediately start a second request, and assert the first rejects with `SupersededError` while a newly created worker completes the second.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/domain/pipeline/automatic-outline-pipeline.test.ts src/workers/geometry-api.test.ts && npm run test:browser -- src/workers/geometry-worker.browser.test.ts`

Expected: FAIL because `convertAutomatically` is missing.

- [ ] **Step 3: Implement the automatic decision contract**

```ts
export type AutomaticOutlineProgressStage = 'reading' | 'analyzing' | 'simplifying' | 'slicing' | 'packaging';
export type AutomaticOutlineResult = {
  readonly sourceHash: string;
  readonly mode: OutlineMode;
  readonly status: OutlineResultStatus;
  readonly axis: OutlineAxisSelection;
  readonly layers: readonly OutlineLayer[];
  readonly warnings: readonly string[];
  readonly originalReport: MeshProblemReport;
  readonly repairAccepted: boolean;
};
export type AutomaticOutlineRequest = { readonly bytes: ArrayBuffer };
export type AutomaticOutlineProgress = (stage: AutomaticOutlineProgressStage) => void;
```

Parse and analyze once. Run safe repair. If accepted, select a candidate axis and try exact extraction; if exact closed-loop extraction fails, fall back to projection with a warning. If safe repair is blocked, immediately use projected extraction on the original finite triangles. Any projected success returns `warning` and includes `已簡化模型`; any invalid/empty/budget/time result throws a typed `AutomaticOutlineError` with `code: 'INVALID_STL' | 'NO_OUTLINE' | 'RESOURCE_LIMIT' | 'TIME_LIMIT'`.

- [ ] **Step 4: Wire structured clone and worker restart**

Add `convertAutomatically(request, onProgress?)` to `GeometryApi`, `dynamicApi`, worker implementation, and client. The worker emits only monotonic stages and the browser client passes `Comlink.proxy(onProgress)` across the boundary. Transfer input bytes and returned typed arrays only where ownership is unambiguous. Reuse existing `cancelActive()` termination/recreation path; do not add cooperative cancellation that leaves CPU work running.

- [ ] **Step 5: Run focused unit/browser tests and typecheck**

Run: `npx vitest run src/domain/pipeline/automatic-outline-pipeline.test.ts src/workers/geometry-api.test.ts && npm run test:browser -- src/workers/geometry-worker.browser.test.ts && npm run typecheck`

Expected: exact/fallback/error tests pass; the real Chromium cancellation test proves worker replacement; typecheck passes.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/domain/pipeline/automatic-outline-pipeline.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/workers
git commit -m "feat: automate exact and 2.5d conversion"
```

### Task 4: Create material-independent documents and reconciled exports

**Files:**
- Create: `src/export/outline-package.ts`
- Create: `src/export/outline-package.test.ts`
- Modify: `src/export/layers.ts`
- Modify: `src/export/package.ts`
- Modify: `src/export/project-json.ts`

**Interfaces:**
- Consumes: `AutomaticOutlineResult`, existing `ManufacturingDocument`, SVG/DXF/PDF/ZIP exporters.
- Produces: `createOutlineDocument(result)`, `createOutlinePackage(result)`, `OutlineManifestV1`.

- [ ] **Step 1: Write failing cross-format reconciliation tests**

Use three distinct rectangular/curved layers. Require identical source fingerprint, layer IDs, order, contour point counts, and bounds in JSON, SVG, DXF, PDF metadata, and ZIP entries. Assert no slot/hole/engrave entity and no `power`, `speed`, `passes`, absolute path, or email exists. Mutate one exported contour and require package verification to reject it.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/export/outline-package.test.ts`

Expected: FAIL because the outline package module does not exist.

- [ ] **Step 3: Implement tight automatic layout and provenance**

Map each outline layer to one `CUT` part with quantity one, no holes, no joints, and assembly order by increasing Z. Use 5 mm spacing and a deterministic shelf layout with canvas width `min(1000, max(300, ceil(maxPartWidth + 10)))`; add sheets as required and keep 5 mm margins. Reject any part wider/taller than 990 mm instead of rescaling.

```ts
export type OutlineManifestV1 = {
  readonly schemaVersion: 1;
  readonly mode: OutlineMode;
  readonly sourceHash: string;
  readonly status: OutlineResultStatus;
  readonly warnings: readonly string[];
  readonly layers: readonly { id: string; order: number; zStart: number; zEnd: number; boundsMm: readonly [number, number] }[];
  readonly materialIndependent: true;
};
```

- [ ] **Step 4: Build and verify every output from the shared document**

Reuse the current exporters, adding optional outline metadata without duplicating contour construction. ZIP contains `cut.svg`, `cut.dxf`, `preview.pdf`, `project.json`, and `manifest.json`. Validate package contents immediately before returning bytes; any mismatch throws and prevents download.

- [ ] **Step 5: Run export/full tests**

Run: `npx vitest run src/export/outline-package.test.ts src/export/export.test.ts src/export/real-fixtures.integration.test.ts && npm run typecheck`

Expected: all export tests and typecheck pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/export
git commit -m "feat: export universal outline packages"
```

### Task 5: Replace the wizard with the approved one-click UI

**Files:**
- Create: `src/app/OneClickConverter.tsx`
- Create: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/app/App.browser.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `GeometryClient.convertAutomatically`, `createOutlinePackage` result/download callback.
- Produces: three-state accessible UI (`upload`, `processing`, `result`) and `OneClickConverterServices`.

- [ ] **Step 1: Write failing accessible state-machine tests**

Test one file selection immediately begins conversion; no buttons named repair/axis/next/material/decomposition exist; processing announces stages through `role="status"`; a second file cancels the first; success/warning/failure uses `role="status"` or `role="alert"`; warning shows `已簡化模型`; ZIP is primary and SVG/DXF/PDF/JSON are secondary downloads; retry returns to upload.

- [ ] **Step 2: Run UI tests to verify RED**

Run: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx`

Expected: FAIL because `OneClickConverter` does not exist and App still renders the wizard.

- [ ] **Step 3: Implement the one-click state and services**

```ts
export type OneClickViewState =
  | { readonly kind: 'upload' }
  | { readonly kind: 'processing'; readonly fileName: string; readonly stage: AutomaticOutlineProgressStage }
  | { readonly kind: 'result'; readonly fileName: string; readonly result: AutomaticOutlineResult; readonly downloads: OutlineDownloads }
  | { readonly kind: 'failure'; readonly fileName?: string; readonly message: string };
export type OneClickConverterServices = {
  readonly convert: (bytes: ArrayBuffer) => Promise<AutomaticOutlineResult>;
  readonly package: (result: AutomaticOutlineResult) => Promise<OutlineDownloads>;
  readonly cancel: () => void;
};
```

Reading the selected file calls `cancel()` first, then starts one conversion. Ignore `SupersededError` from an old request. Map typed domain errors to plain Traditional Chinese messages. Revoke object URLs on new result and unmount.

- [ ] **Step 4: Implement approved mint/white responsive UI**

Use CSS custom properties for mint, white, high-contrast text, 16–22 px radii, minimum 44 px controls, a large dashed upload zone, one progress bar/checklist, and a result card. At `max-width: 640px`, use one column and full-width controls. Preserve visible focus, reduced-motion behavior, keyboard file selection, and screen-reader labels.

- [ ] **Step 5: Run unit and real Chromium UI tests**

Run: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx && npm run test:browser -- src/app/App.browser.test.tsx`

Expected: UI tests pass in jsdom and Chromium; no database-close stderr is introduced because the new main flow does not require project/material repositories.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/app src/styles.css
git commit -m "feat: launch one-click ShapeCut interface"
```

### Task 6: Validate real fixtures, performance, privacy, and documentation

**Files:**
- Modify: `e2e/helpers.ts`
- Modify: `e2e/happy-path.spec.ts`
- Modify: `e2e/mesh-repair.spec.ts`
- Modify: `e2e/performance.spec.ts`
- Create: `e2e/one-click-outline.spec.ts`
- Modify: `README.md`
- Modify: `docs/materials/safety.md`

**Interfaces:**
- Consumes: completed UI, worker pipeline, exports, and the two external user fixtures through environment variables.
- Produces: release-level evidence and user documentation.

- [ ] **Step 1: Rewrite E2E expectations around one-click behavior**

For `fixtures/acceptance/symmetric-smooth.stl`, assert one selection reaches `success`, mode `exact`, and downloads a reconciled ZIP without repair/material clicks. For invalid empty/open inputs, assert plain-language failure or fallback as specified. Retain reload/privacy and 100k/500k resource tests where still applicable.

- [ ] **Step 2: Add opt-in real Knight acceptance tests**

Use environment variables `KNIGHT_FORTRESS_STL` and `KNIGHT_FORTRESS_GROUP_STL`; skip only when the corresponding external file is absent. For both files, set the input once and assert `warning`, `已簡化模型`, `outline-2.5d`, downloadable ZIP, finite closed layers, and no repair/axis/material interaction. For Group, compare layer metadata to prove `removedComponentCount > 0` and exactly one contour per non-empty layer.

- [ ] **Step 3: Run real E2E with both local files**

Run:

```bash
KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" \
KNIGHT_FORTRESS_GROUP_STL="$PWD/Copy of Beyblade X Knight Fortress Group.stl" \
npx playwright test e2e/one-click-outline.spec.ts e2e/happy-path.spec.ts e2e/performance.spec.ts --workers=1
```

Expected: no skip; both Knight files reach warning/download, safe fixture reaches exact success, and performance/resource tests pass.

- [ ] **Step 4: Update documentation truthfully**

README quick start describes one upload and the three result states. Safety documentation states that 2.5D is an approximate outer-profile workflow, holes/internal/disconnected details are removed, material thickness changes final stack height, and machine power/speed must be set externally after test cuts.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```bash
npm test -- --run
npm run test:browser
KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" KNIGHT_FORTRESS_GROUP_STL="$PWD/Copy of Beyblade X Knight Fortress Group.stl" npm run test:e2e -- --workers=1
npm run validate:fixtures
npm run test:performance
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: every suite passes; both user STL files remain untracked; no generated package or absolute local path is committed.

- [ ] **Step 6: Commit Task 6**

```bash
git add e2e README.md docs/materials/safety.md
git commit -m "test: validate one-click outline workflow"
```
