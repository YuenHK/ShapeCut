# STL Mesh Repair and Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local, reversible STL repair with precise topology diagnostics, 3D problem highlighting, before/after comparison, and repaired-STL download.

**Architecture:** Pure mesh analysis and repair live in focused domain modules. The existing Comlink worker owns all CPU-heavy operations and returns bounded problem geometry plus repair results; React owns consent and model-selection state, while Three.js only renders supplied overlays. Original and repaired meshes remain separate so failed or excessive repairs never replace source data.

**Tech Stack:** TypeScript 5.9, React 19, Zustand, Comlink Web Worker, Three.js, Vitest, Vitest Browser, Playwright.

## Global Constraints

- All geometry work stays local in the browser; no STL upload or server dependency.
- Safe repair runs automatically and may only remove degenerate/duplicate faces, weld within `longestBoundingBoxEdge * 1e-7`, and compact unused vertices.
- Advanced repair requires explicit consent and may not produce more than `min(originalTriangles * 1.1, 500000)` triangles.
- A repaired mesh is processable only when boundary, non-manifold, degenerate, and duplicate counts are zero; each bounding-box axis changes by at most 0.5%; absolute volume changes by at most 1%.
- Preserve the original mesh and permit restore at all times.
- Bound each problem-overlay category to 2,000 rendered items while retaining full counts.
- Existing 128 MiB, 500,000-triangle, and 300,000-unique-vertex parse limits remain unchanged.
- A parsed topology failure must never be described as a file-read failure.

---

### Task 1: Structured topology diagnostics

**Files:**
- Create: `src/domain/mesh/problem-report.ts`
- Create: `src/domain/mesh/problem-report.test.ts`
- Modify: `src/domain/mesh/types.ts`

**Interfaces:**
- Consumes: `TriangleMesh`, `MeshInspection`, `inspectMesh(mesh)` and scale-aware mesh coordinates.
- Produces: `analyzeMeshProblems(mesh: TriangleMesh, markerLimit?: number): MeshProblemReport` and serializable marker types used by repair, worker, and preview tasks.

- [ ] **Step 1: Write failing diagnostic tests**

```ts
it('reports duplicate faces independent of winding and bounds marker payloads', () => {
  const report = analyzeMeshProblems(meshWithRepeatedFace(2), 1);
  expect(report.duplicateTriangleCount).toBe(2);
  expect(report.duplicateTriangles).toHaveLength(1);
  expect(report.markersTruncated.duplicateTriangles).toBe(true);
});

it('returns stable coordinates and region ids for non-manifold edges', () => {
  const report = analyzeMeshProblems(threeFacesSharingOneEdge());
  expect(report.inspection.nonManifoldEdgeCount).toBe(1);
  expect(report.nonManifoldEdges[0]).toMatchObject({ regionId: 'mesh-non-manifold-edge-0' });
  expect(report.nonManifoldEdges[0].points).toEqual([[0, 0, 0], [1, 0, 0]]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/domain/mesh/problem-report.test.ts`

Expected: FAIL because `problem-report.ts` and `analyzeMeshProblems` do not exist.

- [ ] **Step 3: Add diagnostic types and implementation**

```ts
export type EdgeMarker = { readonly regionId: string; readonly points: readonly [Vec3, Vec3] };
export type TriangleMarker = { readonly regionId: string; readonly points: readonly [Vec3, Vec3, Vec3] };
export type MeshProblemReport = {
  readonly inspection: MeshInspection;
  readonly duplicateTriangleCount: number;
  readonly boundaryEdges: readonly EdgeMarker[];
  readonly nonManifoldEdges: readonly EdgeMarker[];
  readonly degenerateTriangles: readonly TriangleMarker[];
  readonly duplicateTriangles: readonly TriangleMarker[];
  readonly markersTruncated: Readonly<Record<'boundaryEdges' | 'nonManifoldEdges' | 'degenerateTriangles' | 'duplicateTriangles', boolean>>;
};

export function analyzeMeshProblems(mesh: TriangleMesh, markerLimit = 2_000): MeshProblemReport;
```

Build one undirected edge-incidence map and one sorted-triangle-key map in a single pass. Reuse the same scale-aware degeneracy rule as `inspectMesh`; store at most `markerLimit` coordinates per category but continue counting all entries. Reject negative, non-integer marker limits.

- [ ] **Step 4: Run focused and existing mesh tests**

Run: `npm test -- --run src/domain/mesh/problem-report.test.ts src/domain/mesh/mesh.test.ts`

Expected: all tests PASS and existing inspection counts remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/mesh/problem-report.ts src/domain/mesh/problem-report.test.ts src/domain/mesh/types.ts
git commit -m "feat: report precise mesh topology problems"
```

---

### Task 2: Safe repair and shape comparison

**Files:**
- Create: `src/domain/mesh/repair-mesh.ts`
- Create: `src/domain/mesh/repair-mesh.test.ts`
- Modify: `src/domain/mesh/types.ts`

**Interfaces:**
- Consumes: `TriangleMesh`, `MeshProblemReport`, `analyzeMeshProblems` and mass properties.
- Produces: `repairMeshSafe(mesh: TriangleMesh): MeshRepairResult`, `compareMeshes(before, after): MeshComparison`, and shared repair result types.

- [ ] **Step 1: Write failing safe-repair tests**

```ts
it('removes degenerate and duplicate faces, welds near vertices, and compacts unused vertices', () => {
  const result = repairMeshSafe(repairableTetrahedron());
  expect(result.mode).toBe('safe');
  expect(result.after.inspection).toMatchObject({ boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0 });
  expect(result.after.duplicateTriangleCount).toBe(0);
  expect(result.changes.removedDegenerate).toBeGreaterThan(0);
  expect(result.changes.removedDuplicate).toBeGreaterThan(0);
  expect(result.accepted).toBe(true);
});

it('does not mutate source or hide unresolved non-manifold edges', () => {
  const source = threeFacesSharingOneEdge();
  const before = cloneMesh(source);
  const result = repairMeshSafe(source);
  expect(source).toEqual(before);
  expect(result.accepted).toBe(false);
  expect(result.blockingReasons).toContain('仍有非流形邊');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/domain/mesh/repair-mesh.test.ts`

Expected: FAIL because safe repair is not implemented.

- [ ] **Step 3: Implement deterministic safe repair**

```ts
export type MeshComparison = {
  readonly beforeSize: Vec3;
  readonly afterSize: Vec3;
  readonly axisChangePercent: Vec3;
  readonly beforeAbsoluteVolume: number;
  readonly afterAbsoluteVolume: number;
  readonly volumeChangePercent: number;
};
export type MeshRepairResult = {
  readonly mode: 'safe' | 'advanced';
  readonly mesh: TriangleMesh;
  readonly before: MeshProblemReport;
  readonly after: MeshProblemReport;
  readonly changes: { readonly removedDegenerate: number; readonly removedDuplicate: number; readonly weldedVertices: number; readonly splitVertices: number; readonly filledHoles: number };
  readonly comparison: MeshComparison;
  readonly accepted: boolean;
  readonly blockingReasons: readonly string[];
};
```

Compute the weld cell size as `longestBoundingBoxEdge * 1e-7`; use integer spatial-cell keys plus adjacent-cell checks so welding is bounded and deterministic. Filter degenerate and unordered duplicate faces, compact first-use vertex order, analyze again, and accept only with zero topology counts and the global shape thresholds.

- [ ] **Step 4: Verify focused tests and Knight Fortress safe result**

Run: `npm test -- --run src/domain/mesh/repair-mesh.test.ts`

Run: `npm run validate:fixtures`

Expected: unit tests PASS; acceptance fixtures remain 10/10. A test using the project-owned Knight Fortress fixture confirms safe repair removes all 63 degenerate faces but does not falsely accept unresolved non-manifold topology.

- [ ] **Step 5: Commit**

```bash
git add src/domain/mesh/repair-mesh.ts src/domain/mesh/repair-mesh.test.ts src/domain/mesh/types.ts
git commit -m "feat: add reversible safe mesh repair"
```

---

### Task 3: Consent-gated advanced repair

**Files:**
- Create: `src/domain/mesh/advanced-repair.ts`
- Create: `src/domain/mesh/advanced-repair.test.ts`

**Interfaces:**
- Consumes: safe-repaired `TriangleMesh`, `analyzeMeshProblems`, `compareMeshes` and repair result types.
- Produces: `repairMeshAdvanced(original: TriangleMesh, safeMesh: TriangleMesh): MeshRepairResult`.

- [ ] **Step 1: Write failing advanced-repair tests**

```ts
it('splits a non-manifold edge fan into independent manifold sheets', () => {
  const result = repairMeshAdvanced(source, repairMeshSafe(source).mesh);
  expect(result.changes.splitVertices).toBeGreaterThan(0);
  expect(result.after.inspection.nonManifoldEdgeCount).toBe(0);
});

it('fills only a planar boundary loop within 2 percent of the longest edge', () => {
  expect(repairMeshAdvanced(source, smallPlanarHole()).changes.filledHoles).toBe(1);
  expect(repairMeshAdvanced(source, largeHole()).blockingReasons).toContain('缺口超出自動補合上限');
});

it('rejects topology growth and excessive size or volume drift', () => {
  expect(() => repairMeshAdvanced(source, explosiveFan())).toThrow(/triangle.*limit/i);
  expect(repairMeshAdvanced(source, distortedRepair()).accepted).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/domain/mesh/advanced-repair.test.ts`

Expected: FAIL because advanced repair does not exist.

- [ ] **Step 3: Implement the bounded first-version strategy**

Implement connected face fans around over-incident edges, remove exact coincident/internal duplicate faces first, then duplicate edge vertices per independent fan. Detect boundary loops, require one loop, at most 12 vertices, planarity within the safe weld tolerance, and perimeter at most 2% of the original longest edge; triangulate using a projected ear-clipping loop. Reorient connected shells by signed volume. Abort before allocation when output would exceed the global triangle-growth limit.

- [ ] **Step 4: Run repair suites**

Run: `npm test -- --run src/domain/mesh/advanced-repair.test.ts src/domain/mesh/repair-mesh.test.ts src/domain/mesh/problem-report.test.ts`

Expected: all tests PASS; all rejected repairs return specific blocking reasons and leave the original unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/mesh/advanced-repair.ts src/domain/mesh/advanced-repair.test.ts
git commit -m "feat: add bounded advanced mesh repair"
```

---

### Task 4: Worker repair pipeline and binary STL output

**Files:**
- Create: `src/domain/mesh/write-stl.ts`
- Create: `src/domain/mesh/write-stl.test.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry-client.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `src/workers/geometry-api.test.ts`
- Modify: `src/workers/geometry-worker.browser.test.ts`

**Interfaces:**
- Consumes: `analyzeMeshProblems`, `repairMeshSafe`, `repairMeshAdvanced` and current Comlink transfer helpers.
- Produces: `analyzeAndRepairForImport(input)`, `repairAdvanced(original, safeMesh)`, and `writeBinarySTL(mesh, mode)` through `GeometryApi`/`GeometryClient`.

- [ ] **Step 1: Write failing serialization and API tests**

```ts
it('writes an exact-length binary STL that reparses to the same triangle count', () => {
  const bytes = writeBinarySTL(tetrahedron(), 'safe');
  expect(bytes.byteLength).toBe(84 + 4 * 50);
  expect(parseSTL(bytes).indices.length).toBe(12);
  expect(new TextDecoder().decode(bytes.slice(0, 80))).toContain('safe');
});

it('returns original and safe results without transferring away the original preview', async () => {
  const result = await client.analyzeAndRepairForImport(binaryTetrahedron());
  expect(result.originalReport).toBeDefined();
  expect(result.safeRepair.mode).toBe('safe');
  expect(result.originalPreview.positions.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/domain/mesh/write-stl.test.ts src/workers/geometry-api.test.ts`

Expected: FAIL on missing writer and API methods.

- [ ] **Step 3: Extend worker contracts and transfers**

```ts
export type ImportRepairAnalysis = {
  readonly sourceHash: string;
  readonly originalMesh: SerializedMesh;
  readonly originalPreview: SerializedMesh;
  readonly originalReport: MeshProblemReport;
  readonly safeRepair: MeshRepairResult;
  readonly candidates: readonly AxisCandidate[];
};

export type GeometryApi = {
  // existing methods remain
  analyzeAndRepairForImport(input: ArrayBuffer): Promise<ImportRepairAnalysis>;
  repairAdvanced(original: SerializedMesh, safeMesh: SerializedMesh): Promise<MeshRepairResult>;
  serializeSTL(mesh: SerializedMesh, mode: 'safe' | 'advanced'): Promise<ArrayBuffer>;
};
```

Return independent typed arrays for original, safe, and previews so Comlink transfer never detaches state still used by the UI. Validate serialized STL by reparsing it before returning the buffer.

- [ ] **Step 4: Run unit and real Chromium worker tests**

Run: `npm test -- --run src/domain/mesh/write-stl.test.ts src/workers/geometry-api.test.ts`

Run: `npm run test:browser -- src/workers/geometry-worker.browser.test.ts`

Expected: all tests PASS; browser test confirms transfers, repair failure preservation, and 2,000-marker cap.

- [ ] **Step 5: Commit**

```bash
git add src/domain/mesh/write-stl.ts src/domain/mesh/write-stl.test.ts src/workers/geometry-api.ts src/workers/geometry-client.ts src/workers/geometry.worker.ts src/workers/geometry-api.test.ts src/workers/geometry-worker.browser.test.ts
git commit -m "feat: expose mesh repair through geometry worker"
```

---

### Task 5: Three.js problem overlays

**Files:**
- Modify: `src/preview/scene-controller.ts`
- Modify: `src/preview/SpinnerViewport.tsx`
- Modify: `src/preview/SpinnerViewport.browser.test.tsx`

**Interfaces:**
- Consumes: `MeshProblemReport` marker arrays.
- Produces: `SceneController.setMeshProblems(report | undefined)` and accessible issue buttons whose `regionId` focuses the corresponding overlay.

- [ ] **Step 1: Write failing browser tests**

```tsx
it('sends problem geometry to the scene and focuses its stable region id', async () => {
  const controller = fakeController();
  render(<SpinnerViewport meshProblems={report} issues={issuesFromReport(report)} createController={() => controller} />);
  expect(controller.setMeshProblems).toHaveBeenCalledWith(report);
  await userEvent.click(screen.getByRole('button', { name: /非流形邊/i }));
  expect(controller.focusRegion).toHaveBeenCalledWith('mesh-non-manifold-edge-0');
});

it('announces when marker geometry is truncated', () => {
  render(<SpinnerViewport meshProblems={truncatedReport} issues={[]} createController={() => fakeController()} />);
  expect(screen.getByText(/只顯示首 2,000 個/)).toBeVisible();
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `npm run test:browser -- src/preview/SpinnerViewport.browser.test.tsx`

Expected: FAIL because the prop and controller method do not exist.

- [ ] **Step 3: Render overlay groups**

Add a dedicated `problemGroup`; render red boundary and magenta non-manifold `LineSegments`, orange degenerate markers, and yellow transparent duplicate-face meshes. Assign each object its marker `regionId`, dispose all geometries/materials on update, and include the group in `focusRegion` framing. Update `fakeController` implementations for the new method.

- [ ] **Step 4: Run browser preview suite**

Run: `npm run test:browser -- src/preview/SpinnerViewport.browser.test.tsx`

Expected: all preview tests PASS with no WebGL resource leaks across 20 mount cycles.

- [ ] **Step 5: Commit**

```bash
git add src/preview/scene-controller.ts src/preview/SpinnerViewport.tsx src/preview/SpinnerViewport.browser.test.tsx
git commit -m "feat: highlight mesh repair problems in 3d"
```

---

### Task 6: Repair workflow UI, consent, restore, and download

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/app/Wizard.tsx`
- Modify: `src/app/steps/ImportStep.tsx`
- Modify: `src/app/Wizard.test.tsx`
- Modify: `src/app/App.browser.test.tsx`

**Interfaces:**
- Consumes: worker `ImportRepairAnalysis`, `MeshRepairResult`, serializer, and problem overlays.
- Produces: explicit import-stage states `original`, `safe`, and `advanced`; safe auto-accept; consent-gated advanced repair; restore and download actions.

- [ ] **Step 1: Write failing workflow tests**

```tsx
it('auto-applies an accepted safe repair and shows before-after counts', async () => {
  renderWizard({ safeRepair: acceptedSafeRepair });
  await uploadAndAnalyze();
  expect(screen.getByText('退化三角形：63 → 0')).toBeVisible();
  expect(screen.getByRole('heading', { name: '軸心與尺寸' })).toBeVisible();
});

it('requires consent before advanced repair and can restore original', async () => {
  renderWizard({ safeRepair: blockedSafeRepair });
  await uploadAndAnalyze();
  expect(screen.getByRole('button', { name: '進階修復' })).toBeDisabled();
  await userEvent.click(screen.getByRole('checkbox', { name: /可能改變模型細節/ }));
  await userEvent.click(screen.getByRole('button', { name: '進階修復' }));
  await userEvent.click(screen.getByRole('button', { name: '復原原始模型' }));
  expect(screen.getByText('目前預覽：原始模型')).toBeVisible();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/app/Wizard.test.tsx`

Expected: FAIL because repair UI and service methods are missing.

- [ ] **Step 3: Implement state and accessible controls**

Extend `WizardServices` with `inspectAndRepair`, `advancedRepair`, and `downloadRepairedSTL`. Store original/safe/advanced meshes separately in component state; only set workflow `mesh` to an accepted repair. Render exact counts, comparison percentages, blocking reasons, consent checkbox, busy labels, restore, use, and download controls. Generate separate issues for boundary, non-manifold, degenerate, and duplicate categories with accurate Traditional Chinese copy.

- [ ] **Step 4: Verify unit and Chromium UI tests**

Run: `npm test -- --run src/app/Wizard.test.tsx`

Run: `npm run test:browser -- src/app/App.browser.test.tsx`

Expected: all tests PASS; a parsed topology failure never shows `讀不到檔案`, and a worker exception still shows `操作失敗：<exact message>`.

- [ ] **Step 5: Commit**

```bash
git add src/app/App.tsx src/app/Wizard.tsx src/app/steps/ImportStep.tsx src/app/Wizard.test.tsx src/app/App.browser.test.tsx
git commit -m "feat: add reversible mesh repair workflow"
```

---

### Task 7: Knight Fortress regression and complete verification

**Files:**
- Create: `e2e/mesh-repair.spec.ts`
- Modify: `playwright.config.ts` only if an explicit opt-in path for the external user fixture is needed.
- Modify: `docs/validation/software-results.md`

**Interfaces:**
- Consumes: the completed browser workflow and `/Users/cywong/Library/CloudStorage/GoogleDrive-cywong@twghfwfts.edu.hk/我的雲端硬碟/CoDex/3D Print To Laser Cut/Copy of Beyblade X Knight Fortress.stl`.
- Produces: regression evidence for exact diagnosis, safe/advanced controls, restore, and repaired STL download.

- [ ] **Step 1: Write failing E2E test**

```ts
test('diagnoses and offers repair for Knight Fortress without calling it unreadable', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('STL 模型檔案').setInputFiles(knightFortressPath);
  await page.getByRole('button', { name: '分析模型' }).click();
  await expect(page.getByText('非流形邊：105')).toBeVisible();
  await expect(page.getByText('退化三角形：63')).toBeVisible();
  await expect(page.getByText(/讀不到檔案/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '進階修復' })).toBeVisible();
});
```

- [ ] **Step 2: Run E2E test and verify RED or first integration gap**

Run: `npm run test:e2e -- e2e/mesh-repair.spec.ts`

Expected: FAIL until all exact Knight Fortress counts and controls are connected end-to-end.

- [ ] **Step 3: Make only integration corrections exposed by the test**

Keep production changes limited to data wiring, labels, and resource-safe behavior required by the approved specification. Add download assertions that reparse the saved `*-repaired.stl`, and restore assertions that recover the original statistics.

- [ ] **Step 4: Run the complete verification matrix**

Run: `npm test -- --run`

Expected: all unit/component tests PASS.

Run: `npm run test:browser`

Expected: all Chromium tests PASS.

Run: `npm run test:e2e`

Expected: all Playwright tests PASS, including Knight Fortress and existing performance tests.

Run: `npm run validate:fixtures`

Expected: 8 automatic models and 2 expected blocking/manual outcomes PASS.

Run: `npm run typecheck`

Expected: exit 0 with no diagnostics.

Run: `npm run build`

Expected: production build succeeds.

Run: `npm run test:performance`

Expected: 100k triangles reaches interactive axis within 3 seconds with no main-thread task over 100 ms; 500k case remains bounded.

- [ ] **Step 5: Record evidence and commit**

Add exact fresh test counts and Knight Fortress before/after outcome to `docs/validation/software-results.md` without claiming physical material approval.

```bash
git add e2e/mesh-repair.spec.ts docs/validation/software-results.md playwright.config.ts
git commit -m "test: verify real stl mesh repair workflow"
```
