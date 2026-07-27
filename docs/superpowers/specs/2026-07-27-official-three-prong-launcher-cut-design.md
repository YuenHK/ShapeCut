# Official Three-Prong Launcher Cut Design

**Date:** 2026-07-27  
**Status:** Approved design

## Goal

Make every fabrication artifact support the original three-prong Beyblade X launcher by adding one fixed, calibrated three-prong cut template to the top two physical layers. Preview, SVG, DXF, PDF, and ZIP contents must all derive the cut from the same canonical geometry.

The fixed template will initially be extracted from the two existing Knight Fortress STL references and calibrated with a physical fit coupon. It is not claimed to be an independently published manufacturer CAD profile.

## Approved Decisions

- Add the three-prong cut to the top two physical layers only.
- Use one fixed template rather than detecting a new profile from every uploaded STL.
- Derive the initial fixed template from the existing Knight Fortress STL references.
- Give the three-prong cut priority over red and blue decorative features.
- Apply material kerf compensation and expose a user-adjustable fit offset with a default of `0.00 mm`.
- Block all exports if the template would breach an exterior or required load-bearing structure.
- Build every preview and artifact from one canonical geometry decision.

## Terminology

- **Fixed three-prong template:** the normalized three-loop cut geometry derived from the Knight Fortress references and identified by a version.
- **Canonical axis:** the reconciled common center used by the layer stack.
- **Fit offset:** the bounded user adjustment, in millimetres, applied in addition to material kerf compensation.
- **Required structure:** material that the existing structural validation identifies as necessary for containment, support, or assembly.
- **Decorative features:** the lower-priority `DEEP_RED` and `LIGHT_BLUE` contours.

## Architecture

The automatic outline pipeline will insert the fixed launcher template before the canonical colored document is built. Exporters must not invent, recover, resize, rotate, or compensate launcher geometry independently.

The processing order is:

1. Extract and validate physical layers.
2. Reconcile the canonical axis and common central hole.
3. Load and validate the versioned fixed three-prong template.
4. Apply material kerf compensation and the bounded fit offset exactly once.
5. Search deterministic rotations around the canonical axis for a structurally valid placement.
6. Apply the same selected contours, center, and rotation to the top and second layers.
7. Remove or clip lower-priority red and blue decorative contours that overlap the protected launcher envelope.
8. Validate exteriors, required structure, finite coordinates, contour topology, clearance, and resource limits.
9. Build one canonical colored document.
10. Derive the preview, SVG, DXF, PDFs, ZIP members, manifest, and project persistence data from that document.

The existing runtime detector may remain available for reference extraction or migration, but it will not decide the launcher shape for newly converted models.

Strict automatic-result validation may retain a sanitized, bounded copy of the top-layer provisional red/blue contours solely as internal `AutomaticOutlineResult` validation evidence. It must use that evidence, the final retained contours, and the finished launcher envelopes to recompute all four launcher-overlap counters exactly. This evidence is excluded from the feature fingerprint and must never enter preview state, the canonical colored document, worker/public transfer, SVG, DXF, either PDF, ZIP, manifest, project JSON, or persistence.

## Fixed Template Creation

The template-generation tool will:

- read the two existing Knight Fortress STL references;
- align each candidate to its central axis;
- identify the corresponding three closed prong loops;
- verify threefold topology and approximately 120-degree angular spacing;
- compare corresponding loop radii, areas, and aligned point distances using the existing compatibility limits;
- normalize one compatible result into template-local coordinates;
- assign a stable template version and geometry fingerprint;
- fail closed if the two references are incompatible or any contour is invalid.

The published template fixture will contain only bounded, finite geometry and the minimum metadata needed to reproduce and verify it. Source filenames or other private local paths must not appear in artifacts.

## Placement and Geometry Priority

The complete three-prong group is all-or-none across the top two layers. Both layers use byte-equivalent normalized contours before their defined sheet-space transformations.

Placement searches bounded deterministic rotations around the canonical axis. Candidate ranking prioritizes:

1. preservation of the exterior and required structure;
2. maximum structural clearance;
3. minimum overlap with decorative features;
4. the smallest deterministic rotation from the template's canonical orientation.

The template shape, relative loop positions, scale, and center may not change during placement. Rotation is the only placement degree of freedom.

The geometry priority is:

1. layer exterior and required structure;
2. shared central axle hole;
3. fixed three-prong launcher cut;
4. retained fastener holes;
5. red and blue decorative features.

Overlapping `DEEP_RED` and `LIGHT_BLUE` regions are clipped when the remaining geometry is valid and otherwise removed. Their removal does not block export. The runtime records how many contours were clipped or removed.

If no searched rotation preserves the exterior, required structure, and mandatory clearances on both top layers, the conversion fails closed. No SVG, DXF, PDF, ZIP, or partially compliant subset may be downloaded.

## Kerf and Fit Offset

The launcher cut uses the selected material profile. Material selection remains mandatory per model.

The final compensated launcher boundary combines:

- the fixed nominal template;
- the existing material kerf rule for internal cuts; and
- one user fit offset.

The implementation must define one signed-offset convention and use it consistently: a positive user value makes the finished receiving opening looser, while a negative value makes it tighter. Compensation is applied exactly once in the canonical geometry pipeline.

The default fit offset is `0.00 mm`. The UI and domain validation share the inclusive range `-0.20 mm` to `+0.20 mm` with a `0.01 mm` step. Values outside the range are rejected rather than silently clamped.

Changing the uploaded model clears material selection under the existing material contract. The fit offset returns to `0.00 mm` with that reset so an unverified calibration is not silently carried to another model.

## User Interface

After material selection, the workbench displays a field labelled `三爪配合微調`. It shows millimetres, explains the positive/negative convention, defaults to `0.00`, and rejects invalid input accessibly.

The preview renders the actual compensated launcher contours in black `CUT_BLACK` on the top two layers. It must not display nominal or estimated geometry in place of the canonical result.

The status area reports:

- `官方三爪孔：已加入頂部兩層`;
- the fixed template version;
- selected material kerf;
- fit offset;
- the number of red and blue decorative contours clipped or removed; and
- a blocking reason when placement or template validation fails.

When blocked, every artifact download control is disabled. Existing valid downloads from an earlier model or setting must be cleared so stale artifacts cannot be mistaken for the current result.

## Canonical Output Contract

Launcher contours use `CUT_BLACK` in every output. The canonical document records:

- template version and fingerprint;
- selected rotation;
- compensated top-two-layer contours;
- material profile identifier and kerf;
- fit offset;
- decoration-overlap decisions; and
- sanitized warnings or blocking diagnostics.

SVG, DXF, fabrication PDF, exploded PDF, ZIP members, manifest, preview, and persisted project data must reconcile to these same decisions after their defined coordinate transformations. Artifact verification must check complete grammar consumption, canonical role/color mapping, contour identity, layer identity, and manifest consistency rather than relying on keywords.

## Calibration Coupon

The product will provide a separate physical fit coupon containing five labelled three-prong openings:

- `-0.10 mm`
- `-0.05 mm`
- `0.00 mm`
- `+0.05 mm`
- `+0.10 mm`

Each coupon opening uses the same fixed template and the same selected material kerf rule as production output. Labels are engraving geometry and cannot be mistaken for cut contours.

The coupon is used to test the official launcher physically and choose a fit offset. Until that test succeeds, the UI and documentation describe the template as derived from the Knight Fortress samples and awaiting physical calibration. A successful physical test can promote the corresponding template version to calibrated status without silently changing its geometry or fingerprint.

## Persistence and Migration

New project data stores the fit offset and template version. Reopening a project must reproduce the same canonical launcher result when the referenced template version is available.

Older project data without these fields migrates to:

- current fixed template version; and
- fit offset `0.00 mm`.

If a saved template version is unavailable or its fingerprint does not match, the project is blocked from export until it is explicitly regenerated. It must not silently substitute different launcher geometry.

## Error Handling and Safety

The conversion blocks all outputs when:

- template loading, fingerprint, topology, or coordinate validation fails;
- kerf or fit offset produces invalid, collapsed, or self-intersecting contours;
- the complete launcher group cannot be placed safely on both top layers;
- the launcher breaches an exterior or required structure;
- canonical output reconciliation fails; or
- resource or runtime limits are exceeded.

Diagnostics are deterministic, sanitized, bounded in count and length, and free of uploaded filenames, paths, raw mesh data, or uncontrolled characters.

Decoration clipping or removal is non-blocking and reported as a normal geometry decision.

## Testing

### Unit Tests

- Template extraction, alignment, stable ordering, version, and fingerprint.
- Rejection of incompatible Knight references, malformed loops, non-finite coordinates, wrong topology, and invalid angular relationships.
- Deterministic rotation search and identical top-two-layer normalized geometry.
- Internal-cut kerf plus fit-offset sign convention, bounds, and exactly-once compensation.
- Decoration clipping/removal and accurate affected-contour counts.
- Rejection when any exterior, required structure, topology, or clearance rule fails.
- Persistence, migration, missing-template, and fingerprint-mismatch behavior.
- Coupon offsets, labels, role separation, and template identity.

### Integration and Artifact Tests

- Both Knight Fortress STL references produce launcher-compatible canonical documents.
- Synthetic safe, decorative-overlap, and structurally impossible models exercise success, priority removal, and blocked-output paths.
- Only the top two physical layers contain the launcher cuts.
- Preview, SVG, DXF, both PDFs, ZIP members, and manifest contain equivalent launcher decisions and geometry.
- Mutating a template version, fingerprint, fit offset, rotation, contour, layer assignment, role, color, or manifest entry causes verification failure.
- Invalid results clear stale downloads and prevent partial artifact generation.

### Browser and End-to-End Tests

- Material selection reveals the fit field and model changes reset material and fit offset.
- Keyboard and screen-reader interaction expose the field, units, validation, and blocking state.
- Preview displays actual compensated `CUT_BLACK` contours on the correct layers.
- Successful downloads reconcile across all formats.
- Blocked geometry disables every download control and shows a sanitized actionable reason.
- Saving and reopening preserves the template version and fit offset.

### Physical Acceptance

Cut the five-opening coupon in at least one supported 3 mm material using its measured kerf. The chosen opening must:

- accept all three launcher prongs without forced deformation;
- latch and release repeatedly;
- avoid excessive rotational play; and
- show no cracking or unsafe local thinning.

Record the material, measured kerf, selected fit offset, template version, and result. Software verification cannot replace this physical acceptance step.

## Out of Scope

- Supporting non-three-prong launcher standards.
- Adding launcher cuts to every physical layer.
- Scaling or deforming the fixed template to fit an otherwise incompatible model.
- Preserving decorative engraving at the expense of launcher compatibility.
- Claiming manufacturer certification without documented physical validation.
- Changing material presets, fastener strategy, layer decomposition, artifact names, or unrelated UI styling.

## Acceptance Criteria

The design is complete when:

1. every successful fabrication artifact contains the same fixed launcher cut decision on the top two layers;
2. kerf and fit offset are applied once and reported;
3. conflicting red and blue decoration yields to the launcher cut;
4. structural conflicts block all exports;
5. preview, artifacts, ZIP manifest, and persisted data reconcile to one canonical document;
6. automated tests cover nominal, overlap, invalid, mutation, migration, and stale-download cases; and
7. the physical coupon provides an explicit path to validate compatibility with an official launcher.
