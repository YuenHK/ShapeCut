# Task 4 Report — Colored ShapeCut Artifact Set

## Status

Complete on base `8f0b4ee`. Commit subject: `feat: export colored ShapeCut artifact set`; the resulting hash is reported in the handoff.

## Implemented

- Added schema-v2 `ColoredOutlineDocument` creation and validation from the validated runtime `AutomaticOutlineResult`. It reconciles source, feature-evidence, removal-evidence, and diagnostics fingerprints; ordered layer identity/Z spans; role cardinality; contour IDs/orientation/containment; and direct diagnostics evidence.
- Enforced the exact physical roles `CUT_BLACK`, `DEEP_RED`, and `LIGHT_BLUE`. Each layer has one black exterior, at most one black central hole, and at most one red/blue feature.
- Added one shared ordered entity stream used by SVG and DXF. SVG emits exact `#000000`, `#E5484D`, and `#3E63DD`; DXF emits ACI `7`, `1`, and `5` plus matching true-color group `420` values.
- Added deterministic `preview.pdf` with flat 1:1 sheet layout, role colors, layer labels, scale, and disclaimer.
- Added deterministic `exploded-view.pdf` with one-page isometric separation, central axis, increasing layer order, thickness, X/Y dimensions, equivalent central-hole diameter (or `—`), and legend. Both PDFs use fixed fonts and fixed creation/modification dates.
- Replaced the colored public package contract with exactly five payload keys: SVG, DXF, preview PDF, exploded PDF, and ZIP. The ZIP contains exactly `cut-and-engrave.svg`, `cut-and-engrave.dxf`, `preview.pdf`, and `exploded-view.pdf`; no JSON or manifest is returned or zipped.
- Verification regenerates and parses canonical SVG/DXF, regenerates and loads both PDFs, scans public names/text/metadata, enumerates raw ZIP central-directory records and JSZip original/sanitized names, reads all four entries, and requires byte identity with the four individual downloads.
- Preserved the one caller-owned absolute deadline through document validation, entity traversal, SVG/DXF parse loops, both PDF save/load phases, ZIP generation/raw enumeration/load/read, byte comparison, and final return checkpoints.
- Updated worker transfer shape and transfer list for ZIP plus both PDF buffers. Browser coverage supersedes worst-case packaging, proves `SupersededError`, terminates/recreates the worker, and completes a replacement request.

## TDD Evidence

- Initial RED: the new canonical/PDF suites failed because `colored-outline-document` and `exploded-pdf` did not exist; package tests also exposed the legacy one-role, five-record JSON/manifest output and rejected central-hole semantics.
- Canonical GREEN expanded through role/cardinality, identity/order, diagnostics/removal fingerprint, direct-span, containment/orientation, privacy, mutation, and deadline regressions.
- Worker RED received the obsolete `manifestJson` field instead of `explodedViewPdf`; GREEN transfers the exact new shape and all three binary buffers.
- Parser/deadline RED exposed missing loop checkpoints in SVG/DXF parsing and output byte comparisons; GREEN checks the shared deadline inside those loops.
- Exploded-PDF RED exposed an average-bounds hole diameter; GREEN reports the area-equivalent diameter `2 * sqrt(area / pi)`, rounded to 3 decimals.
- Review RED proved a forged fifth duplicate ZIP central-directory record was accepted because JSZip collapses duplicate names. GREEN directly parses the raw central directory, retains duplicate records, requires exactly four unique records, and shares the package deadline while scanning.

## Final Verification

- Focused unit/UI suite: 6 files, 438/438 tests passed.
- Chromium worker suite: 1 file, 16/16 tests passed.
- Full suite (run once after all fixes): 40 files, 1020/1020 tests passed.
- `npm run typecheck`: exit 0, no diagnostics.
- `git diff --check`: exit 0, no whitespace errors.
- Hygiene check found no `__screenshots__` directory or generated user output under `src`.

## File-map Notes

- Added `src/export/colored-outline-test-fixture.ts` to share one authentic, validated colored runtime fixture across the new export/PDF tests.
- The parent authorized the minimum UI contract ripple in `App`, `OneClickConverter`, and their tests: remove JSON, rename the existing PDF download to preview, add exploded PDF, use the exact artifact filenames, and clean up both PDF URLs. No Task 5 viewport or Task 6 visual/warning work was included.
- `src/workers/geometry-client.ts` required no edit: its generic `GeometryApi` typing automatically adopts `OutlinePackageTransfer`, and its existing hard-cancellation/recreate behavior is exercised by the updated browser test.
- Legacy `OutlinePackage` helpers remain exported only for the pre-existing safety/privacy regression suite; the worker and UI use the exact colored package and expose no legacy JSON/manifest payload.

## Independent Review and Self-review

- Independent review reported one important finding and no critical/minor findings: duplicate ZIP central-directory records could be hidden by JSZip's name-keyed object. The raw central-directory verifier and regression above remediate it.
- Self-review also added deadline-aware byte comparison, moved exploded-view bounds to trusted contours, tightened large-layer page scaling, confirmed fixed PDF metadata dates are inspected without load-time mutation, and removed an unused import.
- Confirmed all public artifact text rejects machine power/speed/pass settings, material/production claims, source STL/JSON/manifest names, private paths, and email addresses.

## Concerns

- None blocking. The exporter intentionally fails closed on malformed, drifted, privacy-bearing, oversized, or deadline-exhausted input instead of emitting a partial package.
