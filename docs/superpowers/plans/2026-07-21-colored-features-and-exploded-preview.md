# Colored Features and Exploded Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ShapeCut's one-upload workflow so every layer can retain one central axle hole and up to two adaptive depth features, while showing the real rotating/exploded model and exporting reconciled SVG, DXF, two PDFs, and an exact four-file ZIP.

**Architecture:** A new `outline-features` domain consumes component-local projected layer evidence and produces validated role-specific geometry without weakening the existing exterior contract. The automatic worker pipeline returns structured-clone-safe preview and feature records; a split export stack builds one canonical colored document and derives all four artifacts plus an exact ZIP. A dedicated Three.js process viewport consumes only sanitized preview geometry and has an SVG/reduced-motion fallback.

**Tech Stack:** TypeScript 5.9, React 19, Three.js 0.179, Comlink/Web Workers, pdf-lib, JSZip, Vitest, Vitest Browser Chromium, Playwright.

## Global Constraints

- One file selection starts the complete workflow; no repair, axis, material, feature-painting, decomposition, engraving-setting, or export-confirmation step.
- Black `#000000` means `CUT_BLACK`; red `#E5484D` means relative deeper engraving `DEEP_RED`; blue `#3A78D4` means relative shallower engraving `LIGHT_BLUE`.
- Red and blue never encode literal power, speed, passes, material, kerf, or production-ready machine settings.
- Every layer has exactly one retained exterior, at most one central hole, at most one red feature, and at most one blue feature.
- The central-hole equivalent diameter is at least `max(0.5 mm, 1% of layer width)` and the hole must be finite, simple, closed, strictly contained, and near the selected axis.
- Red is chosen from depths at or above the layer's 75th percentile; blue is from the 40th percentile up to the red threshold; both are omitted unless contrast is at least `max(2 * raster cell size, 0.5% of layer planar diameter)`.
- Missing or unreliable hole/features are omitted with sanitized warnings; an unreliable exterior fails the whole conversion.
- Preserve component-local pre-grid bounds, direct X/Y span drift `<= 3%`, area drift `<= 3%`, finite coordinates, no self-intersection, and existing 6–24 layer/resource/deadline budgets.
- All CPU-heavy extraction, animation-data preparation, packaging, and verification run in the restartable worker and share the existing hard replacement-cancellation contract.
- Downloads are `cut-and-engrave.svg`, `cut-and-engrave.dxf`, `preview.pdf`, `exploded-view.pdf`, and `shapecut-files.zip` containing exactly the four individual files.
- ZIP/output contains no STL, JSON, standalone manifest, directory entry, private path, email, material profile, power, speed, or pass count.
- The viewport renders real mesh/layer data, honors reduced motion, and falls back to SVG when WebGL is unavailable.
- The two external Knight Fortress STL files remain untracked and are loaded only through environment variables during opt-in acceptance tests.

---

## File Map

- Create `src/domain/outline-features/types.ts`: public feature roles, layer geometry, diagnostics, and preview payloads.
- Create `src/domain/outline-features/hole.ts`: deterministic central-hole qualification and selection.
- Create `src/domain/outline-features/depth-field.ts`: bounded source-triangle depth raster, quantiles, connected regions, and feature selection.
- Create `src/domain/outline-features/validate.ts`: cross-role containment, clearance, count, drift, and topology validation.
- Create `src/domain/outline-features/*.test.ts`: hole/depth/validation regressions and properties.
- Modify `src/domain/outline-2.5d/raster.ts`: expose pre-fill void candidates and bounded retained-component depth evidence.
- Modify `src/domain/outline-2.5d/extract.ts`: construct role-specific feature layers while preserving the exterior contract.
- Modify `src/domain/pipeline/automatic-outline-pipeline.ts`: return colored layers, warnings, feature fingerprints, and preview geometry.
- Modify `src/workers/geometry-api.ts`, `src/workers/geometry-client.ts`, `src/workers/geometry.worker.ts`: structured-clone colored result and package transfer.
- Create `src/export/colored-outline-document.ts`: canonical role-specific manufacturing document and fingerprints.
- Create `src/export/exploded-pdf.ts`: deterministic labeled exploded assembly PDF.
- Modify `src/export/outline-package.ts`, `src/export/package.ts`, `src/export/layers.ts`: SVG/DXF/preview PDF/exploded PDF/exact ZIP generation and verification.
- Create `src/preview/OutlineProcessViewport.tsx`: accessible React viewport boundary and SVG fallback.
- Create `src/preview/outline-process-scene.ts`: Three.js wireframe, scan plane, exploded layers, controls, cleanup.
- Create `src/preview/OutlineProcessViewport.test.tsx` and `.browser.test.tsx`: fallback, reduced motion, actual geometry, disposal.
- Modify `src/app/OneClickConverter.tsx`, `src/app/App.tsx`, `src/styles.css`: processing viewport, result viewport, warnings, and five downloads.
- Modify `e2e/helpers.ts`, `e2e/happy-path.spec.ts`, `e2e/one-click-outline.spec.ts`, `e2e/performance.spec.ts`: new artifact and animation acceptance.
- Modify `README.md`, `docs/materials/safety.md`, `docs/validation/software-results.md`: color semantics, limits, outputs, and current evidence.

---

### Task 1: Define colored layer and preview contracts

**Files:**
- Create: `src/domain/outline-features/types.ts`
- Create: `src/domain/outline-features/types.test.ts`
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/workers/geometry-api.test.ts`

**Interfaces:**
- Consumes: existing `Point2`, `Bounds2`, `OutlineAxisSelection`, `MeshProblemReport`, `OutlineLayer` exterior evidence.
- Produces: `FeatureRole`, `FeatureContour`, `ColoredOutlineLayer`, `LayerFeatureDiagnostics`, `OutlinePreviewPayload`, and an extended `AutomaticOutlineResult`.

- [ ] **Step 1: Write failing runtime-contract tests**

Add exact structural and runtime-forgery tests:

```ts
const layer: ColoredOutlineLayer = {
  id: 'outline-layer-0', index: 0, zStart: 0, zEnd: 1,
  exterior: square(20), centralHole: circle(2),
  deepFeature: rectangle(3, 2), lightFeature: undefined,
  removedComponentCount: 1,
  diagnostics: {
    hole: { status: 'retained', equivalentDiameterMm: 4, axisDistanceMm: 0.1 },
    depth: { cellSizeMm: 0.1, contrastMm: 0.8, redThresholdMm: 0.6, blueThresholdMm: 0.25 },
  },
};
expect(validateColoredLayerShape(layer)).toEqual({ ok: true, reasons: [] });
expect(() => validateAutomaticColoredResult(structuredClone({ ...result, layers: [{ ...layer, deepFeature: bowTie() }] })))
  .toThrow(/deep feature|self-intersection/i);
```

Require exactly one exterior; optional role fields only; no generic unbounded holes/features arrays; finite layer and preview data; stable structured clone.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npx vitest run src/domain/outline-features/types.test.ts src/workers/geometry-api.test.ts`

Expected: FAIL because `outline-features/types` and colored result fields do not exist.

- [ ] **Step 3: Implement exact public types**

```ts
export type FeatureRole = 'CUT_BLACK' | 'DEEP_RED' | 'LIGHT_BLUE';
export type FeatureContour = {
  readonly id: string;
  readonly role: FeatureRole;
  readonly outer: readonly Point2[];
  readonly boundsMm: Bounds2;
  readonly areaMm2: number;
};
export type ColoredOutlineLayer = {
  readonly id: string; readonly index: number;
  readonly zStart: number; readonly zEnd: number;
  readonly exterior: FeatureContour;
  readonly centralHole?: FeatureContour;
  readonly deepFeature?: FeatureContour;
  readonly lightFeature?: FeatureContour;
  readonly removedComponentCount: number;
  readonly diagnostics: LayerFeatureDiagnostics;
};
export type OutlinePreviewPayload = {
  readonly mesh: { readonly positions: Float32Array; readonly indices: Uint32Array };
  readonly axis: { readonly origin: readonly [number, number, number]; readonly direction: readonly [number, number, number] };
  readonly layers: readonly ColoredOutlineLayer[];
};
```

Extend `AutomaticOutlineResult` with `coloredLayers`, `featureWarnings`, `featureEvidenceFingerprint`, and `preview`. Keep the existing exterior `layers` during migration so old exact/projected tests remain meaningful until Task 3 switches packaging.

- [ ] **Step 4: Implement fail-closed runtime shape validation**

Validate safe integers/counts, unique IDs, role equality, finite typed arrays, triangle indices, layer ordering, at most one optional role, and absence of extra enumerable role geometry. Reject a feature fingerprint that is missing, empty, or inconsistent with the ordered role records.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run src/domain/outline-features/types.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/workers/geometry-api.test.ts && npm run typecheck`

Expected: all selected tests pass; TypeScript reports no diagnostics.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/outline-features src/domain/outline-2.5d/extract.ts src/domain/pipeline/automatic-outline-pipeline.ts src/workers/geometry-api.test.ts
git commit -m "feat: define colored outline layer contracts"
```

---

### Task 2: Retain one reliable central axle hole

**Files:**
- Create: `src/domain/outline-features/hole.ts`
- Create: `src/domain/outline-features/hole.test.ts`
- Modify: `src/domain/outline-2.5d/raster.ts`
- Modify: `src/domain/outline-2.5d/raster.test.ts`
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/outline-2.5d/extract.test.ts`

**Interfaces:**
- Consumes: retained exterior, axis projected into layer coordinates, pre-fill zero regions, exact nested loops, cell size, direct-span evidence.
- Produces: `selectCentralHole(request): CentralHoleSelection`, at most one black hole contour, and sanitized omission reasons.

- [ ] **Step 1: Write failing hole-selection tests**

Cover exact nested loops, projected raster voids, micro-holes, open gaps, two near-axis holes, remote larger decorative holes, non-simple candidates, translation, triangle-order reversal, and no-hole layers.

```ts
const selection = selectCentralHole({
  candidates: [remoteHole(8, 9), centeredHole(3, 0.1), centeredHole(4, 0.2)],
  exterior: square(30), axisPoint: [0, 0], layerWidthMm: 30, cellSizeMm: 0.1,
});
expect(selection.hole?.equivalentDiameterMm).toBeCloseTo(4);
expect(selection.hole?.axisDistanceMm).toBeCloseTo(0.2);
```

Assert the threshold `max(0.5, width * 0.01)`, central equivalence band `max(0.5, width * 0.02)`, greatest-area choice inside that band, and lowest-min-X/Y tie break.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/domain/outline-features/hole.test.ts src/domain/outline-2.5d/raster.test.ts src/domain/outline-2.5d/extract.test.ts`

Expected: FAIL because raster extraction currently fills every hole and exact extraction treats multiple loops as generic ambiguity.

- [ ] **Step 3: Expose bounded pre-fill void candidates**

In `rasterProjectLayer`, preserve the exterior flood-fill labels before `fillHoles`. Trace only bounded zero components that are strictly enclosed by the retained occupied component. Return no more than 64 candidates and reject workloads beyond `maxRasterCellsTotal`/deadline.

```ts
export type RasterContour = {
  // existing fields
  readonly enclosedVoids: readonly {
    readonly outer: readonly Point2[];
    readonly occupiedCellCount: number;
  }[];
};
```

Do not change the exterior mask used for largest-component selection.

- [ ] **Step 4: Classify exact nested loops without accepting disjoint exteriors**

In exact slicing, construct the containment tree for closed loops. Accept exactly one depth-zero exterior. Pass strictly nested depth-one loops to central-hole selection. Throw `ExactContourAmbiguityError` for two depth-zero loops, touching loops, depth greater than one, or containment ambiguity so the projected fallback remains safe.

- [ ] **Step 5: Implement deterministic central-hole selection**

```ts
export function selectCentralHole(request: CentralHoleRequest): CentralHoleSelection {
  const minimumDiameter = Math.max(0.5, request.layerWidthMm * 0.01);
  const qualified = request.candidates.filter(isFiniteSimpleContainedCandidate)
    .filter((item) => item.equivalentDiameterMm >= minimumDiameter);
  const nearest = Math.min(...qualified.map((item) => item.axisDistanceMm));
  const centralBand = Math.max(0.5, request.layerWidthMm * 0.02);
  return chooseGreatestArea(qualified.filter((item) => item.axisDistanceMm <= nearest + centralBand));
}
```

Require strict containment plus clearance of at least one raster cell or `0.1%` of planar diameter, whichever is greater. Output clockwise exterior and counter-clockwise hole orientation for export clarity.

- [ ] **Step 6: Run domain/pipeline regression tests**

Run: `npx vitest run src/domain/outline-features/hole.test.ts src/domain/outline-2.5d/*.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts && npm run typecheck`

Expected: hole tests and all existing exact/projected ambiguity/fidelity tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/domain/outline-features/hole.ts src/domain/outline-features/hole.test.ts src/domain/outline-2.5d
git commit -m "feat: retain a reliable central axle hole"
```

---

### Task 3: Extract adaptive red and blue depth features

**Files:**
- Create: `src/domain/outline-features/depth-field.ts`
- Create: `src/domain/outline-features/depth-field.test.ts`
- Create: `src/domain/outline-features/validate.ts`
- Create: `src/domain/outline-features/validate.test.ts`
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.test.ts`

**Interfaces:**
- Consumes: original projected source triangles, layer interval, retained exterior/hole, axis basis, cell/budget/deadline.
- Produces: `extractAdaptiveDepthFeatures(request): DepthFeatureResult`, validated red/blue contours, omission warnings, quantiles, and fingerprint evidence.

- [ ] **Step 1: Write failing depth-band tests**

Use synthetic stepped, textured, flat, noisy, holed, and two-component surfaces. Require red to represent the deeper quantile even when its area is smaller, blue to remain shallower, one connected region per role, no overlap with the hole/cut clearance, deterministic output under triangle shuffling, and omission on insufficient contrast.

```ts
const features = extractAdaptiveDepthFeatures(steppedSurface(), request);
expect(features.red?.role).toBe('DEEP_RED');
expect(features.blue?.role).toBe('LIGHT_BLUE');
expect(features.diagnostics.redThresholdMm).toBeGreaterThan(features.diagnostics.blueThresholdMm);
expect(overlapArea(features.red!.outer, hole.outer)).toBe(0);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/domain/outline-features/depth-field.test.ts src/domain/outline-features/validate.test.ts`

Expected: FAIL because depth-field modules do not exist.

- [ ] **Step 3: Build a bounded source-triangle depth field**

Transform original triangles with the selected axis. For every layer, rasterize finite intersections into front/back axial depths using the exterior raster grid. Reject more than `maxRasterCellsTotal`, triangle-layer tests beyond budget, missing finite front/back samples, or deadline expiry. Mask outside exterior and inside the central hole plus clearance.

```ts
export type DepthField = {
  readonly width: number; readonly height: number; readonly cellSizeMm: number;
  readonly depthMm: Float32Array; readonly valid: Uint8Array;
  readonly origin: Point2;
};
```

- [ ] **Step 4: Implement adaptive quantiles and connected-region selection**

Sort or histogram bounded finite positive samples deterministically. Use the 40th and 75th percentiles. If `p75 - p40 < max(2 * cellSize, planarDiameter * 0.005)`, return no red/blue feature and warning `表面深度差不足，已省略雕刻特徵`.

Create non-overlapping masks:

```ts
const redMask = validDepth >= p75;
const blueMask = validDepth >= p40 && validDepth < p75;
```

Apply one 3x3 close, remove components smaller than `max(4 cells, exteriorArea * 0.001)`, trace candidates, and retain greatest area with min-X/Y tie break.

- [ ] **Step 5: Validate cross-role geometry**

Reject non-finite/open/self-intersecting regions; ensure strict exterior containment; ensure no red/blue overlap; ensure no overlap or touch with the central hole clearance; enforce at most one feature per role and 4096 points per feature. Simplify with the existing RDP drift rules and preserve role-specific source evidence.

- [ ] **Step 6: Integrate warnings and feature fingerprints**

Hash ordered records containing source hash, mode, layer ID/index/Z, exterior/hole/red/blue points, depth thresholds, cell size, and omission codes. The worker result validator recomputes and rejects a missing, swapped, recolored, or mutated feature.

- [ ] **Step 7: Run focused/full domain tests**

Run: `npx vitest run src/domain/outline-features/*.test.ts src/domain/outline-2.5d/*.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/workers/geometry-api.test.ts && npm run typecheck`

Expected: all colored geometry, existing fidelity, exact fallback, worker clone, resource, and deadline tests pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/domain/outline-features src/domain/outline-2.5d/extract.ts src/domain/pipeline/automatic-outline-pipeline.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/workers/geometry-api.test.ts
git commit -m "feat: extract adaptive colored depth features"
```

---

### Task 4: Build the canonical colored document and five downloads

**Files:**
- Create: `src/export/colored-outline-document.ts`
- Create: `src/export/colored-outline-document.test.ts`
- Create: `src/export/exploded-pdf.ts`
- Create: `src/export/exploded-pdf.test.ts`
- Modify: `src/export/outline-package.ts`
- Modify: `src/export/outline-package.test.ts`
- Modify: `src/export/package.ts`
- Modify: `src/export/layers.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry-client.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `src/workers/geometry-worker.browser.test.ts`

**Interfaces:**
- Consumes: validated `AutomaticOutlineResult.coloredLayers`, diagnostics, fingerprints, and shared package deadline.
- Produces: `ColoredOutlinePackage` and `OutlinePackageTransfer` containing ZIP, SVG, DXF, preview PDF, and exploded PDF only.

- [ ] **Step 1: Write failing canonical and package tests**

Require exact roles/colors, central-hole cut semantics, ordered layer identity, PDF labels/dimensions/hole diameter, four ZIP records, byte identity, and rejection of mutated color/role/geometry/fingerprint. Assert public text contains no `80%`, `40%`, `power`, `speed`, `passes`, material claim, path, email, JSON, manifest, or STL name.

```ts
expect(Object.keys(zip.files).sort()).toEqual([
  'cut-and-engrave.dxf', 'cut-and-engrave.svg',
  'exploded-view.pdf', 'preview.pdf',
]);
expect(svg).toContain('id="CUT_BLACK"');
expect(svg).toContain('stroke="#E5484D"');
expect(dxf).toContain('DEEP_RED');
expect(dxf).not.toMatch(/power|speed|passes/i);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run src/export/colored-outline-document.test.ts src/export/exploded-pdf.test.ts src/export/outline-package.test.ts`

Expected: FAIL because the current package has one CUT role, JSON/manifest downloads, one PDF, and five ZIP records.

- [ ] **Step 3: Implement the canonical role document**

```ts
export type ColoredOutlineDocument = {
  readonly schemaVersion: 2;
  readonly sourceHash: string;
  readonly featureEvidenceFingerprint: string;
  readonly diagnosticsFingerprint: string;
  readonly layers: readonly {
    readonly id: string; readonly order: number; readonly index: number;
    readonly zStart: number; readonly zEnd: number;
    readonly roles: Readonly<{
      CUT_BLACK: readonly FeatureContour[];
      DEEP_RED: readonly FeatureContour[];
      LIGHT_BLUE: readonly FeatureContour[];
    }>;
  }[];
};
```

Require one black exterior plus zero/one black central hole, zero/one red, zero/one blue. Validate containment, orientation, colors, IDs, order, direct span drift, diagnostics, and fingerprints before generation.

- [ ] **Step 4: Generate SVG and DXF from shared entities**

SVG uses physical-layer groups containing the three canonical role groups and exact hex colors. DXF writes explicit layer names, ACI values (`7` black/white, `1` red, `5` blue) plus true-color group `420`. Both embed source/layer/feature/diagnostic fingerprints and exact ordered entity counts.

- [ ] **Step 5: Generate both deterministic PDFs**

`preview.pdf` renders flat sheet layout with exact role colors, layer labels, scale, and disclaimer. `exploded-view.pdf` renders one deterministic perspective/isometric exploded assembly with central axis, layer order, thickness, X/Y, and hole diameter or `—`. Fix creation/modification dates and fonts so regeneration is byte-identical.

- [ ] **Step 6: Create and verify the exact four-file ZIP**

Return:

```ts
export type ColoredOutlinePackage = {
  readonly cutSvg: string; readonly cutDxf: string;
  readonly previewPdf: Uint8Array; readonly explodedViewPdf: Uint8Array;
  readonly zip: Uint8Array;
};
```

ZIP verification enumerates all original/sanitized record names, requires exactly four non-directory records, scans every name/payload, and requires each payload byte-identical to the individual output. No standalone JSON/manifest is returned or zipped.

- [ ] **Step 7: Preserve worker cancellation, transfer, and deadline**

Update `GeometryApi.packageOutline` and transfer lists for both PDF buffers and ZIP. Keep one absolute 30-second deadline across document creation, SVG/DXF parsing, both PDF saves/loads, ZIP generate/load/read, polygon checks, and final returns. Browser tests start worst-case packaging, supersede it, assert `SupersededError`, terminate/recreate, and complete replacement.

- [ ] **Step 8: Run export/worker/full tests**

Run: `npx vitest run src/export/colored-outline-document.test.ts src/export/exploded-pdf.test.ts src/export/outline-package.test.ts src/export/export.test.ts && npm run test:browser -- src/workers/geometry-worker.browser.test.ts && npm run typecheck`

Expected: all selected unit/browser tests pass with no legacy JSON/manifest output in the colored package.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/export src/workers
git commit -m "feat: export colored ShapeCut artifact set"
```

---

### Task 5: Render the real rotating and exploded process viewport

**Files:**
- Create: `src/preview/OutlineProcessViewport.tsx`
- Create: `src/preview/OutlineProcessViewport.test.tsx`
- Create: `src/preview/OutlineProcessViewport.browser.test.tsx`
- Create: `src/preview/outline-process-scene.ts`
- Create: `src/preview/outline-process-scene.test.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `OutlinePreviewPayload`, current progress stage, reduced-motion media query, optional WebGL factory.
- Produces: `OutlineProcessViewport`, `OutlineProcessScene`, interactive reset/zoom/rotation controls, and SVG fallback.

- [ ] **Step 1: Write failing viewport lifecycle tests**

Test actual mesh buffer consumption, transparent wireframe material, horizontal rotation, scan plane, real layer count, canonical colors, exploded Z offsets, pointer/keyboard controls, reset, ResizeObserver cleanup, WebGL disposal, replacement payload, unmount, reduced motion, and no-WebGL fallback.

```tsx
render(<OutlineProcessViewport payload={payload} stage="slicing" />);
expect(screen.getByRole('img', { name: /模型分層預覽/ })).toHaveAttribute('data-layer-count', '6');
expect(scene.layers[0].position.y).not.toBe(scene.layers[5].position.y);
```

- [ ] **Step 2: Run unit/browser tests to verify RED**

Run: `npx vitest run src/preview/OutlineProcessViewport.test.tsx src/preview/outline-process-scene.test.ts && npm run test:browser -- src/preview/OutlineProcessViewport.browser.test.tsx`

Expected: FAIL because the process viewport does not exist.

- [ ] **Step 3: Implement a focused Three.js scene controller**

Create one `BufferGeometry` from transferred preview arrays, `WireframeGeometry`, transparent mint `LineBasicMaterial`, scan plane, central axis, and one line group per validated role/layer. Use requestAnimationFrame only while visible and not reduced-motion. Explosion offsets are deterministic around the middle layer:

```ts
const offset = (layer.order - (layerCount - 1) / 2) * EXPLODED_LAYER_GAP;
```

Map the selected manufacturing axis to the display Y axis and rotate the scene only around display Y.

- [ ] **Step 4: Implement accessible React boundary and SVG fallback**

Expose a labelled figure plus reset/zoom controls. If `WebGLRenderingContext` or scene construction fails, render actual exterior/hole/red/blue SVG paths from the payload. Reduced motion sets a stable rotation and immediate exploded offsets; it must not schedule continuous animation frames.

- [ ] **Step 5: Verify cleanup and real Chromium behavior**

Run: `npx vitest run src/preview/OutlineProcessViewport.test.tsx src/preview/outline-process-scene.test.ts && npm run test:browser -- src/preview/OutlineProcessViewport.browser.test.tsx && npm run typecheck`

Expected: all tests pass; no WebGL warnings or leaked RAF/ResizeObserver/listeners.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/preview/OutlineProcessViewport* src/preview/outline-process-scene* src/styles.css
git commit -m "feat: visualize real rotating exploded layers"
```

---

### Task 6: Integrate visualization, warnings, and revised downloads

**Files:**
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/app/App.browser.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: extended worker progress/preview result, `OutlineProcessViewport`, new package transfer.
- Produces: processing/result UI with real background visualization and `OutlineDownloads` containing `zip`, `svg`, `dxf`, `previewPdf`, `explodedPdf`.

- [ ] **Step 1: Write failing UI state/download tests**

Require the processing viewport after preview payload arrives; real stage changes; warning distinctions for missing hole/red/blue; five downloads; no JSON link; exact filenames; object URL cleanup; second-file hard cancellation; reduced motion; fallback; and no forbidden engineering controls.

```ts
expect(screen.getByRole('link', { name: /下載 ZIP/ })).toHaveAttribute('download', 'shapecut-files.zip');
expect(screen.getByRole('link', { name: /爆炸圖 PDF/ })).toHaveAttribute('download', 'exploded-view.pdf');
expect(screen.queryByRole('link', { name: /JSON|manifest/i })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run UI tests to verify RED**

Run: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx`

Expected: FAIL because downloads still expose one PDF plus JSON, and processing uses a decorative spinner.

- [ ] **Step 3: Extend progress delivery without stale frames**

Add a structured progress event union:

```ts
export type AutomaticOutlineProgressEvent =
  | { readonly stage: AutomaticOutlineProgressStage }
  | { readonly stage: 'analyzing' | 'slicing'; readonly preview: OutlinePreviewPayload };
```

Keep monotonic stage gating and job IDs. Transfer preview arrays only when ownership is final or clone bounded preview buffers; selecting a new file terminates the worker and ignores stale events/frames.

- [ ] **Step 4: Replace spinner with process viewport**

Render `OutlineProcessViewport` as the card background during analyzing/slicing/packaging and as the primary result preview. Keep status text/progress foreground accessible. Do not show a decorative mesh before actual parsed data exists; use the existing neutral loading state until then.

- [ ] **Step 5: Update five download URLs transactionally**

```ts
export type OutlineDownloads = {
  readonly zip: DownloadFile;
  readonly svg: DownloadFile;
  readonly dxf: DownloadFile;
  readonly previewPdf: DownloadFile;
  readonly explodedPdf: DownloadFile;
};
```

Create generic filenames, revoke every partially created URL on failure, revoke all five on new result/reset/unmount, and never derive names from the uploaded file.

- [ ] **Step 6: Show truthful feature warnings and technical data**

Distinguish 2.5D simplification, missing central hole, omitted deep feature, omitted light feature, and exact-axis warnings. Show detected hole diameter and depth thresholds only when present. State that colors are relative levels, not literal power. Remove the claim that a downloadable JSON manifest exists.

- [ ] **Step 7: Implement responsive/reduced-motion styling**

Keep the mint/white visual system, readable foreground scrim, 44 px controls, visible focus, single-column mobile layout, and high-contrast black/red/blue legend. The viewport cannot capture pointer events needed by file replacement or downloads.

- [ ] **Step 8: Run UI unit/browser tests**

Run: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx && npm run test:browser -- src/app/App.browser.test.tsx src/preview/OutlineProcessViewport.browser.test.tsx && npm run typecheck`

Expected: all selected UI and Chromium tests pass; database/material repositories remain absent from the one-click main flow.

- [ ] **Step 9: Commit Task 6**

```bash
git add src/app src/styles.css
git commit -m "feat: present colored exploded one-click results"
```

---

### Task 7: Validate real files, performance, privacy, and documentation

**Files:**
- Modify: `e2e/helpers.ts`
- Modify: `e2e/happy-path.spec.ts`
- Modify: `e2e/one-click-outline.spec.ts`
- Modify: `e2e/performance.spec.ts`
- Modify: `README.md`
- Modify: `docs/materials/safety.md`
- Modify: `docs/validation/software-results.md`

**Interfaces:**
- Consumes: complete colored pipeline, viewport, exports, and the two external STL environment variables.
- Produces: release-level evidence, exact artifact parsers, and truthful operating documentation.

- [ ] **Step 1: Rewrite E2E artifact parsers and mutations**

Parse every SVG role group/entity, DXF layer/entity, PDF metadata/geometry record, and all four ZIP records preserving encounter order. Require exact cardinality, unique layer/feature IDs, canonical colors, matching fingerprints, no malformed/duplicate/extra markers, and byte identity. Add raw mutations for swapped role, recolor, missing central hole, extra feature, duplicate file, unsafe ZIP name, and PDF mismatch.

- [ ] **Step 2: Update safe/synthetic browser acceptance**

Safe single-loop fixture reaches exact mode, shows real wireframe/exploded layers, and downloads five artifacts. Synthetic holed/stepped fixture proves one black central hole, one red deeper region, one blue shallower region, SVG/DXF/PDF reconciliation, reduced motion, and no WebGL fallback.

- [ ] **Step 3: Run both real Knight fixtures with zero skips**

Run:

With `KNIGHT_FORTRESS_STL` and `KNIGHT_FORTRESS_GROUP_STL` already set to the two external files, run:

```bash
test -f "$KNIGHT_FORTRESS_STL" && test -f "$KNIGHT_FORTRESS_GROUP_STL"
npx playwright test e2e/one-click-outline.spec.ts --workers=1
```

Expected: 2/2 pass, 0 skip. Both reach warning-mode output and five downloads. Assert a central hole only when actual geometry passes the documented rule; never weaken the rule to force the fixture. Group still has authentic `removedComponentCount > 0`. Any reliable red/blue feature is reconciled across all formats.

- [ ] **Step 4: Strengthen performance and cancellation acceptance**

Measure from immediately before `setInputFiles`. Require no main-thread long task `>= 100 ms` through preview-buffer reception, explosion display, both-PDF packaging, and URL creation. Keep 100k bounded result classification and 500k typed resource/time failure. Start worst-case feature/PDF packaging, select another file, and prove worker termination/replacement completes the second result.

- [ ] **Step 5: Update documentation truthfully**

README documents one upload, black/red/blue relative roles, central-hole rule, five downloads, and animation fallbacks. Safety documentation states colors are not literal power, materials need test cuts, missing features may be omitted, and 2.5D remains approximate. Software results record current commands/counts only after the final fresh run.

- [ ] **Step 6: Run the complete fresh verification matrix**

Run:

```bash
npm test
npm run test:browser -- --run
test -f "$KNIGHT_FORTRESS_STL" && test -f "$KNIGHT_FORTRESS_GROUP_STL"
npm run test:e2e -- --workers=1
npm run validate:fixtures
npm run test:performance
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: every suite exits 0; real tests have zero skips; only the two external STL, existing user outputs, and ignored brainstorming assets remain untracked; no generated artifact or private absolute path is added to the diff.

- [ ] **Step 7: Commit Task 7**

```bash
git add e2e README.md docs/materials/safety.md docs/validation/software-results.md
git commit -m "test: validate colored exploded ShapeCut workflow"
```

---

## Final Review Gate

- Generate a review package from the implementation base to HEAD.
- Request a fresh whole-branch review against the approved design and this plan.
- Fix every Critical and Important finding; rerun focused review after each fix.
- Use `superpowers:verification-before-completion` for a fresh full matrix.
- Use `superpowers:finishing-a-development-branch` to offer local merge, PR, keep, or discard; do not merge without the user's choice.
