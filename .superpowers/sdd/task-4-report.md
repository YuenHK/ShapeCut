# Task 4 Report: Expose the Real Model Behind a Compact Upper-Left Status Overlay

## Files changed

- `src/app/OneClickConverter.tsx`
  - Split processing markup into a neutral pre-geometry `.processing-loading-panel` and a post-preview `.processing-status-overlay`.
  - Kept exactly one `processing-title` label target in either branch.
  - Kept status announcements and progress only once real preview geometry exists.
- `src/app/OneClickConverter.test.tsx`
  - Added assertions proving that no preview/overlay is fabricated before preview emission.
  - Added assertions proving the real viewport and compact status overlay replace the neutral loader after preview emission.
  - Updated progress coverage for the truthful neutral pre-geometry phase.
- `src/app/App.browser.test.tsx`
  - Holds conversion at the processing stage and measures real Chromium layout at 1024×768 and 390×844.
  - Verifies upper-left placement, less than 35% card-area coverage, mobile offsets/width, reachable file-change stacking, and the default non-drag cursor.
  - Imports the production stylesheet so geometry assertions exercise the actual layout.
- `src/styles.css`
  - Replaced the centered near-opaque foreground with the approved compact upper-left overlay and mobile override.
  - Added the neutral loading panel and placed the file-change control in a reachable lower-right stacking layer.
  - Removed obsolete foreground/progress-checklist styles and the stale WebGL `ew-resize`/focus-visible rules left after manual camera controls were removed.

## TDD evidence

### Baseline

Command:

```sh
npm test
```

Output before changes: 42 test files passed; 1104 tests passed.

### Red

Command:

```sh
npx vitest run src/app/OneClickConverter.test.tsx
```

Output: 1 failed, 15 passed. The intended assertion failed because `.processing-loading-panel` was absent and the old shared `.processing-foreground` still rendered both phases.

### Green

Command:

```sh
npx vitest run src/app/OneClickConverter.test.tsx
```

Output: 1 test file passed; 16 tests passed.

Command:

```sh
npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx
```

Output: 2 test files passed; 20 tests passed.

### Review follow-up cycle

The read-only reviewer identified that the truthful neutral loader had lost the prior live-region announcement. A new assertion for `role="status" aria-live="polite"` failed as intended (1 failed, 15 passed), then passed after the loading panel became a polite status. The same test now sends a backward `analyzing` event after visible `slicing` preview state and proves the overlay does not regress. Re-review found no remaining Critical or Important issues and returned **Ready to merge**.

## Browser evidence

Command:

```sh
npm run test:browser -- src/app/App.browser.test.tsx src/preview/OutlineProcessViewport.browser.test.tsx
```

Output: 2 Chromium test files passed; 13 tests passed.

The app browser test measured the processing card and overlay from actual DOM rectangles. At desktop size it confirmed the overlay starts in the card's upper-left quadrant and occupies less than 35% of the card area. At 390×844 it confirmed the 10px top/left override, `calc(100% - 20px)` sizing (accounting for the card border), less than 35% area, and a visible file-change control above the viewport at z-index 3. It also confirmed the preview no longer advertises the removed drag interaction with an `ew-resize` cursor.

The task brief's Playwright-like `page.locator().boundingBox()` sample is not implemented by the installed Vitest Browser runtime. The test therefore uses real-browser `getBoundingClientRect()` measurements for the same assertions; `page.viewport()` remains in use for responsive coverage.

## Additional verification

Command:

```sh
npm run typecheck
```

Output: exit 0.

Command:

```sh
npm test
```

One standalone post-layout run passed all 42 test files and all 1104 tests. After the final accessibility-attribute change, two later full-suite runs each completed 1103/1104 but timed out in a different unrelated 5-second geometry test (`repair-mesh` once, `extract` once). Both complete files passed immediately in isolation: 17/17 and 34/34 respectively. The pre-change baseline also passed all 1104 tests. An earlier run executed concurrently with typecheck exhibited the same resource-sensitive timeout behavior.

Command:

```sh
npm run build
```

Output: exit 0; TypeScript and Vite production build completed successfully.

Command:

```sh
git diff --check
```

Output: clean.

## Commit

Included in `feat: keep processing model unobstructed`; the resulting commit hash is reported in the handoff.

## Self-review

- Confirmed `.processing-foreground`, `.progress-status`, and `.stage-list` are absent from production and tests.
- Confirmed `.processing-status-overlay` only renders when `view.preview` is truthy and `.processing-loading-panel` only renders beforehand.
- Confirmed the model viewport remains the full processing-card background and the compact overlay ignores pointer events.
- Confirmed the file-change input remains keyboard focusable/reachable above the viewport stacking layer.
- Confirmed both processing branches expose polite status announcements and visible preview stages reject backward progress.
- Confirmed result-only layer selector behavior and user assets were not changed.
- Confirmed the change is limited to the four Task 4 source/test/style files plus this required report.

## Concerns

No Task 4 product concerns. The full suite has resource-sensitive 5-second geometry tests: final full-suite attempts timed out one unrelated test each, while both affected files passed immediately in isolation and the focused/component/browser/build gates are green. The browser suite continues to emit its existing expected WebGL context-loss diagnostic, and the app browser test emits two existing `null` stderr lines while still passing.
