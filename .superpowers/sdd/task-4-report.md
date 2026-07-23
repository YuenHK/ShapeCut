# Task 4 Report: Migrate Workflow States into the Workbench

## Status

Implemented and committed Task 4 as `c65bcc8` (`feat: present conversion in one workbench`).

`OneClickConverter` remains the sole owner of file reading, material selection, conversion, timeline progression, cancellation, packaging, URL ownership, downloads, reset, and failure/result publication.

## Implementation

- Resolved one central `effectLevel` with `useEffectLevel()`.
- Wrapped upload, reading, material, processing, failure, and result in exactly one `AppleWorkbench`.
- Passed `state`, processing `stage`, available `fileName`, and `level` through the workbench frame.
- Passed the effect level into processing, retained-failure, and result preview boundaries. The prop is staged through a local typed compatibility boundary until Task 5 adds it to `OutlineProcessViewportProps` and consumes it.
- Replaced the failure reset button, primary ZIP anchor, and four secondary download anchors with `MotionSurface` while preserving native tags, callbacks, hrefs, download filenames, labels, and immediate action availability.
- Added upload drag attraction with a depth counter. Nested child enter/leave events no longer clear attraction early; drop and reset clear both depth and presentation state, and unmount clears the retained depth.
- Added a capability-safe `useEffectLevel` fallback to `static` when `window.matchMedia` is unavailable. This was required when the new workflow consumer first exercised the hook; no geometry, output, or workflow code changed.

## TDD Evidence

### Initial RED

Command:

```sh
npx vitest run src/app/OneClickConverter.test.tsx
```

Observed expected result:

```text
src/app/OneClickConverter.test.tsx (32 tests | 2 failed)
Unable to find an element by: [data-testid="apple-workbench"]
Expected data-drag-active="true"; received null
30 passed, 2 failed
```

The 30 pre-existing tests remained green. The two new tests failed specifically because the workbench and drag-depth contracts did not exist.

### Integration RED and root cause

After adding the first consumer of `useEffectLevel`, the focused suite failed 32/32 at `effect-level.ts:32` with:

```text
TypeError: window.matchMedia is not a function
```

The call path was reproducible on every converter mount. The hook initializer already treated absent capabilities safely, while its effect unconditionally called `matchMedia`. A minimal capability guard made absence resolve to `static`; the workflow test itself was the regression test that failed before this fix.

### Focused GREEN

```text
npx vitest run src/app/OneClickConverter.test.tsx
32/32 passed
```

### Required workflow regression and typecheck

Command:

```sh
npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx && npm run typecheck
```

Result:

```text
2 files passed
40/40 tests passed
TypeScript exit 0
```

### Fresh pre-commit dependency verification

Command:

```sh
npx vitest run src/app/effect-level.test.ts src/app/MotionSurface.test.tsx src/app/AppleWorkbench.test.tsx src/app/OneClickConverter.test.tsx src/app/App.test.tsx && npm run typecheck
```

Result:

```text
5 files passed
53/53 tests passed
TypeScript exit 0
```

`git diff --check` and `git diff --cached --check` both exited 0 immediately before the commit.

## Self-review

- All six render branches use the same frame helper and preserve their existing headings, live regions, warnings, native inputs/labels, and test-visible Traditional Chinese copy.
- The new end-to-end state test observes one workbench through upload, reading, material, processing, result, and failure. It also verifies one convert call, one package call, and exactly five download links.
- The drag test proves nested child leave does not flicker the target inactive and proves full leave, drop, and reset clear attraction.
- All three real preview sites receive the resolved effect level.
- Motion feedback does not await a timer, disable a control, prevent anchor activation, or gate reset/download actions.
- No geometry, slicing, packaging, artifact generation/name, user file, output, dependency, or stylesheet file changed.

## Concern

Task 4 passes `effectLevel` through a local typed compatibility alias because Task 5, by plan order, is the task that adds and consumes `effectLevel` in `OutlineProcessViewportProps`. The prop is already present at runtime at all three call sites; Task 5 should remove the temporary alias when it formalizes the preview boundary contract.
