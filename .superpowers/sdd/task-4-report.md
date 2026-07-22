# Task 4 Report — Colored ShapeCut Artifact Set

## Status

Complete on base `8f0b4ee`. Commit subject: `feat: export colored ShapeCut artifact set`; the resulting hash is reported in the handoff.

## Implemented

- Added schema-v2 `ColoredOutlineDocument` creation and validation from the validated runtime `AutomaticOutlineResult`. It reconciles source, feature-evidence, removal-evidence, and diagnostics fingerprints; ordered layer identity/Z spans; role cardinality; contour IDs/orientation/containment; and direct diagnostics evidence.
- Enforced the exact physical roles `CUT_BLACK`, `DEEP_RED`, and `LIGHT_BLUE`. Each layer has one black exterior, at most one black central hole, and at most one red/blue feature.
- Added one shared ordered entity stream used by SVG and DXF. SVG emits exact `#000000`, `#E5484D`, and `#3A78D4`; DXF emits ACI `7`, `1`, and `5` plus matching true-color group `420` values.
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

---

## Review Remediation (2026-07-21)

This section supersedes the initial report where the review changed ZIP validation and the approved `LIGHT_BLUE` color.

### Critical — Strict Raw ZIP Reconciliation

- Replaced central-name-only inspection with a bounded canonical raw ZIP parser. It requires a final uncommented EOCD, one disk, exactly four non-ZIP64 central records, exact central offset/size/count reconciliation, and no archive bytes after EOCD.
- Every central record now validates canonical raw filename bytes, flags, DEFLATE method, CRC32, compressed/uncompressed sizes, disk/attributes, and local-header offset. Only the four ASCII filename byte sequences emitted by ShapeCut are accepted; BOM, NUL, invalid encoding, noncanonical names, directory names, duplicate names, extra fields/comments, encryption, descriptors, and ZIP64 sentinels fail closed.
- Every corresponding local header must have the expected signature and exactly match central version, flags, method, timestamp, raw name, CRC32, and sizes. Local data ranges must be contiguous from byte zero to the central directory, non-overlapping, in bounds, and free of gaps or hidden trailing records.
- Each decompressed payload is read once as bytes, checked against the raw uncompressed size and a deadline-aware CRC32 calculation, then required byte-identical to its individual SVG/DXF/PDF download. Text payloads additionally require canonical UTF-8 before privacy scanning.
- The canonical writer currently emits flags `0`, method `8`, complete local CRC/sizes, and no data descriptor/extra/comment; the verifier intentionally accepts only that known format.

### Important — Approved Light Blue

- Updated `LIGHT_BLUE` everywhere to `#3A78D4`: the canonical role map, SVG, DXF true-color `420` decimal `3832020`, preview/exploded PDF strokes, metadata, legends, and assertions.
- A full-repository `rg` check for the superseded hex, decimal, and RGB component literals returned `OLD_BLUE_ZERO_MATCHES`.

### Review RED/GREEN Evidence

- Raw ZIP RED: 4 of 12 mutation cases were incorrectly accepted—local encryption bit, zero local sizes, forged matching central/local CRC, and descriptor bit without a descriptor. Central BOM, local-name mismatch, overlapping/out-of-range offsets, and ZIP64 were already rejected indirectly.
- Deadline RED: the new local-record and decompressed-CRC loop checkpoint tests completed instead of expiring because those phases did not yet exist.
- GREEN: all 12 mutations (including BOM, NUL, invalid UTF-8, directory name, encryption, size, CRC, name, overlap, range, ZIP64, and descriptor cases) are rejected, and both new deadline checkpoints expire inside the intended loops.
- Blue RED: SVG, DXF, preview metadata, and exploded legend still emitted the superseded color. GREEN emits only `#3A78D4` / `3832020` and preserves ACI `5`.

### Fresh Review Verification

- Required export command: exit 0; 4 files, 438/438 tests passed.
- Chromium worker command: exit 0; 1 file, 16/16 tests passed.
- `npm run typecheck`: exit 0; no diagnostics.
- Fresh `npm test`: exit 0; 40 files, 1034/1034 tests passed.
- `git diff --check`: exit 0; no whitespace errors.

### Remaining Concern

- None blocking. ZIP acceptance is deliberately narrower than the general ZIP specification: archives not emitted in ShapeCut's canonical JSZip format are rejected even if another unzip tool could read them.
