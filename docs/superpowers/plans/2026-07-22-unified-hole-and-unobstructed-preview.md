# Unified Central Hole and Unobstructed Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every safe output layer one identical central axle-hole contour and keep the real rotating model visible behind a compact processing status overlay without camera buttons.

**Architecture:** Add a bounded global reconciliation function beside the existing single-layer hole selector, then change both contour extractors to collect evidence first and derive depth features only after one shared hole decision. Keep the current preview payload and Three.js scene contracts; simplify only the React controls and processing-card layout so progress becomes a small upper-left overlay.

**Tech Stack:** TypeScript 5.9, React 19, Three.js 0.179, Vitest, Testing Library, Playwright, Vite.

## Global Constraints

- Use the same central-hole contour, size, and position on every layer.
- Select the largest reliable candidate that passes existing containment and clearance checks for every layer.
- If no candidate safely fits every layer, omit the hole from every layer and emit `CENTRAL_HOLE_OMISSION_WARNING`.
- Do not fabricate a model before STL parsing produces preview geometry.
- Once geometry exists, retain the real rotating wireframe throughout analysis, slicing, and packaging.
- Use a compact upper-left processing overlay and remove zoom, rotate, and reset buttons from processing and result views.
- Preserve the completed-result layer selector.
- SVG, DXF, preview PDF, exploded-view PDF, and the four-file ZIP must share the same hole decision.
- Preserve the user's untracked STL files, `shapecut-outline.zip`, and `shapecut-outline/` directory.

---

### Task 1: Select One Safe Hole for All Layers

**Files:**
- Modify: `src/domain/outline-features/hole.ts`
- Modify: `src/domain/outline-features/hole.test.ts`

**Interfaces:**
- Consumes: existing `CentralHoleRequest`, `CentralHoleSelection`, `selectCentralHole()`, `isStrictlyContainedLoop()` and the request deadline.
- Produces: `selectSharedCentralHole(requests: readonly CentralHoleRequest[]): readonly CentralHoleSelection[]`.

- [ ] **Step 1: Write failing tests for the shared selection contract**

Add tests which construct two rectangular exteriors and two centered candidate loops, then assert exact propagation, fallback to the largest candidate safe for both exteriors, and all-layer omission:

```ts
import {
  CENTRAL_HOLE_OMISSION_WARNING,
  selectCentralHole,
  selectSharedCentralHole,
  type CentralHoleCandidate,
  type CentralHoleRequest,
} from './hole';

const request = (
  exterior: readonly [number, number][],
  candidates: readonly CentralHoleCandidate[],
): CentralHoleRequest => ({
  exterior,
  candidates,
  axisPoint: [0, 0],
  layerWidthMm: 20,
  planarDiameterMm: 20,
  cellSizeMm: 0.1,
});

it('copies the exact largest globally safe contour to every layer', () => {
  const outer = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
  const large = { outer: [[-3, -3], [3, -3], [3, 3], [-3, 3]] as const };
  const small = { outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const };
  const result = selectSharedCentralHole([
    request(outer, [small, large]),
    request(outer, [large]),
  ]);
  expect(result).toHaveLength(2);
  expect(result[0].hole?.outer).toEqual(large.outer);
  expect(result[1]).toEqual(result[0]);
});

it('rejects a larger candidate that cannot fit every layer', () => {
  const wide = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
  const narrow = [[-2, -2], [2, -2], [2, 2], [-2, 2]] as const;
  const large = { outer: [[-3, -3], [3, -3], [3, 3], [-3, 3]] as const };
  const common = { outer: [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const };
  const result = selectSharedCentralHole([
    request(wide, [large, common]),
    request(narrow, [common]),
  ]);
  expect(result.every((selection) => selection.hole?.outer === result[0].hole?.outer)).toBe(true);
  expect(result[0].hole?.outer).toEqual(common.outer);
});

it('omits the central cut from every layer when no shared candidate is safe', () => {
  const wide = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const;
  const narrow = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  const candidate = { outer: [[-2, -2], [2, -2], [2, 2], [-2, 2]] as const };
  expect(selectSharedCentralHole([
    request(wide, [candidate]),
    request(narrow, []),
  ])).toEqual([
    { hole: undefined, omissionReason: 'NO_RELIABLE_CENTRAL_HOLE', warning: CENTRAL_HOLE_OMISSION_WARNING },
    { hole: undefined, omissionReason: 'NO_RELIABLE_CENTRAL_HOLE', warning: CENTRAL_HOLE_OMISSION_WARNING },
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify the missing export fails**

Run: `npx vitest run src/domain/outline-features/hole.test.ts`

Expected: FAIL because `selectSharedCentralHole` is not exported.

- [ ] **Step 3: Implement bounded global candidate reconciliation**

Refactor candidate qualification into a private helper reused by `selectCentralHole()`. Implement `selectSharedCentralHole()` so it validates `1..24` requests, qualifies the union of at most `64 * 24` source candidates under the shared deadline, sorts deterministically by descending area and existing minimum-point tie-breakers, tests each qualified contour with every request's `isStrictlyContainedLoop()` clearance, then returns one frozen-equivalent selection repeated for every request. Use each target request's existing clearance formula:

```ts
function minimumClearance(request: CentralHoleRequest): number {
  const planarDiameterMm = request.planarDiameterMm ?? request.layerWidthMm;
  return Math.max(request.cellSizeMm, planarDiameterMm * 0.001);
}

export function selectSharedCentralHole(
  requests: readonly CentralHoleRequest[],
): readonly CentralHoleSelection[] {
  if (requests.length === 0 || requests.length > 24) {
    throw new RangeError('Shared central hole selection requires between one and twenty-four layers');
  }
  const deadline = Math.min(...requests.map((request) => request.deadline ?? Infinity));
  const candidates = requests.flatMap((request) => qualifyCandidates(request, deadline));
  candidates.sort(compareQualifiedCandidates);
  const shared = candidates.find((candidate) => requests.every((request) =>
    isStrictlyContainedLoop(
      request.exterior,
      candidate.outer,
      minimumClearance(request),
      deadline,
    )));
  const selection: CentralHoleSelection = shared
    ? { hole: withoutPrivateSortEvidence(shared) }
    : omission();
  return requests.map(() => selection);
}
```

Deduplicate contours before all-layer checks with a deterministic coordinate key so identical layer candidates do not multiply worst-case work. Keep `selectCentralHole()` behavior and public types backward-compatible.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run src/domain/outline-features/hole.test.ts`

Expected: PASS, including the existing single-layer selector tests and the three new global tests.

- [ ] **Step 5: Commit the global selector**

```bash
git add src/domain/outline-features/hole.ts src/domain/outline-features/hole.test.ts
git commit -m "feat: select one safe central hole for all layers"
```

---

### Task 2: Reconcile Extraction Before Depth Features and Exports

**Files:**
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/outline-2.5d/extract.test.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.test.ts`

**Interfaces:**
- Consumes: `selectSharedCentralHole(requests)` from Task 1 and existing `extractAdaptiveDepthFeatures()`.
- Produces: `OutlineExtraction.holeSelections` containing either the same retained hole for every layer or omissions for every layer; downstream `colorizeExteriorLayers()` remains unchanged.

- [ ] **Step 1: Add failing extraction tests for all-layer equality and omission**

Use `setHoleCandidateProbeForTesting()` to retain the existing bounded evidence assertions, and extend the exact/projected fixtures so tests assert:

```ts
const retained = result.holeSelections
  .map((selection) => selection.hole?.outer)
  .filter((outer): outer is NonNullable<typeof outer> => outer !== undefined);
expect(retained).toHaveLength(result.layers.length);
for (const contour of retained.slice(1)) expect(contour).toEqual(retained[0]);
expect(result.featureWarnings).not.toContain(CENTRAL_HOLE_OMISSION_WARNING);
```

Add a narrowing-layer fixture whose largest local candidate is unsafe globally but a smaller candidate is safe, and an incompatible fixture which asserts:

```ts
expect(result.holeSelections).toHaveLength(result.layers.length);
expect(result.holeSelections.every(({ hole }) => hole === undefined)).toBe(true);
expect(result.featureWarnings).toContain(CENTRAL_HOLE_OMISSION_WARNING);
```

- [ ] **Step 2: Run extraction and pipeline tests to observe local-hole behavior fail**

Run: `npx vitest run src/domain/outline-2.5d/extract.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts`

Expected: FAIL because current extraction selects and consumes holes independently inside each layer loop.

- [ ] **Step 3: Convert both extractors to a two-pass flow**

In `extractProjectedContours()` and `extractExactContours()`:

1. Build `layers` and an ordered `CentralHoleRequest[]` during the geometry loop.
2. Call `selectSharedCentralHole(holeRequests)` once after every exterior exists.
3. Build `depthFeatures` in a second ordered pass using `holeSelections[index].hole?.outer`.
4. Add `CENTRAL_HOLE_OMISSION_WARNING` only when the shared decision is omission.

The projected form should follow this concrete structure:

```ts
const layers: OutlineLayer[] = [];
const holeRequests: CentralHoleRequest[] = [];
for (let index = 0; index < specs.length; index += 1) {
  // Existing raster projection and makeLayer calls stay here.
  layers.push(layer);
  holeRequests.push(holeRequest);
}
const holeSelections = selectSharedCentralHole(holeRequests);
const depthFeatures = layers.map((layer, index) => extractAdaptiveDepthFeatures(projected, {
  layerId: layer.id,
  layer: specs[index],
  exterior: layer.contour.outer,
  centralHole: holeSelections[index].hole?.outer,
  exteriorAreaMm2: layer.simplifiedAreaMm2,
  cellSizeMm,
  planarDiameterMm: projected.planarDiameter,
  budgets,
  totalLayerCount: specs.length,
  deadline,
}));
```

Import the exact `CentralHoleRequest` type and `selectSharedCentralHole`; preserve probe calls, deadlines, candidate caps, layer order, and component counts.

- [ ] **Step 4: Prove preview and export inputs carry the same decision**

Extend the pipeline retained-hole test:

```ts
const holes = result.coloredLayers.map((layer) => layer.centralHole?.outer);
expect(holes.every((hole) => hole !== undefined)).toBe(true);
for (const hole of holes.slice(1)) expect(hole).toEqual(holes[0]);
expect(result.preview.layers).toEqual(result.coloredLayers);
```

Run: `npx vitest run src/domain/outline-2.5d/extract.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/export/colored-outline-document.test.ts src/export/exploded-pdf.test.ts src/export/outline-package.test.ts`

Expected: PASS; existing export tests demonstrate that every artifact is rendered from the reconciled `coloredLayers` document.

- [ ] **Step 5: Commit extraction integration**

```bash
git add src/domain/outline-2.5d/extract.ts src/domain/outline-2.5d/extract.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts
git commit -m "feat: propagate shared axle hole through extraction"
```

---

### Task 3: Remove Camera Controls Without Removing Automatic Rotation

**Files:**
- Modify: `src/preview/OutlineProcessViewport.tsx`
- Modify: `src/preview/OutlineProcessViewport.test.tsx`
- Modify: `src/preview/OutlineProcessViewport.browser.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: the existing `OutlineProcessScene` automatic rotation, stage transition, payload update, and highlight APIs.
- Produces: a control-free viewport which retains `select[aria-label="選擇預覽切片"]` only at result stage.

- [ ] **Step 1: Replace interaction expectations with failing absence tests**

Remove tests dedicated to click/keyboard zoom, rotate, reset, and pointer drag. Add assertions in both jsdom and Chromium suites:

```tsx
render(<OutlineProcessViewport payload={payload('', 3)} stage="result" reducedMotion createScene={() => scene} />);
expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
expect(screen.queryByRole('button', { name: /旋轉|縮小|放大|重設/ })).not.toBeInTheDocument();
expect(screen.getByRole('combobox', { name: '選擇預覽切片' })).toBeInTheDocument();
```

Keep tests for scene creation, automatic stage changes, reduced motion, WebGL fallback, payload replacement, disposal, and result-layer highlighting.

- [ ] **Step 2: Run viewport tests and verify controls are still present**

Run: `npx vitest run src/preview/OutlineProcessViewport.test.tsx`

Expected: FAIL because `.outline-process-controls` and its buttons still render.

- [ ] **Step 3: Remove manual camera UI and handlers**

In `OutlineProcessViewport.tsx`, remove the `KeyboardEvent` and `PointerEvent` imports, `dragRef`, `rotate`, `zoom`, `reset`, pointer handlers, keyboard handler, focus `tabIndex`, and the complete `outline-process-controls` block. Keep the WebGL host role, accessible description, scene lifecycle, automatic scene animation, and result selector.

Delete `.outline-process-controls` rules and their mobile override from `src/styles.css`. Do not change `outline-process-scene.ts`; automatic horizontal rotation and auto-framing remain scene responsibilities.

- [ ] **Step 4: Run unit and real-browser viewport tests**

Run: `npx vitest run src/preview/OutlineProcessViewport.test.tsx`

Expected: PASS.

Run: `npm run test:browser -- src/preview/OutlineProcessViewport.browser.test.tsx`

Expected: PASS with no camera controls in WebGL or fallback rendering and with the result layer selector still working.

- [ ] **Step 5: Commit the simplified viewport**

```bash
git add src/preview/OutlineProcessViewport.tsx src/preview/OutlineProcessViewport.test.tsx src/preview/OutlineProcessViewport.browser.test.tsx src/styles.css
git commit -m "feat: simplify rotating model preview controls"
```

---

### Task 4: Expose the Real Model Behind a Compact Upper-Left Status Overlay

**Files:**
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/App.browser.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: existing processing state `{ stage, preview? }`; the first preview remains emitted only after valid parsed geometry exists.
- Produces: `.processing-status-overlay` when a preview exists and `.processing-loading-panel` during pre-geometry reading.

- [ ] **Step 1: Add failing component assertions for both loading phases**

Extend the existing `stays neutral until parsed preview data arrives` test:

```ts
await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'preview.stl'));
expect(document.querySelector('.processing-card')).not.toHaveClass('has-preview');
expect(document.querySelector('.processing-loading-panel')).toBeInTheDocument();
expect(document.querySelector('.processing-status-overlay')).not.toBeInTheDocument();

report?.({ stage: 'analyzing', preview: result.preview });
expect(await screen.findByRole('img', { name: /模型分層預覽/ })).toBeInTheDocument();
expect(document.querySelector('.processing-card')).toHaveClass('has-preview');
expect(document.querySelector('.processing-status-overlay')).toBeInTheDocument();
expect(document.querySelector('.processing-loading-panel')).not.toBeInTheDocument();
```

Add a browser assertion that the overlay is in the upper-left quadrant and covers less than 35% of viewport area:

```ts
const card = page.locator('.processing-card.has-preview');
const overlay = page.locator('.processing-status-overlay');
const [cardBox, overlayBox] = await Promise.all([card.boundingBox(), overlay.boundingBox()]);
expect(cardBox && overlayBox).toBeTruthy();
expect(overlayBox!.x).toBeLessThan(cardBox!.x + cardBox!.width / 2);
expect(overlayBox!.y).toBeLessThan(cardBox!.y + cardBox!.height / 2);
expect(overlayBox!.width * overlayBox!.height).toBeLessThan(cardBox!.width * cardBox!.height * 0.35);
```

- [ ] **Step 2: Run focused component tests and observe the missing layout hooks**

Run: `npx vitest run src/app/OneClickConverter.test.tsx`

Expected: FAIL because the current large `.processing-foreground` is used in both phases.

- [ ] **Step 3: Split pre-geometry loading from preview progress markup**

In the processing branch, retain the neutral loader before `view.preview` exists. Render concise progress in an upper-left overlay only after preview exists:

```tsx
{view.preview ? (
  <>
    <div className="processing-viewport">
      <OutlineProcessViewport payload={view.preview} stage={view.stage} />
    </div>
    <div className="processing-status-overlay">
      <strong id="processing-title">{STAGE_LABELS[view.stage]}</strong>
      <span className="file-name">{view.fileName}</span>
      <progress value={active + 1} max={STAGES.length} aria-label="轉換進度" />
    </div>
  </>
) : (
  <div className="processing-loading-panel">
    <div className="neutral-loading" aria-hidden="true"><span /><span /><span /></div>
    <h1 id="processing-title">正在讀取模型</h1>
    <p className="file-name">{view.fileName}</p>
  </div>
)}
```

Keep one `aria-labelledby="processing-title"` target per branch and keep the compact file-change input above the viewport stacking layer.

- [ ] **Step 4: Apply the approved unobstructed layout**

Replace `.processing-foreground` with:

```css
.processing-status-overlay {
  position: absolute;
  top: 18px;
  left: 18px;
  z-index: 2;
  display: grid;
  width: min(320px, calc(100% - 36px));
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid rgba(34, 167, 125, .22);
  border-radius: 14px;
  background: rgba(255, 255, 255, .88);
  box-shadow: 0 8px 24px rgba(22, 89, 73, .12);
  backdrop-filter: blur(6px);
  text-align: left;
  pointer-events: none;
}
.processing-loading-panel {
  position: relative;
  z-index: 1;
  margin: auto;
  text-align: center;
}
```

Add a mobile override with `top: 10px`, `left: 10px`, `width: calc(100% - 20px)`, and compact padding. Remove `.processing-foreground` rules. Ensure `.processing-card.has-preview` keeps enough height for the model and `.change-file-button` remains reachable.

- [ ] **Step 5: Run component and browser coverage**

Run: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx`

Expected: PASS.

Run: `npm run test:browser -- src/app/App.browser.test.tsx src/preview/OutlineProcessViewport.browser.test.tsx`

Expected: PASS; the parsed model is visible, the status overlay remains compact, and no model is fabricated before preview emission.

- [ ] **Step 6: Commit the processing layout**

```bash
git add src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx src/app/App.browser.test.tsx src/styles.css
git commit -m "feat: keep processing model unobstructed"
```

---

### Task 5: Verify Supplied Models and the Complete Release Surface

**Files:**
- Modify: `e2e/one-click-outline.spec.ts`
- Modify: `e2e/helpers.ts`
- Modify: `src/test/e2e-helpers.test.ts`

**Interfaces:**
- Consumes: packaged artifacts from the automatic one-click pipeline and environment variables `KNIGHT_FORTRESS_STL` and `KNIGHT_FORTRESS_GROUP_STL`.
- Produces: regression evidence that retained holes are identical across layers and all five downloadable outputs agree.

- [ ] **Step 1: Strengthen artifact inspection with shared-hole equality**

In the parsed colored-artifact helper, add a bounded canonical point-string helper and assert that retained central-hole geometry has one common signature:

```ts
const contourSignature = (points: readonly (readonly [number, number])[]): string =>
  points.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(';');

const retainedHoleSignatures = parsed.layers
  .filter((layer) => layer.hole.status === 'retained')
  .map((layer) => contourSignature(layer.hole.points));
expect(new Set(retainedHoleSignatures).size).toBeLessThanOrEqual(1);
expect(retainedHoleSignatures.length === 0 || retainedHoleSignatures.length === parsed.layers.length).toBe(true);
```

Add a unit fixture with six identical retained holes and another with one shifted hole; expect the first to pass and the second to reject with `/central hole.*identical|shared/i`.

- [ ] **Step 2: Run helper tests and verify mismatched holes are not yet rejected**

Run: `npx vitest run src/test/e2e-helpers.test.ts`

Expected: FAIL on the shifted-hole fixture.

- [ ] **Step 3: Apply the helper assertion to real-model E2E cases**

Keep both supplied-model cases in `e2e/one-click-outline.spec.ts`. After downloading ZIP, SVG, DXF, preview PDF, and exploded-view PDF, call the strengthened artifact inspector and assert the ZIP entries remain exactly:

```ts
expect(Object.keys(zip.files).sort()).toEqual([
  'cut-and-engrave.dxf',
  'cut-and-engrave.svg',
  'exploded-view.pdf',
  'preview.pdf',
]);
```

Do not add the supplied STL files to Git; tests receive their absolute paths through environment variables.

- [ ] **Step 4: Run both Knight Fortress regressions**

Run:

```bash
KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" \
KNIGHT_FORTRESS_GROUP_STL="$PWD/Copy of Beyblade X Knight Fortress Group.stl" \
npm run test:e2e -- e2e/one-click-outline.spec.ts --workers=1
```

Expected: PASS for both labelled Knight Fortress cases with either an identical retained hole on every layer or a warned all-layer omission.

- [ ] **Step 5: Run the complete verification matrix**

Run: `npm test`

Expected: all unit tests PASS.

Run: `npm run test:browser`

Expected: all browser tests PASS.

Run: `npm run typecheck && npm run build`

Expected: TypeScript exits 0 and Vite produces `dist/` successfully.

Run:

```bash
KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" \
KNIGHT_FORTRESS_GROUP_STL="$PWD/Copy of Beyblade X Knight Fortress Group.stl" \
npm run test:e2e -- --workers=1
```

Expected: all E2E tests PASS without skipping either supplied model.

Run: `npm run test:performance && npm run validate:fixtures`

Expected: all performance cases and all fixture validations PASS.

- [ ] **Step 6: Commit the release regression coverage**

```bash
git add e2e/one-click-outline.spec.ts e2e/helpers.ts src/test/e2e-helpers.test.ts
git commit -m "test: verify shared holes across release artifacts"
```

---

### Task 6: Final Diff and Privacy Review

**Files:**
- Review: all files changed since commit `431dbf2`

**Interfaces:**
- Consumes: Tasks 1–5 and their passing test evidence.
- Produces: a reviewable branch with no fixture leakage or unrelated user-file changes.

- [ ] **Step 1: Inspect the complete implementation diff**

Run: `git diff --check 431dbf2..HEAD && git diff --stat 431dbf2..HEAD`

Expected: no whitespace errors; only planned source, tests, and styles are listed.

- [ ] **Step 2: Confirm user files remain untracked and private paths are absent from commits**

Run: `git status --short && git grep -nE 'cywong@|/Users/cywong|GoogleDrive-cywong' 431dbf2..HEAD -- . ':!docs/superpowers/plans/2026-07-22-unified-hole-and-unobstructed-preview.md'`

Expected: the two STL files and existing archive/directory remain untracked; `git grep` emits no matches from implementation files.

- [ ] **Step 3: Review spec coverage**

Confirm the diff contains all of the following evidence:

```text
global shared-hole selector
two-pass exact extraction
two-pass projected extraction
all-layer omission warning
control-free rotating viewport
result layer selector retained
upper-left compact status overlay
pre-parse neutral loading state
Knight Fortress and Group regression execution
SVG/DXF/PDF/ZIP agreement
```

- [ ] **Step 4: Request code review before integration**

Invoke `superpowers:requesting-code-review` against `431dbf2..HEAD`. Address any must-fix findings with focused failing tests and separate commits, then rerun the affected verification commands.
