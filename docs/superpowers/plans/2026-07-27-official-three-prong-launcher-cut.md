# Official Three-Prong Launcher Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every successful SVG, DXF, PDF, and ZIP fabrication output use one versioned Knight-derived three-prong launcher cut on the top two physical layers, with material kerf compensation, a bounded fit offset, decoration priority, calibration output, and fail-closed structural validation.

**Architecture:** Replace per-model launcher selection with a versioned fixed-template planner at the existing canonical black-cut boundary. Carry the template version, fingerprint, rotation, fit offset, and decoration-removal counts through `AutomaticOutlineAssembly`, the canonical colored document, preview, artifact writers, manifest verification, UI, and persistence; exporters continue consuming canonical geometry and never construct launcher cuts themselves.

**Tech Stack:** TypeScript 5, React 19, Three.js preview, Comlink worker boundary, Zod, Zustand, Dexie, existing polygon kernel, Vitest, Vitest Browser/Chromium, Testing Library, Playwright.

## Global Constraints

- Add launcher cuts to the top two physical layers only.
- Use the fixed Knight Fortress-derived template; do not detect a new shape from each uploaded STL.
- Apply internal-cut kerf compensation and one fit offset exactly once.
- Fit offset defaults to `0.00 mm`, accepts `-0.20 mm` through `+0.20 mm`, and uses a `0.01 mm` step.
- Positive fit offset loosens the finished opening; negative fit offset tightens it.
- Launcher `CUT_BLACK` geometry outranks `DEEP_RED` and `LIGHT_BLUE` decoration.
- Exterior, central axle hole, required structure, and mandatory material clearances remain protected.
- Any unsafe launcher placement blocks all artifacts; never emit a launcher-less or partially compliant package.
- Preview, SVG, DXF, both PDFs, ZIP members, manifest, and persisted project data must reconcile to one canonical decision.
- Preserve the existing material-selection reset when the uploaded model changes, and reset the fit offset to `0.00 mm` at the same time.
- Do not expose STL filenames, local paths, raw mesh data, or provenance inputs in public artifacts.
- Do not modify or delete the untracked STL files, `shapecut-outline/`, or `shapecut-outline.zip`.
- Do not create commits or worktrees until the user explicitly authorizes them. When authorized during execution, use the commit commands listed at the end of each task.

---

## File Structure

### New files

- `src/domain/outline-assembly/launcher-fit.ts` — fit-offset constants, validation, sign convention, and structured-clone-safe request type.
- `src/export/launcher-fit-coupon.ts` — canonical five-opening calibration coupon and SVG writer.
- `src/export/launcher-fit-coupon.test.ts` — coupon geometry, role, offset, privacy, and determinism tests.

### Existing files to modify

- `src/domain/outline-assembly/launcher-template.ts` — rename the published fixture as the official fixed template and add a stable geometry fingerprint.
- `src/domain/outline-assembly/launcher-template.test.ts` — validate version, fingerprint, numeric-only fixture, and deterministic generation.
- `src/domain/outline-assembly/launcher.ts` — fixed-template placement, deterministic rotation search, fit compensation, and blocking error.
- `src/domain/outline-assembly/launcher.test.ts` — fixed-template, offset, rotation, and structural-conflict tests.
- `src/domain/pipeline/automatic-outline-pipeline.ts` — consume fit offset, stop per-model detection, enforce launcher-first decoration protection, and expose blocking diagnostics.
- `src/domain/pipeline/automatic-outline-pipeline.test.ts` — safe, overlap, impossible, and exactly-once compensation coverage.
- `src/domain/outline-2.5d/extract.ts` — provide bounded provisional decoration evidence to black-cut planning, then perform final extraction with launcher protection.
- `src/domain/outline-2.5d/extract.test.ts` — prove the provisional pass affects rotation but never leaks unprotected decoration into final output.
- `src/domain/outline-features/types.ts` — canonical launcher summary fields and strict result validation.
- `src/domain/outline-features/types.test.ts` — mutation tests for every new launcher field and decoration count.
- `src/export/colored-outline-document.ts` — copy and validate fixed launcher evidence.
- `src/export/colored-outline-document.test.ts` — canonical mutation and top-two-layer reconciliation tests.
- `src/export/outline-package.ts` — include coupon output and reconcile launcher evidence across artifact grammars and ZIP.
- `src/export/outline-package.test.ts` — SVG, DXF, PDF, ZIP, manifest, coupon, and mutation verification.
- `src/export/project-json.ts` — persist the canonical template version, fingerprint, rotation, and fit offset already present in the document without dropping fields.
- `src/workers/geometry-api.ts` — carry fit offset in `AutomaticOutlineRequest` and return coupon bytes in `OutlinePackageTransfer`.
- `src/workers/geometry-client.ts` — validate and clone the fit offset before crossing the worker boundary.
- `src/workers/geometry-api.test.ts` — boundary rejection for non-finite, out-of-range, and wrong-step values.
- `src/workers/geometry.worker.ts` — pass validated fit offset to the automatic pipeline and transfer coupon bytes.
- `src/app/OneClickConverter.tsx` — material-plus-fit form, reset behavior, status rows, coupon download, and stale-download clearing.
- `src/app/OneClickConverter.test.tsx` — form validation, request values, reset, status, failure, and download ownership tests.
- `src/app/apple-workbench.browser.test.tsx` — real browser keyboard and accessible-number-input coverage.
- `src/app/project-store.ts` — add `launcherFitOffsetMm` and `launcherTemplateVersion` settings defaults.
- `src/app/project-store.test.ts` — store defaults, reset, load, and immutable-copy tests.
- `src/persistence/project-repository.ts` — migrate older settings and strictly validate the new fields.
- `src/persistence/project-repository.test.ts` — legacy migration, unavailable-version, and round-trip tests.
- `e2e/happy-path.spec.ts` — assert fixed launcher output, UI evidence, and cross-format counts.
- `e2e/helpers.ts` — parse and compare launcher metadata and coupon ZIP member.

---

### Task 1: Define the Fixed Template and Fit Contract

**Files:**

- Create: `src/domain/outline-assembly/launcher-fit.ts`
- Modify: `src/domain/outline-assembly/launcher-template.ts`
- Test: `src/domain/outline-assembly/launcher-template.test.ts`
- Test: `src/domain/outline-assembly/launcher.test.ts`

**Interfaces:**

- Consumes: existing `LauncherTemplate`, `KNIGHT_FORTRESS_LAUNCHER_TEMPLATE`, `normalizeLauncherLoops()`, and generated numeric loops.
- Produces:

```ts
export const OFFICIAL_THREE_PRONG_TEMPLATE_VERSION = 1 as const;
export const OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT: string;
export const OFFICIAL_THREE_PRONG_TEMPLATE: LauncherTemplate;

export const LAUNCHER_FIT_OFFSET_MIN_MM = -0.20 as const;
export const LAUNCHER_FIT_OFFSET_MAX_MM = 0.20 as const;
export const LAUNCHER_FIT_OFFSET_STEP_MM = 0.01 as const;
export type LauncherFitOffsetMm = number;
export function validateLauncherFitOffsetMm(value: unknown): LauncherFitOffsetMm;
```

- `validateLauncherFitOffsetMm()` rejects non-numbers, non-finite values, values outside the inclusive range, and values not aligned to `0.01 mm` within `1e-9`.
- The fingerprint is a deterministic lowercase 32-hex hash of `{ version, loops }`; provenance hashes are not part of public evidence.

- [ ] **Step 1: Write failing fit-contract and fixed-template tests**

Add focused tests:

```ts
import {
  LAUNCHER_FIT_OFFSET_MAX_MM,
  LAUNCHER_FIT_OFFSET_MIN_MM,
  validateLauncherFitOffsetMm,
} from './launcher-fit';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE,
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from './launcher-template';

it.each([-0.20, -0.01, 0, 0.01, 0.20])('accepts bounded 0.01 mm fit offset %s', (value) => {
  expect(validateLauncherFitOffsetMm(value)).toBe(value);
});

it.each([NaN, Infinity, -0.201, 0.201, 0.005, '0.00'])('rejects invalid fit offset %s', (value) => {
  expect(() => validateLauncherFitOffsetMm(value)).toThrow(RangeError);
});

it('publishes one stable numeric-only three-prong template', () => {
  expect(OFFICIAL_THREE_PRONG_TEMPLATE.version).toBe(OFFICIAL_THREE_PRONG_TEMPLATE_VERSION);
  expect(OFFICIAL_THREE_PRONG_TEMPLATE.loops).toHaveLength(3);
  expect(OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.stringify(OFFICIAL_THREE_PRONG_TEMPLATE)).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\\\|\\.stl|@)/i);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run src/domain/outline-assembly/launcher-template.test.ts src/domain/outline-assembly/launcher.test.ts
```

Expected: FAIL because `launcher-fit.ts` and the `OFFICIAL_THREE_PRONG_*` exports do not exist.

- [ ] **Step 3: Implement the fit validator and fixed-template aliases**

Create `launcher-fit.ts`:

```ts
export const LAUNCHER_FIT_OFFSET_MIN_MM = -0.20 as const;
export const LAUNCHER_FIT_OFFSET_MAX_MM = 0.20 as const;
export const LAUNCHER_FIT_OFFSET_STEP_MM = 0.01 as const;
export type LauncherFitOffsetMm = number;

export function validateLauncherFitOffsetMm(value: unknown): LauncherFitOffsetMm {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < LAUNCHER_FIT_OFFSET_MIN_MM - 1e-9
    || value > LAUNCHER_FIT_OFFSET_MAX_MM + 1e-9
    || Math.abs(value / LAUNCHER_FIT_OFFSET_STEP_MM
      - Math.round(value / LAUNCHER_FIT_OFFSET_STEP_MM)) > 1e-9) {
    throw new RangeError('Launcher fit offset must be -0.20 mm to +0.20 mm in 0.01 mm steps');
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
```

In `launcher-template.ts`, retain the generated numeric fixture and expose it under the new contract:

```ts
export const OFFICIAL_THREE_PRONG_TEMPLATE_VERSION = 1 as const;
export const OFFICIAL_THREE_PRONG_TEMPLATE = KNIGHT_FORTRESS_LAUNCHER_TEMPLATE;

function templateFingerprint(template: Pick<LauncherTemplate, 'version' | 'loops'>): string {
  const serialized = JSON.stringify({ version: template.version, loops: template.loops });
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    for (const char of serialized) {
      lanes[lane] = Math.imul(lanes[lane] ^ (char.charCodeAt(0) + lane * 131), 16777619 + lane * 2) >>> 0;
    }
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

export const OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT =
  templateFingerprint(OFFICIAL_THREE_PRONG_TEMPLATE);
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS for both test files.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/domain/outline-assembly/launcher-fit.ts src/domain/outline-assembly/launcher-template.ts src/domain/outline-assembly/launcher-template.test.ts src/domain/outline-assembly/launcher.test.ts
git commit -m "feat: define fixed launcher template contract"
```

---

### Task 2: Replace Optional Detection with Deterministic Fixed-Template Placement

**Files:**

- Modify: `src/domain/outline-assembly/launcher.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Test: `src/domain/outline-assembly/launcher.test.ts`
- Test: `src/domain/pipeline/automatic-outline-pipeline.test.ts`

**Interfaces:**

- Consumes: `OFFICIAL_THREE_PRONG_TEMPLATE`, `validateLauncherFitOffsetMm()`, `simpleMiterPolygonKernel`, existing exterior/central-hole safety functions.
- Produces:

```ts
export type FixedLauncherPlan = {
  readonly status: 'fixed';
  readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour];
  readonly templateVersion: number;
  readonly templateFingerprint: string;
  readonly rotationRad: number;
  readonly fitOffsetMm: number;
  readonly finishedAllowanceMm: number;
};

export type FixedLauncherClearanceRequest = {
  readonly axisPoint: Point2;
  readonly topExterior: FeatureContour;
  readonly secondExterior: FeatureContour;
  readonly topCentralHole?: FeatureContour;
  readonly secondCentralHole?: FeatureContour;
  readonly decorationContours?: readonly FeatureContour[];
  readonly material: Pick<ManufacturingGeometryProfile, 'kerfMm' | 'minWebMm'>;
  readonly fitOffsetMm: number;
  readonly deadline?: number;
  readonly checkpoint?: () => void;
};

export class LauncherCompatibilityError extends RangeError {
  readonly name = 'LauncherCompatibilityError';
  readonly code = 'LAUNCHER_INCOMPATIBLE';
}

export function planFixedLauncherClearance(request: FixedLauncherClearanceRequest): FixedLauncherPlan;
```

- Search rotations `0..119` degrees in one-degree increments.
- Rank safe candidates by greatest minimum structural clearance, then fewest intersections with `decorationContours`, then smallest rotation.
- Finished opening offset is `LAUNCHER_ASSEMBLY_ALLOWANCE_MM + fitOffsetMm`; toolpath then offsets inward by `kerfMm / 2`.
- No omitted plan exists. Invalid template, collapsed contour, or no safe rotation throws `LauncherCompatibilityError`.

- [ ] **Step 1: Write failing planner tests**

Add tests that call `planFixedLauncherClearance()` with rectangular top/second exteriors:

```ts
it('uses the fixed template, applies fit then kerf once, and returns deterministic rotation', () => {
  const first = planFixedLauncherClearance({ ...safeRequest, fitOffsetMm: 0.05 });
  const second = planFixedLauncherClearance({ ...safeRequest, fitOffsetMm: 0.05 });
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    status: 'fixed',
    templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
    fitOffsetMm: 0.05,
  });
  expect(first.cuts).toHaveLength(3);
});

it('blocks instead of omitting the fixed launcher when no rotation is structurally safe', () => {
  expect(() => planFixedLauncherClearance({ ...tooSmallRequest, fitOffsetMm: 0 }))
    .toThrow(LauncherCompatibilityError);
});
```

Update the automatic-pipeline test fixture to pass `launcherFitOffsetMm: 0`, and assert that empty `launcherCandidates` still yields three launcher cuts on only the final two layers.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/domain/outline-assembly/launcher.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts
```

Expected: FAIL because the fixed planner and request field do not exist.

- [ ] **Step 3: Implement deterministic fixed placement**

In `launcher.ts`:

```ts
const LAUNCHER_ROTATION_STEPS = 120;

function rotateLoop(loop: readonly Point2[], rotationRad: number, axis: Point2): readonly Point2[] {
  const cosine = Math.cos(rotationRad), sine = Math.sin(rotationRad);
  return loop.map(([x, y]): Point2 => [
    axis[0] + x * cosine - y * sine,
    axis[1] + x * sine + y * cosine,
  ]);
}

type ScoredFixedLauncherPlan = FixedLauncherPlan & {
  readonly minimumStructuralClearanceMm: number;
  readonly decorationOverlapCount: number;
};

function materializeFixedCuts(
  loops: LauncherLoops,
  request: FixedLauncherClearanceRequest,
  fitOffsetMm: number,
  rotationRad: number,
): ScoredFixedLauncherPlan | undefined;

function withoutPrivatePlacementScore(plan: ScoredFixedLauncherPlan): FixedLauncherPlan {
  const {
    minimumStructuralClearanceMm: _minimumStructuralClearanceMm,
    decorationOverlapCount: _decorationOverlapCount,
    ...publicPlan
  } = plan;
  return publicPlan;
}

export function planFixedLauncherClearance(request: FixedLauncherClearanceRequest): FixedLauncherPlan {
  const fitOffsetMm = validateLauncherFitOffsetMm(request.fitOffsetMm);
  const candidates: ScoredFixedLauncherPlan[] = [];
  for (let step = 0; step < LAUNCHER_ROTATION_STEPS; step += 1) {
    const rotationRad = step * Math.PI / 180;
    const loops = OFFICIAL_THREE_PRONG_TEMPLATE.loops.map(
      (loop) => rotateLoop(loop, rotationRad, request.axisPoint),
    ) as unknown as LauncherLoops;
    const planned = materializeFixedCuts(loops, request, fitOffsetMm, rotationRad);
    if (planned && launcherCutsArePhysicallySafe({
      cuts: planned.cuts,
      top: { exterior: request.topExterior, centralHole: request.topCentralHole },
      second: { exterior: request.secondExterior, centralHole: request.secondCentralHole },
      material: request.material,
      deadline: request.deadline,
      checkpoint: request.checkpoint,
    })) candidates.push(planned);
  }
  const selected: ScoredFixedLauncherPlan | undefined = candidates.sort(
    (left, right) => right.minimumStructuralClearanceMm - left.minimumStructuralClearanceMm
      || left.decorationOverlapCount - right.decorationOverlapCount
      || left.rotationRad - right.rotationRad,
  )[0];
  if (!selected) throw new LauncherCompatibilityError(
    '官方三爪孔會破壞外框或必要承托結構，已停止所有輸出',
  );
  return withoutPrivatePlacementScore(selected);
}
```

Keep `minimumStructuralClearanceMm` private to the search result. Do not serialize it.

In `automatic-outline-pipeline.ts`, remove `detectLauncherTemplate()` from `planAssemblyBlackCuts()` and call:

```ts
const launcher = planFixedLauncherClearance({
  axisPoint: [0, 0],
  topExterior: top.exterior,
  secondExterior: second.exterior,
  topCentralHole: top.centralHole,
  secondCentralHole: second.centralHole,
  material,
  fitOffsetMm: context.launcherFitOffsetMm,
  deadline: context.deadline,
  checkpoint,
});
```

Map `LauncherCompatibilityError` to a new `AutomaticOutlineError` code:

```ts
export type AutomaticOutlineErrorCode =
  | 'INVALID_STL' | 'NO_OUTLINE' | 'RESOURCE_LIMIT' | 'TIME_LIMIT' | 'LAUNCHER_INCOMPATIBLE';
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS, including empty per-model launcher evidence and structurally impossible failure cases.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/domain/outline-assembly/launcher.ts src/domain/outline-assembly/launcher.test.ts src/domain/pipeline/automatic-outline-pipeline.ts src/domain/pipeline/automatic-outline-pipeline.test.ts
git commit -m "feat: require fixed launcher placement"
```

---

### Task 3: Make Decoration Yield and Extend Canonical Assembly Evidence

**Files:**

- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/domain/outline-2.5d/extract.ts`
- Modify: `src/domain/outline-features/types.ts`
- Modify: `src/export/colored-outline-document.ts`
- Test: `src/domain/pipeline/automatic-outline-pipeline.test.ts`
- Test: `src/domain/outline-2.5d/extract.test.ts`
- Test: `src/domain/outline-features/types.test.ts`
- Test: `src/export/colored-outline-document.test.ts`

**Interfaces:**

- Consumes: `FixedLauncherPlan`, bounded provisional depth features, final top-two-layer launcher cuts, existing depth-feature validation.
- Produces:

```ts
export type AutomaticLauncherAssembly = {
  readonly status: 'fixed';
  readonly cutCount: 3;
  readonly templateVersion: number;
  readonly templateFingerprint: string;
  readonly rotationRad: number;
  readonly fitOffsetMm: number;
  readonly finishedAllowanceMm: number;
};

export type AutomaticTopFeatureAssembly = {
  readonly retained: { readonly red: number; readonly blue: number };
  readonly omitted: { readonly red: number; readonly blue: number };
  readonly launcherOverlap: {
    readonly clipped: { readonly red: number; readonly blue: number };
    readonly removed: { readonly red: number; readonly blue: number };
  };
};
```

- `AutomaticOutlineAssembly.launcher` becomes `AutomaticLauncherAssembly`; remove `detected`, `fallback`, and `omitted`.
- Decoration difference uses the finished launcher removal envelope, not the kerf-center toolpath.

- [ ] **Step 1: Write failing priority and mutation tests**

Add a pipeline case with one red contour partly overlapping a launcher envelope and one blue contour wholly inside it:

```ts
expect(result.assembly.topFeatures.launcherOverlap).toEqual({
  clipped: { red: 1, blue: 0 },
  removed: { red: 0, blue: 1 },
});
expect(result.coloredLayers.at(-1)!.deepFeatures).toHaveLength(1);
expect(result.coloredLayers.at(-1)!.lightFeatures).toHaveLength(0);
```

In `types.test.ts` and `colored-outline-document.test.ts`, mutate each of:

```ts
templateVersion
templateFingerprint
rotationRad
fitOffsetMm
finishedAllowanceMm
launcherOverlap.clipped.red
launcherOverlap.clipped.blue
launcherOverlap.removed.red
launcherOverlap.removed.blue
```

and expect strict validation or canonical reconciliation to throw.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/domain/pipeline/automatic-outline-pipeline.test.ts src/domain/outline-features/types.test.ts src/export/colored-outline-document.test.ts
```

Expected: FAIL because the new summary fields and launcher-priority clipping do not exist.

- [ ] **Step 3: Implement launcher-protected decoration filtering**

In `extract.ts`, split depth extraction into two bounded passes:

1. a provisional pass protected by exterior and central-hole geometry only;
2. black-cut planning that receives the provisional top-two-layer red/blue contours as `decorationContours`; and
3. the existing final pass protected by launcher and fastener removal envelopes.

The provisional pass is private planning evidence. It is never returned, fingerprinted, previewed, persisted, or exported. Both passes share the existing absolute deadline and checkpoint budget.

Before final `colorizeExteriorLayers()` output is fingerprinted, compare provisional features with the final launcher-protected features and return explicit decisions:

```ts
type LauncherDecorationDecision = {
  readonly deepFeatures: readonly FeatureContour[];
  readonly lightFeatures: readonly FeatureContour[];
  readonly clipped: { readonly red: number; readonly blue: number };
  readonly removed: { readonly red: number; readonly blue: number };
};

function protectLauncherFromDecoration(
  layer: ColoredOutlineLayer,
  finishedLauncherEnvelopes: readonly FeatureContour[],
  deadline: number,
  checkpoint: () => void,
): LauncherDecorationDecision;
```

For each feature, use the existing polygon boolean/difference boundary. Keep every valid, finite, strictly contained remainder above the existing minimum feature area. Count one source contour as `clipped` when at least one valid remainder survives; count it as `removed` when none survives. Re-run existing feature validation on every remainder.

Replace the assembly copy in `colored-outline-document.ts` with exact new fields:

```ts
launcher: {
  status: 'fixed',
  cutCount: 3,
  templateVersion: assembly.launcher.templateVersion,
  templateFingerprint: assembly.launcher.templateFingerprint,
  rotationRad: assembly.launcher.rotationRad,
  fitOffsetMm: assembly.launcher.fitOffsetMm,
  finishedAllowanceMm: assembly.launcher.finishedAllowanceMm,
},
topFeatures: {
  retained: { ...assembly.topFeatures.retained },
  omitted: { ...assembly.topFeatures.omitted },
  launcherOverlap: {
    clipped: { ...assembly.topFeatures.launcherOverlap.clipped },
    removed: { ...assembly.topFeatures.launcherOverlap.removed },
  },
},
```

Update `validateAutomaticColoredResult()` and `assertCanonicalShape()` to require:

```ts
launcher.status === 'fixed'
launcher.cutCount === 3
launcher.templateVersion === OFFICIAL_THREE_PRONG_TEMPLATE_VERSION
launcher.templateFingerprint === OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT
validateLauncherFitOffsetMm(launcher.fitOffsetMm)
Number.isFinite(launcher.rotationRad) && launcher.rotationRad >= 0 && launcher.rotationRad < Math.PI * 2
launcher.finishedAllowanceMm === LAUNCHER_ASSEMBLY_ALLOWANCE_MM + launcher.fitOffsetMm
```

Also require exactly three launcher cuts on each of the final two layers and zero on every earlier layer.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS for priority, strict-field mutation, layer cardinality, and canonical copy tests.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/domain/pipeline/automatic-outline-pipeline.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/domain/outline-2.5d/extract.ts src/domain/outline-2.5d/extract.test.ts src/domain/outline-features/types.ts src/domain/outline-features/types.test.ts src/export/colored-outline-document.ts src/export/colored-outline-document.test.ts
git commit -m "feat: prioritize launcher geometry in canonical output"
```

---

### Task 4: Carry Fit Evidence Across the Worker Boundary

**Files:**

- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry-client.ts`
- Modify: `src/workers/geometry.worker.ts`
- Test: `src/workers/geometry-api.test.ts`
- Test: `src/workers/geometry-client.test.ts`

**Interfaces:**

- Consumes: `validateLauncherFitOffsetMm()`.
- Produces:

```ts
export type AutomaticOutlineRequest = {
  readonly bytes: ArrayBuffer;
  readonly material: ManufacturingGeometryProfile;
  readonly launcherFitOffsetMm: number;
};
```

- `GeometryApi.convertAutomatically()` keeps the same method name and receives the expanded request.

- [ ] **Step 1: Write failing boundary tests**

Add:

```ts
it.each([NaN, Infinity, -0.21, 0.21, 0.005])('rejects fit offset %s before worker dispatch', async (value) => {
  await expect(client.convertAutomatically({
    bytes: safeStl,
    material: readyMaterial,
    launcherFitOffsetMm: value,
  })).rejects.toThrow(RangeError);
  expect(api.convertAutomatically).not.toHaveBeenCalled();
});

it('passes a normalized fit offset without mutating the caller request', async () => {
  const request = { bytes: safeStl, material: readyMaterial, launcherFitOffsetMm: -0 };
  await client.convertAutomatically(request);
  expect(api.convertAutomatically).toHaveBeenCalledWith(
    expect.objectContaining({ launcherFitOffsetMm: 0 }),
    expect.anything(),
  );
  expect(Object.is(request.launcherFitOffsetMm, -0)).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/workers/geometry-api.test.ts src/workers/geometry-client.test.ts
```

Expected: FAIL because the request boundary does not validate the new field.

- [ ] **Step 3: Validate and clone at both boundaries**

In `geometry-client.ts`:

```ts
const validatedRequest: AutomaticOutlineRequest = {
  ...request,
  material: validateManufacturingGeometryProfile(request.material),
  launcherFitOffsetMm: validateLauncherFitOffsetMm(request.launcherFitOffsetMm),
};
```

In `geometry.worker.ts`, construct the pipeline request explicitly:

```ts
return convertAutomatically({
  bytes: request.bytes,
  material: validateManufacturingGeometryProfile(request.material),
  launcherFitOffsetMm: validateLauncherFitOffsetMm(request.launcherFitOffsetMm),
}, progress);
```

Do not add template loops to the structured-clone request; the worker imports the fixed fixture by version.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS, with invalid values rejected before remote execution.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/domain/pipeline/automatic-outline-pipeline.ts src/workers/geometry-api.ts src/workers/geometry-client.ts src/workers/geometry.worker.ts src/workers/geometry-api.test.ts src/workers/geometry-client.test.ts
git commit -m "feat: carry launcher fit through worker boundary"
```

---

### Task 5: Add the Calibration Coupon and Artifact Reconciliation

**Files:**

- Create: `src/export/launcher-fit-coupon.ts`
- Create: `src/export/launcher-fit-coupon.test.ts`
- Modify: `src/export/outline-package.ts`
- Modify: `src/export/outline-package.test.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `e2e/helpers.ts`

**Interfaces:**

- Consumes: fixed template, selected material kerf, `validateLauncherFitOffsetMm()`, SVG escaping/privacy helpers.
- Produces:

```ts
export const LAUNCHER_COUPON_OFFSETS_MM = [-0.10, -0.05, 0, 0.05, 0.10] as const;

export type LauncherFitCoupon = {
  readonly templateVersion: number;
  readonly templateFingerprint: string;
  readonly materialId: string;
  readonly kerfMm: number;
  readonly openings: readonly {
    readonly fitOffsetMm: number;
    readonly cuts: readonly [FeatureContour, FeatureContour, FeatureContour];
    readonly label: string;
  }[];
};

export function createLauncherFitCoupon(
  material: ManufacturingGeometryProfile,
  deadline?: number,
): LauncherFitCoupon;

export function writeLauncherFitCouponSvg(coupon: LauncherFitCoupon): string;
```

- Extend `OutlinePackageTransfer` and UI downloads with:

```ts
readonly launcherCouponSvg: string;
```

- Add `launcher-fit-coupon.svg` to the ZIP. The ZIP then contains the existing four fabrication artifacts plus this calibration SVG; `project.json` and `manifest.json` remain verification metadata where already present.

- [ ] **Step 1: Write failing coupon and package tests**

```ts
it('creates five labelled openings from the fixed template and selected kerf', () => {
  const coupon = createLauncherFitCoupon(readyMaterial);
  expect(coupon.openings.map(({ fitOffsetMm }) => fitOffsetMm))
    .toEqual([-0.10, -0.05, 0, 0.05, 0.10]);
  expect(coupon.openings.every(({ cuts }) => cuts.length === 3)).toBe(true);
  expect(coupon.templateFingerprint).toBe(OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT);
  expect(writeLauncherFitCouponSvg(coupon)).toContain('data-template-version="1"');
});
```

Extend ZIP verification to require exact byte identity for `launcher-fit-coupon.svg`. Mutate one coupon path, label, fit offset, template fingerprint, material ID, or kerf value and expect `verifyColoredOutlinePackage()` to reject it.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/export/launcher-fit-coupon.test.ts src/export/outline-package.test.ts
```

Expected: FAIL because coupon generation and the new payload do not exist.

- [ ] **Step 3: Implement canonical coupon generation**

Build each opening by applying:

```ts
const finishedOffsetMm = LAUNCHER_ASSEMBLY_ALLOWANCE_MM + fitOffsetMm;
const toolpathOffsetMm = finishedOffsetMm - material.kerfMm / 2;
```

to the fixed template exactly once. Lay openings left-to-right with a deterministic margin derived from their bounds. Emit cut paths as black `CUT_BLACK` and labels as red engraving text converted through the existing safe SVG text path; labels must be exactly `-0.10 mm`, `-0.05 mm`, `0.00 mm`, `+0.05 mm`, and `+0.10 mm`.

In `outline-package.ts`:

```ts
const launcherCoupon = createLauncherFitCoupon(result.assembly.material, deadline);
const launcherCouponSvg = writeLauncherFitCouponSvg(launcherCoupon);
zip.file('launcher-fit-coupon.svg', launcherCouponSvg);
```

Add coupon metadata to the manifest:

```ts
launcherCoupon: {
  path: 'launcher-fit-coupon.svg',
  templateVersion: launcherCoupon.templateVersion,
  templateFingerprint: launcherCoupon.templateFingerprint,
  materialId: launcherCoupon.materialId,
  kerfMm: launcherCoupon.kerfMm,
  offsetsMm: LAUNCHER_COUPON_OFFSETS_MM,
}
```

Verify the complete SVG grammar, exact role colors, all 15 cut contours, five labels, metadata equality, ZIP byte identity, and EOF/full-token rules already used by package validation.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS for coupon geometry and package mutation tests.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/export/launcher-fit-coupon.ts src/export/launcher-fit-coupon.test.ts src/export/outline-package.ts src/export/outline-package.test.ts src/workers/geometry-api.ts src/workers/geometry.worker.ts e2e/helpers.ts
git commit -m "feat: add launcher fit calibration coupon"
```

---

### Task 6: Add the Material-and-Fit UI, Status, Reset, and Downloads

**Files:**

- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/apple-workbench.browser.test.tsx`
- Modify: `src/styles.css` only if the existing material-card layout cannot contain the extra labelled input without overflow.

**Interfaces:**

- Consumes: `validateLauncherFitOffsetMm()`, expanded `AutomaticOutlineRequest`, launcher assembly evidence, `launcherCouponSvg`.
- Produces: accessible `三爪配合微調` number input and a `下載三爪尺寸測試片` link.
- Change `OneClickConverterServices.convert` to:

```ts
readonly convert: (
  bytes: ArrayBuffer,
  material: ManufacturingGeometryProfile,
  launcherFitOffsetMm: number,
  onProgress?: (event: AutomaticOutlineProgressEvent) => void | Promise<void>,
) => Promise<AutomaticOutlineResult>;
```

- [ ] **Step 1: Write failing component and browser tests**

Component tests:

```ts
expect(screen.getByLabelText('三爪配合微調')).toHaveValue(0);
await user.clear(screen.getByLabelText('三爪配合微調'));
await user.type(screen.getByLabelText('三爪配合微調'), '0.05');
await user.selectOptions(screen.getByLabelText('選擇製作材料'), 'plywood-3');
expect(services.convert).toHaveBeenCalledWith(
  expect.any(ArrayBuffer),
  expect.objectContaining({ id: 'plywood-3' }),
  0.05,
  expect.any(Function),
);
```

Add invalid-value cases for `0.205`, `Infinity`, and pasted text. Assert material selection cannot start conversion while the input is invalid.

Upload a second model and assert the material picker returns to its placeholder and fit input returns to `0.00`.

Result tests assert:

```ts
screen.getByText('官方三爪孔：已加入頂部兩層')
screen.getByText(/模板版本 1/)
screen.getByText(/配合微調 \\+0\\.05 mm/)
screen.getByText(/已裁切紅色 1/)
screen.getByText('依 Knight Fortress 樣本建立，待官方發射器實物校準')
screen.getByRole('link', { name: '下載三爪尺寸測試片' })
```

Failure tests make `convert()` reject with `LauncherCompatibilityError` serialized as `LAUNCHER_INCOMPATIBLE`, then assert no download links exist and the structural-conflict message is announced.

- [ ] **Step 2: Run focused component tests and confirm RED**

```bash
npx vitest run src/app/OneClickConverter.test.tsx
npx vitest --config vitest.browser.config.ts run src/app/apple-workbench.browser.test.tsx
```

Expected: FAIL because the fit input, service argument, status copy, and coupon link do not exist.

- [ ] **Step 3: Implement the controlled fit input and reset**

Add state:

```ts
const [launcherFitInput, setLauncherFitInput] = useState('0.00');

function parsedLauncherFitOffset(value: string): number | undefined {
  const numeric = Number(value);
  try { return validateLauncherFitOffsetMm(numeric); }
  catch { return undefined; }
}
```

Render before the material selector:

```tsx
<label className="material-picker">
  三爪配合微調
  <input
    aria-describedby="launcher-fit-help launcher-fit-error"
    type="number"
    min="-0.20"
    max="0.20"
    step="0.01"
    value={launcherFitInput}
    onChange={(event) => setLauncherFitInput(event.target.value)}
  />
</label>
<p id="launcher-fit-help">正數較鬆，負數較緊；可調 -0.20 至 +0.20 mm。</p>
{parsedLauncherFitOffset(launcherFitInput) === undefined && (
  <p id="launcher-fit-error" role="alert">請輸入 -0.20 至 +0.20 mm，步進 0.01 mm。</p>
)}
```

`selectMaterial()` validates the current fit value and calls:

```ts
void processFile(view.fileName, view.bytes, material, fitOffsetMm);
```

`selectFile()` and `reset()` both call `setLauncherFitInput('0.00')` before showing the next state. They already revoke owned Object URLs; extend `OutlineDownloads` so the coupon URL is revoked by the same `Object.values(downloads)` loop.

Map `LAUNCHER_INCOMPATIBLE` to:

```ts
'官方三爪孔會破壞外框或必要承托結構，已停止所有輸出。'
```

Status rows read only from `result.assembly`; do not infer successful compatibility from visible contours.

- [ ] **Step 4: Run component and browser tests and confirm GREEN**

Run the commands from Step 2.

Expected: PASS with keyboard, validation, reset, status, failure, and URL revocation coverage.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx src/app/apple-workbench.browser.test.tsx src/styles.css
git commit -m "feat: add launcher fit controls and status"
```

---

### Task 7: Persist Fit and Template Version with Safe Migration

**Files:**

- Modify: `src/app/project-store.ts`
- Modify: `src/app/project-store.test.ts`
- Modify: `src/persistence/project-repository.ts`
- Modify: `src/persistence/project-repository.test.ts`

**Interfaces:**

- Consumes: `OFFICIAL_THREE_PRONG_TEMPLATE_VERSION`, `validateLauncherFitOffsetMm()`.
- Produces new `WizardSettings` fields:

```ts
readonly launcherFitOffsetMm: number;
readonly launcherTemplateVersion: number;
```

- Legacy stored settings without these fields migrate to `0.00` and the current template version.
- A stored non-current template version remains readable for inspection but resumes at the import step and cannot export until regeneration.

- [ ] **Step 1: Write failing store and repository tests**

```ts
it('defaults launcher settings and preserves them through immutable load', () => {
  const store = createProjectStore();
  expect(store.getState().settings).toMatchObject({
    launcherFitOffsetMm: 0,
    launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
  });
});

it('migrates legacy settings to the current fixed template and zero fit', async () => {
  await database.projects.put(legacyStoredProjectWithoutLauncherFields);
  const loaded = await repository.get(legacyStoredProjectWithoutLauncherFields.id);
  expect(loaded!.settings).toMatchObject({
    launcherFitOffsetMm: 0,
    launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
  });
});

it('downgrades unavailable template versions to import without silently replacing them', async () => {
  await database.projects.put(storedProject({ launcherTemplateVersion: 999 }));
  const loaded = await repository.get('project');
  expect(loaded).toMatchObject({ step: 'import', axis: undefined });
  expect(loaded!.settings.launcherTemplateVersion).toBe(999);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npx vitest run src/app/project-store.test.ts src/persistence/project-repository.test.ts
```

Expected: FAIL because settings schemas and migration do not include launcher fields.

- [ ] **Step 3: Implement strict current schema plus legacy migration**

Define:

```ts
const LegacySettingsSchema = z.object({
  splitPositionPercent: z.number().finite().min(10).max(90),
  ribCount: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
  ringLayers: z.number().int().min(1).max(24),
  shaftMm: z.number().finite().positive(),
  fit: z.enum(['loose', 'slip', 'snug', 'press']),
  materialId: z.string().trim().min(1).max(500),
  engravingLevels: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  textureStrength: z.number().finite().min(0).max(1),
  sheetWidthMm: z.number().finite().positive(),
  sheetHeightMm: z.number().finite().positive(),
}).strict();
const SettingsSchema = LegacySettingsSchema.extend({
  launcherFitOffsetMm: z.number().transform((value, context) => {
    try { return validateLauncherFitOffsetMm(value); }
    catch {
      context.addIssue({ code: 'custom', message: 'Invalid launcher fit offset' });
      return z.NEVER;
    }
  }),
  launcherTemplateVersion: z.number().int().positive(),
}).strict();
```

Parse stored data with a union. For the legacy branch, append current defaults. For a non-current template version, preserve the version but return:

```ts
{ ...parsed, step: 'import', axis: undefined }
```

Do not silently rewrite stored records during `get()` or `list()`; the migrated copy is written only on the next explicit save/autosave.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS for defaults, legacy migration, strict invalid offset rejection, unavailable version behavior, and round-trip cloning.

- [ ] **Step 5: Commit after explicit authorization**

```bash
git add src/app/project-store.ts src/app/project-store.test.ts src/persistence/project-repository.ts src/persistence/project-repository.test.ts
git commit -m "feat: persist launcher fit calibration"
```

---

### Task 8: End-to-End Artifact and Release Verification

**Files:**

- Modify: `e2e/helpers.ts`
- Modify: `e2e/happy-path.spec.ts`
- Modify: `src/test/launcher-runtime-validation.test.ts`
- Modify: `src/test/validate-fixtures-release.test.ts`
- Modify: `src/export/real-fixtures.integration.test.ts`

**Interfaces:**

- Consumes: final UI, worker, canonical document, output package, two Knight STL fixtures, coupon parser.
- Produces no new production API; this task proves the acceptance contract.

- [ ] **Step 1: Add failing E2E assertions**

Extend runtime parsing:

```ts
expect(runtime.assembly.launcher).toMatchObject({
  status: 'fixed',
  cutCount: 3,
  templateVersion: 1,
  templateFingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
  fitOffsetMm: 0,
});

expect(runtime.layers.slice(0, -2).every((layer) => layer.launcherCuts.length === 0)).toBe(true);
expect(runtime.layers.slice(-2).every((layer) => layer.launcherCuts.length === 3)).toBe(true);
expect(runtime.layers.at(-1)!.launcherCuts.map(({ outer }) => outer))
  .toEqual(runtime.layers.at(-2)!.launcherCuts.map(({ outer }) => outer));
```

For SVG, DXF, PDFs, project JSON, manifest, and ZIP, compare the template evidence and transformed contour fingerprints. Assert `launcher-fit-coupon.svg` has 15 black cut contours and five labels.

Add a structurally impossible synthetic STL fixture and assert the UI shows the blocking message and exposes zero download links.

- [ ] **Step 2: Run the focused release tests and confirm RED**

```bash
npx vitest run src/test/launcher-runtime-validation.test.ts src/export/real-fixtures.integration.test.ts src/test/validate-fixtures-release.test.ts
npx playwright test e2e/happy-path.spec.ts --workers=1
```

Expected: FAIL until helpers and all final artifact contracts recognize fixed launcher evidence and the coupon.

- [ ] **Step 3: Complete parsers and mutation coverage**

Update `e2e/helpers.ts` so `assertColoredArtifactParity()`:

1. fully parses each grammar;
2. extracts only canonical `CUT_BLACK` launcher entities by layer and ID;
3. consumes the complete file with no root-external SVG nodes, DXF section-external entities, PDF hidden/unreferenced streams, or bytes after EOF;
4. compares transformed point fingerprints to project JSON;
5. checks manifest/template/fit/material evidence;
6. checks ZIP byte identity for every member; and
7. rejects mutations to geometry, metadata, labels, layer assignment, role, color, or trailing content.

- [ ] **Step 4: Run the full proportional verification suite**

Run serially:

```bash
npm test -- --maxWorkers=1
npm run test:browser -- --maxWorkers=1
npm run test:e2e -- --workers=1
npm run build
```

Expected:

- every command exits `0`;
- no test failure;
- only the repository's documented intentional skips remain;
- both Knight Fortress real-fixture cases pass;
- the structurally impossible case blocks all downloads;
- build emits no TypeScript or Vite error.

- [ ] **Step 5: Inspect the actual built UI**

Start:

```bash
npm run dev -- --host 127.0.0.1
```

Using the browser, verify:

- material and fit controls are labelled and keyboard operable;
- `0.00 mm` is the default;
- the top two preview layers show three black launcher contours;
- result status reports fixed template version, kerf, fit offset, and affected decoration counts;
- all six downloads work: ZIP, SVG, DXF, both PDFs, and the separate calibration coupon;
- a second model resets material and fit;
- an incompatible model shows no download controls.

- [ ] **Step 6: Record the physical acceptance gate**

Cut the five-opening coupon in a supported 3 mm material using its measured kerf. Record outside the public artifact:

```text
template version:
template fingerprint:
material:
measured kerf:
selected fit offset:
three-prong latch/release result:
rotational play result:
cracking/local thinning result:
```

Until an official launcher passes latch, repeated release, play, and damage checks, keep the UI copy `依 Knight Fortress 樣本建立，待官方發射器實物校準`. Promotion requires a new template version or an evidence-only status change that does not alter the existing geometry fingerprint.

- [ ] **Step 7: Commit after explicit authorization**

```bash
git add e2e/helpers.ts e2e/happy-path.spec.ts src/test/launcher-runtime-validation.test.ts src/test/validate-fixtures-release.test.ts src/export/real-fixtures.integration.test.ts
git commit -m "test: verify fixed launcher artifacts end to end"
```

---

## Final Review Gate

Before claiming completion:

- invoke `superpowers:verification-before-completion`;
- run the four commands from Task 8 Step 4 again against the final working tree;
- record exact pass/fail/skip counts and build status;
- run `git status --short` and confirm the four pre-existing untracked STL/ZIP paths were preserved;
- inspect `git diff --check`;
- request a code review with `superpowers:requesting-code-review`;
- resolve every blocking finding and rerun affected tests;
- do not merge, push, or delete a worktree without a separate user instruction.
