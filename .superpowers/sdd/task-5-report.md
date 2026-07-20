# Task 5 report — one-click ShapeCut interface

## RED

- Added `OneClickConverter.test.tsx` and replaced the App unit/browser expectations before production implementation.
- Command: `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx`
- Expected failures observed: `OneClickConverter` did not exist and `App` still rendered the five-step wizard instead of the ShapeCut upload view.

## GREEN

- Implemented the upload, processing, result, and failure state machine.
- A file selection calls cancellation first, reads locally, starts automatic conversion, packages the validated result, and publishes only the latest request.
- Superseded requests are silent; stale package URLs are revoked; current URLs are revoked on replacement and unmount.
- Added Traditional Chinese typed-error messages, monotonic stage announcements, warning copy including `已簡化模型`, ZIP primary download, and SVG/DXF/PDF/JSON secondary downloads.
- Replaced the rendered wizard with production services using `GeometryClient.convertAutomatically` and `createOutlinePackage`; no database or material repository is opened by the main flow.
- Replaced the minimal stylesheet with the approved responsive mint/white UI, visible focus, 44 px minimum controls, and reduced-motion handling.

## Verification

- Focused UI: 8/8 passed.
- Real Chromium App test: 1/1 passed.
- Full unit suite: 33 files, 868/868 passed.
- `npm run typecheck`: passed with no diagnostics.
- `git diff --check`: passed.

## Self-review and scope

- Verified there are no rendered repair, axis, next-step, material, decomposition, or export-confirmation controls.
- Verified selecting a second file invokes cancellation, prevents the old result from publishing, and releases prior object URLs.
- Verified the production UI uses only the automatic geometry worker and outline package boundary.
- Preserved legacy wizard/repository code without rendering it.
- Did not touch E2E files, documentation, fixture/STL files, or Task 6 scope.

## Review-finding follow-up

- RED added four regressions: truthful X × Y and total Z summaries, actual contour-driven SVG paths that change with geometry, the packaging checklist stage, and cleanup after partial object-URL creation.
- Replaced the decorative preview with a `preserveAspectRatio` SVG made from every validated layer contour, using the union of `sourceBoundsMm` and finite fail-safe formatting.
- Result metadata now states the layer count, X × Y planar extent, and original total Z extent without rescaling.
- The visual checklist now contains all five approved stages, including `正在準備下載`.
- Download URL creation is transactional: if any later URL creation fails, all earlier URLs are revoked before the original error is rethrown.
- Follow-up verification: focused UI 10/10, Chromium 1/1, full unit suite 33 files and 870/870 tests, typecheck and diff-check passed.

## Warning-accuracy follow-up

- RED proved that exact-mode warnings were incorrectly labelled as simplified, the 2.5D card omitted the material-thickness effect, diagnostics had no accessible disclosure, and filenames retained the source basename.
- Simplification claims now render only for `outline-2.5d`; exact-mode warnings surface their actual warning text without hole/internal-detail claims.
- The 2.5D warning explicitly explains that material thickness changes final stack height.
- Added keyboard-operable `技術資料` details containing the real mode, status, source fingerprint, layer count, warning list, and a pointer to the JSON manifest. It contains no source filename or local path.
- Browser downloads now use generic `shapecut-*` names, independent of the selected source filename.
- Strengthened the Chromium fixture to include a structurally valid layer and verified real SVG preview plus Enter-key disclosure behavior.
- Final verification: focused UI 13/13, Chromium 1/1, full unit suite 33 files and 873/873 tests, typecheck and diff-check passed.

## Contract-valid browser fixture follow-up

- RED removed the double assertion and directly typed the fixture as `AutomaticOutlineResult`; TypeScript correctly rejected missing `axis`, `originalReport`, and `repairAccepted` fields.
- Added a complete candidate axis, full nested zero-issue mesh report, and accepted-repair provenance. The browser fixture now compiles directly against the production contract with no cast.
- Verification: focused UI 13/13, Chromium 1/1, full unit suite 33 files and 873/873 tests, typecheck and diff-check passed.
