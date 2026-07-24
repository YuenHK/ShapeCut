# Geometry-Estimate Materials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh ShapeCut installation immediately offer five clearly labelled, geometry-only material estimates while preserving the safety gate for saved profiles.

**Architecture:** Add an immutable domain catalogue containing only `ManufacturingGeometryProfile` values, with no recipe or calibration fields. The one-click UI will merge that catalogue with readiness-approved stored profiles, letting an approved stored profile replace an estimate with the same ID while continuing to hide pending and blocked profiles.

**Tech Stack:** TypeScript 5.9, React 19, Zod 4, Vitest 3, Testing Library, Vite

## Global Constraints

- Offer exactly: 3 mm plywood, 5 mm plywood, 3 mm cast acrylic, 5 mm cast acrylic, and 2 mm cardboard.
- Every built-in option must visibly say `幾何估算` and show its nominal thickness.
- Built-in estimates contain geometry values only; they must never contain or imply laser power, speed, pass count, recipes, calibration, operator approval, verification, or production readiness.
- Stored profiles remain selectable only when `classifyMaterialReadiness(profile).status === 'ready'`.
- A ready stored profile with the same ID replaces the built-in estimate.
- Pending, blocked, and forbidden stored material identities remain unavailable.
- Replacing the STL resets material selection.
- Do not change slicing, launcher, fastener, export, worker, or artifact behaviour.

---

## File Structure

- Create `src/domain/materials/geometry-estimates.ts`: immutable geometry-only catalogue and lookup IDs.
- Create `src/domain/materials/geometry-estimates.test.ts`: exact catalogue, schema, value, and forbidden-field contract tests.
- Modify `src/app/OneClickConverter.tsx`: merge estimates with ready stored profiles and render them in the existing selector.
- Modify `src/app/OneClickConverter.test.tsx`: fresh-install, selection, precedence, safety-gate, and model-reset UI tests.

### Task 1: Geometry-Only Estimate Catalogue

**Files:**
- Create: `src/domain/materials/geometry-estimates.ts`
- Create: `src/domain/materials/geometry-estimates.test.ts`

**Interfaces:**
- Consumes: `validateManufacturingGeometryProfile(value: unknown): ManufacturingGeometryProfile`
- Produces: `GEOMETRY_ESTIMATE_MATERIALS: readonly ManufacturingGeometryProfile[]`
- Produces: stable IDs `plywood-3`, `plywood-5`, `acrylic-3`, `acrylic-5`, and `cardboard-2`

- [ ] **Step 1: Write the failing catalogue contract tests**

```ts
import { describe, expect, it } from 'vitest';
import { validateManufacturingGeometryProfile } from './manufacturing-profile';
import { GEOMETRY_ESTIMATE_MATERIALS } from './geometry-estimates';

describe('GEOMETRY_ESTIMATE_MATERIALS', () => {
  it('contains exactly the five approved geometry estimates in display order', () => {
    expect(GEOMETRY_ESTIMATE_MATERIALS.map(({ id, name, thicknessMm }) => ({
      id, name, thicknessMm,
    }))).toEqual([
      { id: 'plywood-3', name: '木夾板（幾何估算）', thicknessMm: 3 },
      { id: 'plywood-5', name: '木夾板（幾何估算）', thicknessMm: 5 },
      { id: 'acrylic-3', name: '鑄造壓克力（幾何估算）', thicknessMm: 3 },
      { id: 'acrylic-5', name: '鑄造壓克力（幾何估算）', thicknessMm: 5 },
      { id: 'cardboard-2', name: '紙板（幾何估算）', thicknessMm: 2 },
    ]);
  });

  it('contains only valid geometry fields and no process or approval evidence', () => {
    for (const profile of GEOMETRY_ESTIMATE_MATERIALS) {
      expect(validateManufacturingGeometryProfile(profile)).toEqual(profile);
      expect(Object.keys(profile).sort()).toEqual([
        'fitAllowanceMm', 'id', 'kerfMm', 'minFeatureMm',
        'minWebMm', 'name', 'thicknessMm',
      ]);
      expect(JSON.stringify(profile)).not.toMatch(
        /power|speed|passes|recipe|calibrat|operator|approv|verified/i,
      );
    }
  });

  it('uses the approved conservative geometry values', () => {
    expect(GEOMETRY_ESTIMATE_MATERIALS).toEqual([
      expect.objectContaining({ id: 'plywood-3', thicknessMm: 3, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'plywood-5', thicknessMm: 5, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'acrylic-3', thicknessMm: 3, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'acrylic-5', thicknessMm: 5, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
      expect.objectContaining({ id: 'cardboard-2', thicknessMm: 2, kerfMm: 0.15, minFeatureMm: 0.8, minWebMm: 0.4 }),
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx vitest run src/domain/materials/geometry-estimates.test.ts
```

Expected: FAIL because `./geometry-estimates` does not exist.

- [ ] **Step 3: Implement the immutable geometry-only catalogue**

```ts
import {
  validateManufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from './manufacturing-profile';

const FIT_ALLOWANCE_MM = Object.freeze({
  loose: 0.2,
  slip: 0.12,
  snug: 0.06,
  press: 0,
});

function estimate(
  id: string,
  name: string,
  thicknessMm: number,
): ManufacturingGeometryProfile {
  return Object.freeze(validateManufacturingGeometryProfile({
    id,
    name,
    thicknessMm,
    kerfMm: 0.15,
    minFeatureMm: 0.8,
    minWebMm: 0.4,
    fitAllowanceMm: FIT_ALLOWANCE_MM,
  }));
}

export const GEOMETRY_ESTIMATE_MATERIALS: readonly ManufacturingGeometryProfile[] =
  Object.freeze([
    estimate('plywood-3', '木夾板（幾何估算）', 3),
    estimate('plywood-5', '木夾板（幾何估算）', 5),
    estimate('acrylic-3', '鑄造壓克力（幾何估算）', 3),
    estimate('acrylic-5', '鑄造壓克力（幾何估算）', 5),
    estimate('cardboard-2', '紙板（幾何估算）', 2),
  ]);
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npx vitest run src/domain/materials/geometry-estimates.test.ts
npm run typecheck
```

Expected: the new test file passes and TypeScript exits with code 0.

- [ ] **Step 5: Commit the catalogue**

```bash
git add src/domain/materials/geometry-estimates.ts src/domain/materials/geometry-estimates.test.ts
git commit -m "feat: add geometry estimate materials"
```

### Task 2: Safe One-Click Material Selection

**Files:**
- Modify: `src/app/OneClickConverter.tsx:21-96`
- Modify: `src/app/OneClickConverter.test.tsx:1-20,540-670`

**Interfaces:**
- Consumes: `GEOMETRY_ESTIMATE_MATERIALS: readonly ManufacturingGeometryProfile[]`
- Consumes: `classifyMaterialReadiness(profile: unknown): MaterialReadiness`
- Consumes: `manufacturingGeometryProfile(profile: MaterialProfileV1): ManufacturingGeometryProfile`
- Produces: `selectableMaterials(savedProfiles): readonly ManufacturingGeometryProfile[]`, ordered as estimates first and additional ready stored profiles second

- [ ] **Step 1: Write failing fresh-install and exact-selection tests**

Add a test that renders with no stored profiles, uploads an STL, and asserts the exact enabled options:

```ts
it('offers exactly five geometry estimates on a fresh installation', async () => {
  const user = userEvent.setup();
  render(<OneClickConverter services={services({ materialProfiles: [] })} />);

  await user.upload(
    screen.getByLabelText('選擇 STL 模型'),
    new File(['mesh'], 'fresh-install.stl'),
  );

  const picker = await screen.findByLabelText('選擇製作材料');
  expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
    '選擇製作材料',
    '木夾板（幾何估算） (3 mm)',
    '木夾板（幾何估算） (5 mm)',
    '鑄造壓克力（幾何估算） (3 mm)',
    '鑄造壓克力（幾何估算） (5 mm)',
    '紙板（幾何估算） (2 mm)',
  ]);
});

it.each([
  ['plywood-3', 3],
  ['plywood-5', 5],
  ['acrylic-3', 3],
  ['acrylic-5', 5],
] as const)('passes %s with exact thickness %s into conversion', async (id, thicknessMm) => {
  const user = userEvent.setup();
  const api = services({ materialProfiles: [] });
  render(<OneClickConverter services={api} />);
  await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], `${id}.stl`));
  await user.selectOptions(await screen.findByLabelText('選擇製作材料'), id);
  expect(api.convert).toHaveBeenCalledWith(
    expect.any(ArrayBuffer),
    expect.objectContaining({ id, thicknessMm }),
    expect.any(Function),
  );
});
```

Import `within` from `@testing-library/react`.

- [ ] **Step 2: Write failing precedence and safety-gate assertions**

Extend the existing readiness test so the stored ready profile reuses `plywood-3`, then verify it replaces the estimate and blocked/pending profiles remain absent:

```ts
const readyReplacement = {
  ...READY_TEST_MATERIAL,
  id: 'plywood-3',
  materialName: '已校準 3 mm 木夾板',
};
const api = services({
  materialProfiles: [
    defaultPendingMaterialProfile('cardboard-2')!,
    BLOCKED_TEST_MATERIAL,
    readyReplacement,
  ],
});
// After upload:
expect(within(picker).getAllByRole('option', { name: /3 mm 木夾板|木夾板.*3 mm/ })).toHaveLength(1);
expect(screen.getByRole('option', { name: /已校準 3 mm 木夾板/ })).toBeVisible();
expect(screen.queryByRole('option', { name: /pending/i })).toBeNull();
expect(screen.queryByRole('option', { name: /unknown composition/i })).toBeNull();
await user.selectOptions(picker, readyReplacement.id);
expect(api.convert).toHaveBeenCalledWith(
  expect.any(ArrayBuffer),
  manufacturingGeometryProfile(readyReplacement),
  expect.any(Function),
);
```

Keep the existing replacement-file test asserting that the selector returns to `value=""`.

- [ ] **Step 3: Run the focused UI tests and verify they fail**

Run:

```bash
npx vitest run src/app/OneClickConverter.test.tsx
```

Expected: FAIL because a fresh installation still has no selectable profiles and no estimate precedence exists.

- [ ] **Step 4: Implement estimate plus ready-profile merging**

Replace the pending-default import with:

```ts
import { GEOMETRY_ESTIMATE_MATERIALS } from '../domain/materials/geometry-estimates';
```

Replace `selectableMaterials` with:

```ts
function selectableMaterials(
  savedProfiles: readonly MaterialProfileV1[] = [],
): readonly ManufacturingGeometryProfile[] {
  const readyStored = savedProfiles.flatMap((profile) => (
    classifyMaterialReadiness(profile).status === 'ready'
      ? [manufacturingGeometryProfile(profile)]
      : []
  ));
  const readyById = new Map(readyStored.map((profile) => [profile.id, profile]));
  const builtins = GEOMETRY_ESTIMATE_MATERIALS.map(
    (profile) => readyById.get(profile.id) ?? profile,
  );
  const builtinIds = new Set(GEOMETRY_ESTIMATE_MATERIALS.map(({ id }) => id));
  return [
    ...builtins,
    ...readyStored.filter(({ id }) => !builtinIds.has(id)),
  ];
}
```

This preserves the five estimate positions, substitutes a ready stored profile at a matching ID, and appends other ready stored profiles. Pending and blocked profiles never cross `classifyMaterialReadiness`.

- [ ] **Step 5: Run the focused UI tests and typecheck**

Run:

```bash
npx vitest run src/app/OneClickConverter.test.tsx
npm run typecheck
```

Expected: all `OneClickConverter` tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit the selector integration**

```bash
git add src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx
git commit -m "fix: populate one-click material selector"
```

### Task 3: Regression and Browser Verification

**Files:**
- Modify only if a regression exposes a defect in Task 1 or Task 2; keep any correction in those same files and add a focused regression assertion.

**Interfaces:**
- Consumes: the completed catalogue and selector behaviour from Tasks 1 and 2
- Produces: verified unit, type, build, and browser evidence for the material-selection flow

- [ ] **Step 1: Run the complete unit suite**

Run:

```bash
npm test
```

Expected: all unit test files pass, with only previously documented conditional skips.

- [ ] **Step 2: Run production compilation**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite production build both exit with code 0.

- [ ] **Step 3: Run the browser suite**

Run:

```bash
npm run test:browser -- --run
```

Expected: all browser tests pass; the material chooser remains operable in the browser provider.

- [ ] **Step 4: Run the focused one-click end-to-end flow**

Run:

```bash
npx playwright test e2e/one-click-outline.spec.ts
```

Expected: all one-click outline scenarios pass, including upload, material selection, conversion, and downloads.

- [ ] **Step 5: Inspect the local UI**

Start or reuse the Vite server:

```bash
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`, upload a small STL, and verify:

- the selector contains the five approved material estimates;
- the labels include `幾何估算` and thickness;
- selecting 5 mm plywood begins conversion;
- replacing the STL clears the old material selection;
- no power, speed, pass, calibration, approval, or production-ready claim appears.

- [ ] **Step 6: Commit any regression-only correction, otherwise record no new commit**

If Step 1–5 exposed and required a correction:

```bash
git add src/domain/materials/geometry-estimates.ts src/domain/materials/geometry-estimates.test.ts src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx
git commit -m "test: cover geometry estimate material flow"
```

If no correction was required, do not create an empty commit.
