# Final review fix report

## RED evidence

- `npm test -- src/export/exploded-pdf.test.ts src/preview/OutlineProcessViewport.test.tsx` initially failed because `preview.pdf` used a vertically re-laid-out sheet, omitted the required visible process guidance, and the result view had no accessible layer selector.
- The first uninterrupted implementation run of `e2e/material-calibration.spec.ts` exposed an outdated assertion that treated every combobox as a material-profile control. The selector is explicitly named `選擇預覽切片` and only changes display opacity; it has no material or machine-setting semantics.

## Implemented fixes

- Exported and reused `createColoredExportLayout()` so SVG, DXF, and the preview PDF share one canonical fabrication-sheet layout. The preview PDF now draws every entity at the exact SVG/DXF point coordinates and visibly includes layer labels, `Scale 1:1`, and the black/red/blue legend.
- Added deterministic visible text and metadata to both PDFs: red and blue are relative processing levels, not literal machine settings; machine-specific settings are assigned after material test cuts. Parser assertions now reject missing text and reconcile preview PDF coordinates and entities exactly.
- Added ordered, keyboard-accessible per-layer result selection. WebGL and SVG fallback apply opacity-only highlighting, preserve geometry, reset safely after payload replacement, and dispose cloned highlight materials.
- Updated the material-calibration E2E to distinguish the local layer-preview selector from prohibited material-profile or machine-recipe inputs.
- Updated product wording to describe a consistent reflected display frame, without changing geometry handedness or claiming quaternion/pure rotation behavior.

## GREEN evidence

| Command | Result |
| --- | --- |
| `npm test -- src/test/e2e-helpers.test.ts src/export/exploded-pdf.test.ts src/preview/OutlineProcessViewport.test.tsx src/preview/outline-process-scene.test.ts` | 63 passed |
| `npm run test:browser -- src/preview/OutlineProcessViewport.browser.test.tsx` | 12/12 Chromium passed |
| `npm test` | 42 files, 1096 tests passed |
| `npm run test:browser -- --run` | 5 files, 38 tests passed |
| external-fixture environment variables + `npm run test:e2e -- --workers=1` | 15/15 passed; Knight 2/2; 0 skipped |
| `npm run validate:fixtures` | 10/10 expected outcomes passed; 8 automatic successes |
| `npm run test:performance` | 4/4 passed in 51.7 s; 100k classification 30.7 s |
| `npm run typecheck` | passed |
| `npm run build` | passed; 57 modules transformed |
| `git diff --check` | passed |
| changed-diff private-path audit | no matches for private paths, user fixture names, or fixture environment variables |

## Self-review

- ZIP content and byte-identity contract remain exactly the four approved files.
- Deadline/cancellation, private-output validators, and renderer-pool lifecycle remain covered by the fresh suites.
- The generic phrase `material test cuts` is narrowly permitted by the artifact text scanner so both PDFs can give the approved safe guidance; actual material profiles, power, speed, passes, and source paths remain rejected.
- One early full-E2E invocation was interrupted when the command-return boundary stopped its preview server after 30 seconds; its subsequent connection-refused failures were infrastructure-only and were discarded. The recorded full run used a persistent session and passed 15/15.

## ZIP central-directory order final-review fix

### RED evidence

- Added a mutation that swaps only the first two central-directory records, leaving every local record and compressed payload byte unchanged.
- Before the fix, `npm test -- src/export/outline-package.test.ts` failed at `rejects central-directory records reordered without changing local records or payloads`: `verifyColoredOutlinePackage()` resolved instead of rejecting.

### Fix and GREEN evidence

- The production raw ZIP verifier now retains central-directory encounter order, requires the writer sequence `cut-and-engrave.svg`, `cut-and-engrave.dxf`, `preview.pdf`, `exploded-view.pdf` before its separate local-offset sort, and returns records in that preserved order.
- The local-offset sort remains solely for the gap/overlap and bounds reconciliation; ZIP payload byte identity, privacy scans, and shared-deadline checkpoints remain unchanged.

| Command | Result |
| --- | --- |
| `npm test -- src/export/outline-package.test.ts` (RED) | 418 passed, 1 expected new regression failed because verification resolved |
| `npm test -- src/export/outline-package.test.ts src/test/e2e-helpers.test.ts` (GREEN) | 460 passed |
| `npm run typecheck` | passed |
| `npm test` | 1,096 passed; 1 unrelated pre-existing failure: `Knight Fortress safe repair regression` timed out at Vitest's 5 s limit |
| `git diff --check` | passed |
