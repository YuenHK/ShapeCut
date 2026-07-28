# Launcher Exterior Expansion Design

**Date:** 2026-07-28
**Status:** Approved in conversation; awaiting written-spec review
**Extends:** `2026-07-27-official-three-prong-launcher-cut-design.md`

## Goal

Allow the fixed three-prong launcher cut to fit the two Knight Fortress reference models without resizing the launcher template. When the original top-two-layer exteriors are too small, expand both exteriors by one shared, uniform outward offset while preserving canonical geometry and structural safety.

## Scope

- Expand only the exterior cut contour of the top two physical layers.
- Keep the fixed launcher template, central holes, red and blue decoration, and every other physical layer unchanged.
- Use one shared expansion distance for both affected layers.
- Cap the shared expansion at `6.00 mm`.
- Record the applied expansion in the UI, `project.json`, and `manifest.json`.
- Continue to describe the launcher template as awaiting physical calibration.

This design does not resize the complete model, move decoration, add launcher cuts to other layers, or replace the physical coupon acceptance process.

## Canonical Geometry Flow

The automatic pipeline first attempts normal fixed-template placement against the original top-two-layer exteriors. If that placement is safe, the shared expansion is `0.00 mm`.

If placement is unsafe only because either exterior lacks the required launcher clearance:

1. Determine the minimum uniform outward offset required by each of the top two exterior contours.
2. Select the larger requirement so both layers use one shared distance.
3. Round the shared distance upward to the next `0.01 mm`.
4. Reject the conversion if the rounded distance exceeds `6.00 mm`.
5. Offset both exterior contours outward by the shared distance using the existing deterministic polygon-offset kernel.
6. Re-run the complete fixed-launcher placement and canonical validation against the expanded exteriors.

The expanded exterior contours become part of the canonical colored document before preview or artifact generation. Exporters must consume these canonical contours and must not independently reproduce, infer, or modify the expansion.

## Geometry Invariants

- Both affected layers use the same finite expansion value in the inclusive range `0.00 mm` to `6.00 mm`.
- Expansion uses `0.01 mm` precision and is always rounded upward when a non-grid requirement is found.
- Only the two exterior contours change.
- Launcher contours remain byte-equivalent to the normal fixed-template result for the selected rotation and fit offset.
- Central holes, internal cuts, red and blue decoration coordinates, and lower-layer exteriors remain unchanged.
- Expanded contours must be finite, simple, non-collapsed, and consistently oriented.
- The finished launcher cuts must preserve the selected material's `minWebMm` on both expanded layers.
- Existing deadline, cancellation, point-budget, and deterministic-ordering requirements continue to apply.

If the outward offset creates invalid topology, breaches required structure, exceeds resource limits, or still cannot contain a safe launcher placement, the conversion fails closed.

## Planning and Selection

The expansion planner is deterministic for the same:

- source geometry fingerprint;
- material geometry profile;
- launcher template version and fingerprint;
- launcher fit offset; and
- pipeline version.

It must find the smallest shared `0.01 mm` offset that allows the existing deterministic launcher rotation planner to produce a safe result on both layers. A larger expansion must not be selected when a smaller grid-aligned value passes all canonical checks.

The selected launcher rotation continues to use the established ranking order: structural clearance, decoration overlap, then rotation. Exterior expansion does not create a separate launcher template or silently relax any launcher safety rule.

## Output and Persistence Contract

The canonical launcher assembly records:

- expansion mode: shared uniform exterior offset;
- applied expansion in millimetres;
- maximum permitted expansion `6.00 mm`; and
- the two affected physical-layer identities.

The UI reports:

`頂部兩層外框已共同擴大 X.XX mm`

When no expansion is needed, it reports `0.00 mm`.

`project.json` and `manifest.json` store the same normalized expansion decision. The manifest continues to hash and reconcile its non-manifest members. Preview, SVG, DXF, both PDFs, ZIP members, project metadata, and manifest metadata must agree with the canonical expanded exteriors.

SVG, DXF, and fabrication PDFs do not receive extra human-readable expansion labels. Their cut geometry itself reflects the expanded contours.

A reopened project must reproduce the stored expansion decision after source reattachment and canonical regeneration. If the regenerated value or affected-layer identities differ, export remains blocked until the user explicitly regenerates and accepts the new canonical project state.

## Error Handling

If the smallest safe shared offset is greater than `6.00 mm`, return the typed error:

`LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED`

The sanitized user-facing diagnostic includes:

- the required shared expansion;
- the `6.00 mm` limit; and
- that no fabrication artifacts were generated.

Invalid offset topology, structural conflicts, deadline exhaustion, cancellation, and resource-limit failures retain their existing typed error attribution. The pipeline never falls back to launcher-less output, a partial three-prong group, independently expanded layers, or a resized launcher template.

## Verification

### Domain tests

- Original-safe exteriors select `0.00 mm`.
- Different per-layer requirements select their larger shared value.
- A non-grid requirement rounds upward to `0.01 mm`.
- Exactly `6.00 mm` may succeed.
- A requirement above `6.00 mm` returns `LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED`.
- No larger grid-aligned offset is selected when a smaller one is safe.
- Invalid expanded topology and remaining structural conflicts fail closed.
- Deadline, cancellation, point-budget, and deterministic replay remain bounded.

### Canonical and artifact tests

- Only the final two physical-layer exteriors change.
- Both changed exteriors use the same expansion distance.
- Launcher cuts, central holes, decoration coordinates, and lower-layer exteriors remain unchanged.
- Preview, SVG, DXF, PDFs, ZIP, `project.json`, and `manifest.json` reconcile the same expansion decision and exterior geometry.
- Mutating the expansion mode, amount, limit, affected layers, or expanded contour causes verification failure.
- Persistence round-trips the expansion evidence and blocks mismatched regeneration.

### Real-fixture acceptance

Both Knight Fortress STL references must:

- complete automatic conversion with the fixed launcher template;
- contain exactly three launcher cuts on each of the top two physical layers;
- use one shared exterior expansion no greater than `6.00 mm`; and
- produce mutually consistent canonical artifacts.

### Physical acceptance

Software success does not establish official-launcher compatibility. The calibration coupon and an official launcher must still pass:

- insertion without forced deformation;
- repeated latch and release;
- acceptable rotational play; and
- inspection for cracking or permanent damage.

Until those checks pass, the UI retains:

`依 Knight Fortress 樣本建立，待官方發射器實物校準`

## Acceptance Criteria

The feature is ready for software integration when:

1. both Knight Fortress references pass the real-fixture artifact matrix;
2. both top exteriors use the same smallest safe `0.01 mm` expansion;
3. the expansion never exceeds `6.00 mm`;
4. every public artifact and persisted decision agrees with canonical geometry;
5. unsafe or excessive expansion blocks every download; and
6. no launcher template, central hole, decoration coordinate, or lower layer is resized or moved.

Release acceptance additionally requires the official-launcher physical checks.
