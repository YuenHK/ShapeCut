# ShapeCut Geometry-Estimate Materials Design

**Date:** 2026-07-24

**Status:** Approved in conversation; awaiting written-spec review

## Problem

The one-click material selector is empty on a fresh installation. All current built-in material profiles are intentionally pending calibration, while `OneClickConverter` only exposes profiles classified as ready. A user with no stored calibrated profile therefore cannot continue.

## Chosen Design

Add six built-in geometry-estimate choices directly to the one-click conversion flow:

- 3 mm plywood
- 5 mm plywood
- 3 mm cast acrylic
- 5 mm cast acrylic
- 2 mm cardboard
- 3 mm cork

These choices provide only the manufacturing geometry values needed for slicing and clearance:

- material thickness;
- kerf;
- minimum feature;
- minimum web;
- minimum remaining thickness;
- sheet bounds and fit allowances required by the existing geometry contract.

They do not represent calibrated machine recipes, operator approval, physical coupon verification, laser power, speed, pass count, or product-specific safety certification.

## Selection and Precedence

- A fresh installation always shows the six geometry-estimate choices.
- Labels explicitly include `幾何估算` and the nominal thickness.
- Stored profiles classified as ready remain selectable.
- A ready stored profile with the same ID replaces, rather than duplicates, a built-in estimate.
- Pending or blocked stored profiles remain hidden from the one-click selector.
- Changing the model resets material selection as it does today.

## Safety and Output

- Geometry-estimate choices never add power, speed, pass count, or recipe claims to SVG, DXF, PDFs, ZIP, result summaries, or warnings.
- Existing statements that output contains no laser power or speed remain visible.
- Existing test-cut and material-safety warnings remain visible.
- The tool must not describe an estimate as calibrated, verified, approved, or ready for production.
- Forbidden material identities remain blocked from stored-profile selection.

## Architecture

- Define focused built-in `ManufacturingGeometryProfile` estimates separately from pending `MaterialProfileV1` calibration templates.
- `selectableMaterials` combines the estimate profiles with ready stored profiles and deduplicates by ID.
- Geometry estimates bypass material-readiness classification only because they carry no recipe or calibration claim; stored profiles continue through the existing readiness gate.
- No changes are made to geometry algorithms, slicing, launcher/fastener logic, exports, worker boundaries, or artifact names.

## Verification

- A fresh `OneClickConverter` exposes exactly the six estimates and can start conversion after one is selected.
- Both 3 mm and 5 mm plywood and cast acrylic choices pass their exact thickness into conversion.
- Ready stored profiles remain available and deterministically deduplicated.
- Pending, blocked, and forbidden stored profiles remain unavailable.
- No estimate exposes laser power, speed, passes, calibration, or operator approval in visible or packaged output.
- Existing model replacement, cancellation, material refresh, browser flow, and artifact tests remain green.

