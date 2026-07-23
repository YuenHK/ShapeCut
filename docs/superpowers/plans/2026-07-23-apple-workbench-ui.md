# Apple Workbench UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ShapeCut's current card UI with an Apple-inspired silver-white central workbench, showcase-level truthful 3D effects, responsive fallbacks, and accessible motion adaptation without changing conversion or artifact behavior.

**Architecture:** Keep `OneClickConverter` as the workflow owner and wrap each state in focused workbench presentation components. Resolve one effect level centrally, pass it into the existing preview boundary, and extend the Three.js scene with bounded environment effects that consume preview data only. CSS owns glass materials and responsive layout; a small internal motion primitive provides immediate, interruptible press feedback without adding a framework.

**Tech Stack:** React 19, TypeScript, Three.js, CSS media queries, Vitest, Testing Library, Vitest Browser/Chromium, Playwright.

## Global Constraints

- Do not change mesh repair, feature extraction, launcher clearance, fastener placement, material rules, slicing, packaging, artifact names, or output contents.
- Keep all STL bytes and processing local to the browser.
- Do not add Apple trademarks or imitate macOS window controls.
- Black means cut, red means deep engraving, and blue means light engraving; pair color with labels or geometry roles.
- Desktop/laptop gets the full workbench; mobile gets the same functional flow with fewer effects and vertically docked controls.
- `prefers-reduced-motion: reduce` selects static effects; `prefers-reduced-transparency: reduce` removes glass blur; `prefers-contrast: more` strengthens surfaces and borders.
- WebGL failure must fall back to the existing SVG/CSS presentation and must never block conversion or downloads.
- Continuous motion pauses while the page is hidden and all scene resources must be disposed.
- Do not add Motion or Framer Motion. Use an internal spring/press primitive and existing Three.js animation loop.

---

## File Structure

**Create**

- `src/app/effect-level.ts` — capability/accessibility resolution and stable full/energy-saving/static contract.
- `src/app/effect-level.test.ts` — deterministic resolver and media-query hook coverage.
- `src/app/AppleWorkbench.tsx` — central stage, floating chrome, workflow mapping, and environmental CSS layers.
- `src/app/AppleWorkbench.test.tsx` — workbench semantics and state mapping.
- `src/app/MotionSurface.tsx` — pointer-down/keyboard press feedback with interruptible current-value spring.
- `src/app/MotionSurface.test.tsx` — press, cancellation, keyboard, reduced-motion, and cleanup tests.
- `src/app/apple-workbench.browser.test.tsx` — real-browser accessibility/media/fallback checks.

**Modify**

- `src/app/App.tsx` — floating ShapeCut chrome and global workbench shell.
- `src/app/App.test.tsx` — shell privacy and wayfinding coverage.
- `src/app/OneClickConverter.tsx` — render workflow content through `AppleWorkbench`, add drag-state presentation, and pass effect level to viewports.
- `src/app/OneClickConverter.test.tsx` — every workflow state's workbench contract and interruption behavior.
- `src/preview/OutlineProcessViewport.tsx` — consume effect level and expose fallback/effect attributes.
- `src/preview/OutlineProcessViewport.test.tsx` — effect propagation and fallback tests.
- `src/preview/OutlineProcessViewport.browser.test.tsx` — real WebGL downgrade and reduced-motion checks.
- `src/preview/outline-process-scene.ts` — bounded platform, particles, glow/trace presentation, and effect-level scene control.
- `src/preview/outline-process-scene.test.ts` — scene budgets, stage choreography, visibility, effect downgrade, and disposal.
- `src/styles.css` — design tokens, workbench layout, glass materials, state themes, responsive and accessibility media queries.
- `e2e/one-click-outline.spec.ts` — preserve one-click behavior while checking visible workbench state if this is the existing primary flow file; otherwise add the assertions to the current equivalent one-click spec found with `rg -n "下載 ZIP 製作套件" e2e`.

---

### Task 1: Effect-Level Contract

**Files:**
- Create: `src/app/effect-level.ts`
- Create: `src/app/effect-level.test.ts`

**Interfaces:**
- Produces: `type EffectLevel = 'full' | 'energy-saving' | 'static'`
- Produces: `resolveEffectLevel(signals: EffectSignals): EffectLevel`
- Produces: `useEffectLevel(): EffectLevel`
- Consumed by: `AppleWorkbench`, `OneClickConverter`, and `OutlineProcessViewport`.

- [ ] **Step 1: Write resolver tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveEffectLevel } from './effect-level';

describe('resolveEffectLevel', () => {
  it('makes reduced motion authoritative', () => {
    expect(resolveEffectLevel({ reducedMotion: true, coarsePointer: false, hardwareConcurrency: 16, webgl: true })).toBe('static');
  });

  it('uses energy-saving for constrained capability', () => {
    expect(resolveEffectLevel({ reducedMotion: false, coarsePointer: true, hardwareConcurrency: 4, webgl: true })).toBe('energy-saving');
  });

  it('uses full only for capable WebGL presentation', () => {
    expect(resolveEffectLevel({ reducedMotion: false, coarsePointer: false, hardwareConcurrency: 8, webgl: true })).toBe('full');
    expect(resolveEffectLevel({ reducedMotion: false, coarsePointer: false, hardwareConcurrency: 8, webgl: false })).toBe('static');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/app/effect-level.test.ts`

Expected: FAIL because `./effect-level` does not exist.

- [ ] **Step 3: Implement the resolver and reactive hook**

```ts
import { useEffect, useState } from 'react';

export type EffectLevel = 'full' | 'energy-saving' | 'static';
export type EffectSignals = Readonly<{
  reducedMotion: boolean;
  coarsePointer: boolean;
  hardwareConcurrency: number;
  webgl: boolean;
}>;

export function resolveEffectLevel(signals: EffectSignals): EffectLevel {
  if (signals.reducedMotion || !signals.webgl) return 'static';
  if (signals.coarsePointer || signals.hardwareConcurrency < 6) return 'energy-saving';
  return 'full';
}

function browserSignals(): EffectSignals {
  return {
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    hardwareConcurrency: navigator.hardwareConcurrency || 4,
    webgl: typeof window.WebGLRenderingContext !== 'undefined',
  };
}

export function useEffectLevel(): EffectLevel {
  const [level, setLevel] = useState<EffectLevel>(() => typeof window === 'undefined' ? 'static' : resolveEffectLevel(browserSignals()));
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = window.matchMedia('(pointer: coarse)');
    const update = () => setLevel(resolveEffectLevel(browserSignals()));
    motion.addEventListener?.('change', update);
    pointer.addEventListener?.('change', update);
    update();
    return () => {
      motion.removeEventListener?.('change', update);
      pointer.removeEventListener?.('change', update);
    };
  }, []);
  return level;
}
```

- [ ] **Step 4: Test GREEN and typecheck**

Run: `npx vitest run src/app/effect-level.test.ts && npm run typecheck`

Expected: all Task 1 tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/effect-level.ts src/app/effect-level.test.ts
git commit -m "feat: resolve adaptive workbench effects"
```

---

### Task 2: Immediate Interruptible Motion Surface

**Files:**
- Create: `src/app/MotionSurface.tsx`
- Create: `src/app/MotionSurface.test.tsx`

**Interfaces:**
- Consumes: `EffectLevel` from Task 1.
- Produces: `MotionSurface({ as, level, className, children, ...props })` for button, anchor, and div surfaces.
- Produces CSS custom property `--press-scale` whose live value is retargeted from the current presentation value.

- [ ] **Step 1: Write interaction tests**

```tsx
it('responds on pointer down and releases without disabling input', async () => {
  render(<MotionSurface as="button" level="full">開始</MotionSurface>);
  const button = screen.getByRole('button', { name: '開始' });
  fireEvent.pointerDown(button, { pointerId: 1 });
  expect(button).toHaveAttribute('data-pressed', 'true');
  fireEvent.pointerUp(button, { pointerId: 1 });
  expect(button).toHaveAttribute('data-pressed', 'false');
  expect(button).not.toBeDisabled();
});

it('uses static feedback when motion is reduced', () => {
  render(<MotionSurface as="button" level="static">下載</MotionSurface>);
  expect(screen.getByRole('button')).toHaveAttribute('data-motion', 'static');
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/app/MotionSurface.test.tsx`

Expected: FAIL because `MotionSurface` is undefined.

- [ ] **Step 3: Implement pointer capture, keyboard parity, and cleanup**

Implement a polymorphic component that:

```ts
const PRESS_TARGET = 0.97;
const REST_TARGET = 1;
const RESPONSE_MS = 360;

// pointerdown: setPointerCapture, set data-pressed immediately, retarget from the
// element's current --press-scale value; pointerup/cancel/lostcapture: retarget to 1.
// keydown Space/Enter: pressed true; keyup/blur: pressed false.
// static mode writes the target immediately. Full/energy-saving use one owned RAF
// with critically damped integration and cancel it on unmount.
```

Use `React.createElement(as, ...)`, preserve consumer handlers, and never call `preventDefault` except Space on a non-native button surface.

- [ ] **Step 4: Verify GREEN and accessibility behavior**

Run: `npx vitest run src/app/MotionSurface.test.tsx && npm run typecheck`

Expected: tests pass; no timer/RAF remains after unmount.

- [ ] **Step 5: Commit**

```bash
git add src/app/MotionSurface.tsx src/app/MotionSurface.test.tsx
git commit -m "feat: add responsive motion surfaces"
```

---

### Task 3: Central Apple Workbench Shell

**Files:**
- Create: `src/app/AppleWorkbench.tsx`
- Create: `src/app/AppleWorkbench.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`

**Interfaces:**
- Consumes: `EffectLevel`, `MotionSurface`.
- Produces: `type WorkbenchState = OneClickViewState['kind']`.
- Produces: `AppleWorkbench({ state, stage, fileName, level, children })`.

- [ ] **Step 1: Write semantic shell tests**

```tsx
it.each(['upload', 'reading', 'material', 'processing', 'result', 'failure'] as const)(
  'maps %s to a stable workbench state', (state) => {
    render(<AppleWorkbench state={state} level="full"><p>內容</p></AppleWorkbench>);
    expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', state);
    expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-effect-level', 'full');
  },
);

it('keeps local processing visible in floating chrome', () => {
  render(<App services={fakeServices} materialRepository={fakeRepository} />);
  expect(screen.getByText('私隱優先 · 本機處理')).toBeVisible();
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/app/AppleWorkbench.test.tsx src/app/App.test.tsx`

Expected: new workbench test fails because the component does not exist.

- [ ] **Step 3: Implement the shell**

The workbench root must render this stable structure:

```tsx
<section className="apple-workbench" data-testid="apple-workbench" data-state={state} data-effect-level={level}>
  <div className="workbench-environment" aria-hidden="true">
    <span className="workbench-grid" />
    <span className="workbench-orbit workbench-orbit-one" />
    <span className="workbench-orbit workbench-orbit-two" />
  </div>
  <div className="workbench-stage">{children}</div>
</section>
```

Update `App.tsx` so the header is floating chrome, the privacy phrase remains text, and the footer stays outside the interactive stage. Do not add decorative traffic-light controls.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/app/AppleWorkbench.test.tsx src/app/App.test.tsx && npm run typecheck`

Expected: shell tests and existing App tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/AppleWorkbench.tsx src/app/AppleWorkbench.test.tsx src/app/App.tsx src/app/App.test.tsx
git commit -m "feat: add central Apple workbench shell"
```

---

### Task 4: Migrate Workflow States into the Workbench

**Files:**
- Modify: `src/app/OneClickConverter.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`

**Interfaces:**
- Consumes: `AppleWorkbench`, `useEffectLevel`, `MotionSurface`.
- Preserves: `OneClickViewState`, `OneClickConverterServices`, `processFile`, timeline, cancel, package, and download ownership.

- [ ] **Step 1: Add state and drag-interaction tests**

```tsx
it('keeps every workflow state inside one workbench without changing actions', async () => {
  render(<OneClickConverter services={services} />);
  expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'upload');
  await submit(stlFile);
  expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'material');
  await chooseReadyMaterial();
  expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'processing');
});

it('shows drag attraction but clears it on leave and drop', () => {
  render(<OneClickConverter services={services} />);
  const target = screen.getByLabelText('選擇 STL 模型').closest('label')!;
  fireEvent.dragEnter(target);
  expect(target).toHaveAttribute('data-drag-active', 'true');
  fireEvent.dragLeave(target);
  expect(target).toHaveAttribute('data-drag-active', 'false');
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/app/OneClickConverter.test.tsx`

Expected: new workbench/drag assertions fail while existing behavior stays green.

- [ ] **Step 3: Wrap all render branches without changing workflow logic**

Add one `const effectLevel = useEffectLevel()` and a local helper:

```tsx
const frame = (content: ReactNode, stage?: AutomaticOutlineProgressStage) => (
  <AppleWorkbench state={view.kind} stage={stage} fileName={'fileName' in view ? view.fileName : undefined} level={effectLevel}>
    {content}
  </AppleWorkbench>
);
```

Wrap upload, material, reading, processing, failure, and result branches. Replace visual-only button/anchor wrappers with `MotionSurface` while leaving native labels, file inputs, hrefs, download names, callbacks, live regions, headings, warnings, and test-visible copy unchanged. Track drag depth rather than a boolean so child enter/leave events do not flicker; clear the depth on drop, reset, and unmount.

- [ ] **Step 4: Pass effect level to every real preview**

Use:

```tsx
<OutlineProcessViewport payload={view.preview} stage={view.stage} effectLevel={effectLevel} />
```

and apply the same prop for result and retained failure previews.

- [ ] **Step 5: Verify GREEN and no workflow regression**

Run: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx && npm run typecheck`

Expected: all existing and new workflow tests pass; service call counts and downloads are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx
git commit -m "feat: present conversion in one workbench"
```

---

### Task 5: Propagate Effect Levels through the Preview Boundary

**Files:**
- Modify: `src/preview/OutlineProcessViewport.tsx`
- Modify: `src/preview/OutlineProcessViewport.test.tsx`

**Interfaces:**
- Consumes: `EffectLevel`.
- Adds: `effectLevel?: EffectLevel` to `OutlineProcessViewportProps`.
- Adds: `effectLevel?: EffectLevel` and `setEffectLevel(level: EffectLevel): void` to the scene contract.
- Preserves: `reducedMotion?: boolean` as an explicit test seam; it maps to static when true.

- [ ] **Step 1: Write propagation and fallback tests**

```tsx
it('propagates effect level and exposes truthful fallback state', () => {
  const scene = fakeScene();
  render(<OutlineProcessViewport payload={payload} stage="slicing" effectLevel="energy-saving" createScene={() => scene} />);
  expect(scene.setEffectLevel).toHaveBeenCalledWith('energy-saving');
  expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'energy-saving');
});

it('marks SVG fallback static after scene construction failure', () => {
  render(<OutlineProcessViewport payload={payload} stage="result" effectLevel="full" createScene={() => { throw new Error('webgl'); }} />);
  expect(screen.getByRole('figure')).toHaveAttribute('data-renderer', 'fallback');
  expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/preview/OutlineProcessViewport.test.tsx`

Expected: type/assertion failures for the new contract.

- [ ] **Step 3: Implement boundary synchronization**

Derive `requestedLevel = reducedMotionOverride ? 'static' : effectLevel ?? (mediaReduced ? 'static' : 'full')`. Create the scene with `effectLevel: requestedLevel`, call `setEffectLevel` on changes, and expose:

```tsx
<figure
  className="outline-process-viewport"
  data-stage={stage}
  data-renderer={fallback ? 'fallback' : 'webgl'}
  data-effect-level={fallback ? 'static' : requestedLevel}
>
```

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/preview/OutlineProcessViewport.test.tsx && npm run typecheck`

Expected: all viewport tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/preview/OutlineProcessViewport.tsx src/preview/OutlineProcessViewport.test.tsx
git commit -m "feat: adapt preview effects by capability"
```

---

### Task 6: Add Truthful Showcase Effects to the Three.js Scene

**Files:**
- Modify: `src/preview/outline-process-scene.ts`
- Modify: `src/preview/outline-process-scene.test.ts`

**Interfaces:**
- Consumes: `EffectLevel`.
- Adds: `effectLevel?: EffectLevel` to `OutlineProcessSceneOptions`.
- Adds: `setEffectLevel(level: EffectLevel): void` to `OutlineProcessScene`.
- Preserves: payload geometry ownership and all existing scene methods.

- [ ] **Step 1: Add scene-budget and choreography tests**

Test exact limits and stage behavior:

```ts
expect(scene.scene.getObjectByName('workbench-platform')).toBeDefined();
expect(scene.scene.getObjectByName('contour-particles')?.userData.count).toBeLessThanOrEqual(240);
scene.setEffectLevel('energy-saving');
expect(scene.scene.getObjectByName('contour-particles')?.userData.count).toBeLessThanOrEqual(72);
scene.setEffectLevel('static');
expect(requestAnimationFrame).not.toHaveBeenCalled();

scene.setStage('analyzing');
expect(scene.scanPlane.visible).toBe(true);
scene.setStage('slicing');
expect(scene.layerGroups.some((group) => group.position.y !== group.userData.baseAxial)).toBe(true);
```

Also assert every added geometry/material is disposed exactly once after payload replacement and scene disposal.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/preview/outline-process-scene.test.ts`

Expected: missing effect-level API and showcase objects.

- [ ] **Step 3: Create bounded environment resources**

Add owned resources under named groups:

```ts
const FULL_PARTICLE_LIMIT = 240;
const SAVING_PARTICLE_LIMIT = 72;

// workbench-platform: RingGeometry + MeshBasicMaterial, transparent, depthWrite false
// contour-particles: deterministic Points sampled only from payload contour vertices;
// when no contours exist, omit particles instead of inventing model features.
// trace glow: duplicate role line material opacity/width presentation only; never
// create new contours or mutate CANONICAL_ROLE_COLORS.
```

Use a deterministic stride based on total eligible contour points so repeated payloads produce identical buffers. Register every geometry/material in the existing owned resource sets.

- [ ] **Step 4: Integrate stage and effect choreography**

- `analyzing`: scan plane visible, mesh wireframe dominant, layers un-exploded.
- `simplifying`: scan softens, retained geometry becomes clearer.
- `slicing` and `packaging`: existing layer explosion runs; role traces brighten by stage.
- `result`: viewport continues to pass packaging scene state, with result selection behavior preserved.
- `full`: normal rotation, full bounded particles, glow, and platform pulse.
- `energy-saving`: reduced particles, no expensive pulse, capped DPR remains at existing limit.
- `static`: render once after state changes, no scheduled RAF, no continuous rotation.

- [ ] **Step 5: Verify GREEN, lifecycle, and deterministic geometry**

Run: `npx vitest run src/preview/outline-process-scene.test.ts src/preview/OutlineProcessViewport.test.tsx && npm run typecheck`

Expected: all scene/viewport tests pass, including existing pool and disposal assertions.

- [ ] **Step 6: Commit**

```bash
git add src/preview/outline-process-scene.ts src/preview/outline-process-scene.test.ts
git commit -m "feat: add bounded workbench scene effects"
```

---

### Task 7: Apple Visual System, Accessibility Media, and Mobile Layout

**Files:**
- Modify: `src/styles.css`
- Create: `src/app/apple-workbench.browser.test.tsx`
- Modify: `src/app/App.browser.test.tsx`

**Interfaces:**
- Consumes stable `data-state`, `data-effect-level`, `data-renderer`, and workbench class names from Tasks 3–6.

- [ ] **Step 1: Write browser assertions before CSS**

Cover:

```tsx
expect(getComputedStyle(workbench).getPropertyValue('--glass-blur')).not.toBe('');
expect(getComputedStyle(screen.getByRole('button', { name: /選擇|下載/ })).minHeight).toBe('48px');
expect(workbench.getAttribute('data-effect-level')).toMatch(/full|energy-saving|static/);
```

Use browser projects/emulation to assert a 390px viewport keeps the main action visible without horizontal page overflow. Emulate reduced motion and assert `data-effect-level="static"`; emulate reduced transparency/high contrast where the browser supports the media feature, otherwise test the CSS rule text in jsdom.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.browser.config.ts src/app/apple-workbench.browser.test.tsx`

Expected: missing tokens/layout assertions fail.

- [ ] **Step 3: Replace mint styling with centralized Apple workbench tokens**

Define tokens at `:root`:

```css
:root {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-optical-sizing: auto;
  --accent: #0a84ff;
  --accent-strong: #0066cc;
  --ink: #102038;
  --muted: #52647d;
  --glass: rgba(255,255,255,.66);
  --glass-solid: rgba(255,255,255,.94);
  --glass-edge: rgba(255,255,255,.88);
  --glass-blur: 28px;
  --surface-radius: 30px;
  --control-radius: 14px;
  --focus: #006fff;
  --cut: #05070a;
  --deep: #d42b3d;
  --light: #1577e8;
}
```

Style the workbench with a silver-white radial environment, restrained grid, translucent floating toolbar, central stage, state-specific light, continuous corners, and blue-white shadows. Preserve semantic warnings/errors with accessible contrast. Use `--press-scale` in `transform` for motion surfaces. Do not use infinite full-viewport translation.

- [ ] **Step 4: Add exact accessibility and responsive contracts**

```css
@media (prefers-reduced-motion: reduce) {
  .workbench-orbit, .workbench-grid, .workbench-particle { animation: none !important; transform: none !important; }
}
@media (prefers-reduced-transparency: reduce) {
  .site-header, .converter-card, .processing-status-overlay { background: var(--glass-solid); backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  .site-header, .converter-card, .processing-status-overlay { background: #fff; border-color: #30435d; }
}
@media (max-width: 640px) {
  .apple-workbench { min-height: calc(100svh - 7rem); border-radius: 22px; }
  .workbench-stage { padding: .75rem; }
  .secondary-downloads, .result-grid { grid-template-columns: 1fr; }
  .workbench-orbit-two { display: none; }
}
```

- [ ] **Step 5: Verify browser, unit, and type checks**

Run: `npx vitest run src/app/App.test.tsx src/app/OneClickConverter.test.tsx && npx vitest run --config vitest.browser.config.ts src/app/apple-workbench.browser.test.tsx src/app/App.browser.test.tsx && npm run typecheck`

Expected: all selected tests pass; no horizontal mobile overflow.

- [ ] **Step 6: Commit**

```bash
git add src/styles.css src/app/apple-workbench.browser.test.tsx src/app/App.browser.test.tsx
git commit -m "feat: style responsive Apple workbench"
```

---

### Task 8: Real-Browser Scene Degradation and Interruption

**Files:**
- Modify: `src/preview/OutlineProcessViewport.browser.test.tsx`
- Modify: `src/app/OneClickConverter.test.tsx`

**Interfaces:**
- Verifies the public contracts from Tasks 1–7; no new production interface.

- [ ] **Step 1: Add failing real-browser checks**

Add tests that:

- mount full effects and observe a bounded WebGL canvas;
- change media to reduced motion and verify static mode without remounting conversion state;
- force scene construction failure and verify SVG fallback plus usable surrounding actions;
- replace a model during an active presentation and confirm the old scene and RAF are disposed;
- click a ready download while completion materialization is still present and confirm the href/download action is not gated.

- [ ] **Step 2: Run and verify RED where contracts are incomplete**

Run: `npx vitest run --config vitest.browser.config.ts src/preview/OutlineProcessViewport.browser.test.tsx`

Expected: at least the new live downgrade/interruption assertion fails before any required synchronization fix.

- [ ] **Step 3: Apply the smallest synchronization fixes**

Only modify Task 1–7 production files where the failing test identifies a concrete gap. Do not change workflow timing or output services. Ensure effect changes call `setEffectLevel` on the existing scene and do not reconstruct it; scene failure switches only the viewport renderer state.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run --config vitest.browser.config.ts src/preview/OutlineProcessViewport.browser.test.tsx src/app/apple-workbench.browser.test.tsx`

Expected: all browser interaction and lifecycle tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/preview/OutlineProcessViewport.browser.test.tsx src/app/OneClickConverter.test.tsx src/app src/preview
git commit -m "test: verify adaptive workbench interaction"
```

Before committing, inspect `git diff --cached --name-only` and unstage any file not required by this task.

---

### Task 9: End-to-End and Full Release Verification

**Files:**
- Modify: the existing primary one-click E2E spec located with `rg -n "下載 ZIP 製作套件" e2e`.

**Interfaces:**
- Verifies completed behavior only.

- [ ] **Step 1: Add E2E workbench assertions**

In the existing successful STL conversion path, assert:

```ts
await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'upload');
// Upload and material selection use the existing helpers.
await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'processing');
await expect(page.getByRole('link', { name: '下載 ZIP 製作套件' })).toBeVisible();
await expect(page.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'result');
```

Do not assert decorative frame timing. Assert workflow state, accessibility, fallback, and actionable output only.

- [ ] **Step 2: Run focused E2E**

Run: `npx playwright test <resolved-one-click-spec> --workers=1`

Expected: focused E2E passes in Chromium.

- [ ] **Step 3: Run complete deterministic verification**

Run in this order:

```bash
npm run typecheck
npm run build
npm test -- --maxWorkers=1
npm run test:browser -- --run
npm run validate:fixtures:public
```

Expected:

- TypeScript and Vite build exit 0.
- All unit tests pass in one worker; any documented conditional private-fixture skip remains the only permitted skip.
- All browser tests pass.
- Public fixture validation reports successful deterministic artifacts.

- [ ] **Step 4: Run authorized private STL verification when paths are present**

Use the repository's existing environment-variable contract for:

- `Copy of Beyblade X Knight Fortress.stl`
- `Copy of Beyblade X Knight Fortress Group.stl`

Run the existing private E2E and strict fixture validator exactly as documented by `rg -n "PRIVATE|KNIGHT|STL" README.md docs scripts e2e`. Expected: both authorized files complete or produce only the already-specified safe omission decisions; artifact validation remains deterministic.

- [ ] **Step 5: Inspect output and repository hygiene**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~1..HEAD
```

Confirm the two user STL files, `shapecut-outline.zip`, and `shapecut-outline/` remain untracked and untouched. Confirm no generated artifact or dependency directory is staged.

- [ ] **Step 6: Commit final E2E coverage**

```bash
git add <resolved-one-click-spec>
git commit -m "test: verify Apple workbench flow"
```

- [ ] **Step 7: Request final review before integration**

Use `superpowers:requesting-code-review` and provide the approved spec, this plan, commit range, full verification output, and explicit confirmation that geometry/artifact behavior was not changed.
