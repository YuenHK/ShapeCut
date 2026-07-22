# Top Features, Launcher Clearance, Fasteners, and Animation Design

Date: 2026-07-22
Status: Approved in conversation; pending written-spec review

## Goal

Extend the one-click laser-cut workflow so the upper face retains substantially more engraving detail, the laminated result can attach to an original three-hook Beyblade X launcher when geometry permits, the stack can be fixed with up to three 3 mm screws, and the processing animation remains visible long enough to understand.

## Scope

This design adds four coordinated capabilities to the existing automatic outline pipeline:

1. Multi-contour red and blue engraving on the top layer.
2. Three-hook launcher clearance on the top two layers.
3. A safe, automatically degrading 3/2/1/0 screw-hole pattern through every layer.
4. A minimum eight-second staged processing presentation with half-speed rotation.

All geometry remains automatic. Material confirmation is required for every uploaded model, but no user-facing geometry controls are added.

## Required Material Selection

The current one-click request contains only STL bytes. This feature changes the flow so material evidence is available before kerf-sensitive geometry is created.

1. The user selects or drops an STL.
2. The tool validates the file name and size but does not start geometry processing.
3. The tool shows a required material-profile chooser containing built-in profiles and saved profiles that already pass the existing material-safety schema.
4. The user explicitly chooses one profile for this upload.
5. Selection immediately starts automatic conversion; no separate geometry settings or start button are added.

Changing the STL cancels the active job, clears the current material confirmation, and requires a new explicit material choice, even when the user intends to reuse the previous material. Invalid, forbidden, unknown-composition, or unapproved profiles remain unavailable under the existing material-safety rules.

The worker request receives a bounded immutable manufacturing subset rather than the complete editable profile:

- profile ID and display name;
- thickness in millimetres;
- kerf in millimetres;
- minimum feature in millimetres;
- minimum web in millimetres;
- fit allowances needed by the existing compensation kernel.

The worker validates this subset again after structured cloning. No operator name, batch notes, signature, contact data, or local repository metadata enters geometry fingerprints, warnings, or exports.

## Definitions

- **Top layer:** the ordered layer with the greatest `zEnd` along the selected slicing axis.
- **Second layer:** the layer immediately below the top layer in increasing Z order.
- **Launcher clearance:** the three black cut contours which receive the original three-hook launcher interface.
- **Canonical axis:** the already reconciled common central-hole axis.
- **Reliable top feature:** a closed, finite, simple engraving contour which passes the existing depth, size, containment, clearance, point, and runtime budgets.
- **Material-safe region:** the intersection of usable material across every layer relevant to a feature, inset by the existing material and cutting-clearance rules.

## Architecture and Processing Order

The automatic pipeline will use a geometry-first planner. Output formats must not add launcher or fastener geometry independently.

The ordered flow is:

1. Extract every layer exterior.
2. Reconcile the common central axle hole.
3. Detect or recover the three-hook launcher template.
4. Plan launcher clearance on the top two layers.
5. Plan a common screw-hole pattern through every layer.
6. Build black-cut protected regions.
7. Extract, rank, clip, and validate engraving contours.
8. Build one canonical colored document.
9. Generate SVG, DXF, preview PDF, exploded-view PDF, and the exact four-entry ZIP from that document.

This ordering makes physical cuts authoritative. Red and blue engraving may be clipped or omitted; black cut geometry may not be weakened to preserve engraving.

## Top-Layer Engraving Features

### Capacity

- The top layer may contain up to 12 `DEEP_RED` contours and 12 `LIGHT_BLUE` contours.
- Every other layer retains the current limit of at most one red and one blue contour.
- The layer exterior, shared central hole, launcher clearance, and screw holes do not count toward those engraving limits.

### Ranking

Reliable candidates are sorted deterministically by:

1. greater area;
2. greater normalized depth contrast;
3. lower boundary ambiguity;
4. minimum X, then minimum Y, as a deterministic tie-break.

The first 12 candidates in each color class are retained.

### Conflict handling

Engraving candidates are masked against:

- the shared central hole;
- launcher clearance;
- every retained screw hole;
- the exterior edge clearance;
- incompatible red/blue overlap under the existing depth-role rules.

Clipped fragments must independently remain closed, simple, within the point budget, and above the existing minimum feature-area threshold. Invalid or undersized fragments are omitted. The result reports the retained and omitted counts by color on the top layer.

### Data contract

The canonical model will use ordered arrays for engraving contours. A compatibility reader will migrate the current optional `deepFeature` and `lightFeature` values into zero-or-one-element arrays. New results are written only in the array representation. Validation bounds each array to 12 contours and each contour to 4,096 points.

## Three-Hook Launcher Clearance

### Automatic detection

The detector analyzes model geometry near the top face and canonical axis. A candidate launcher interface must have:

- three closed hook/lobe regions;
- successive hook-center angles within 120 degrees plus or minus 8 degrees;
- a common radial band around the canonical axis;
- finite, simple, non-self-intersecting contours;
- sufficient evidence on the source top geometry;
- a normalized contour which fits the existing point and runtime budgets.

Candidate scoring prioritizes central alignment, threefold symmetry, consistent radial distance, contour support, and size. The highest reliable candidate is used.

### Knight Fortress fallback template

The two user-supplied Knight Fortress STL files are analyzed during development and regression testing. Their detected hook contours are:

1. translated to the common axis;
2. rotated to a deterministic first-hook direction;
3. resampled to a common bounded point count;
4. compared for compatible topology and dimensions;
5. averaged point-by-point when compatible.

Only the resulting normalized numeric template and its provenance/version are committed. The STL files, local paths, and identifying metadata are not committed or exported.

Reference contours are compatible only when they have the same three-loop topology, corresponding hook-center radii differ by no more than 5%, corresponding hook areas differ by no more than 10%, and the symmetric mean point distance after alignment is no more than 0.50 mm. If any limit fails, template creation fails closed and no fallback template is published until the detector is corrected. It must not average incompatible shapes.

### Runtime behavior

- Use a reliable model-derived interface when available.
- Otherwise use the versioned Knight Fortress fallback template.
- Apply the exact same normalized launcher contours to the top and second layers.
- Translate them to the canonical axis and retain one common rotation.
- Apply the selected material profile's existing kerf compensation plus a fixed 0.20 mm radial assembly allowance.
- Do not scale the template merely to make it fit.

The complete launcher group must pass containment and clearance on both layers. If any hook is unsafe on either layer, omit the entire group and emit a sanitized warning that original-launcher compatibility could not be preserved safely.

Launcher contours use `CUT_BLACK` in every output.

## Screw-Hole Planner

### Physical target

- Finished hole diameter: 3.00 mm.
- All retained screw holes use identical centers on every layer.
- The selected material profile's existing inside-cut kerf compensation produces the 3.00 mm finished target.
- Hole contours use `CUT_BLACK` in every output.

### Search order

The planner searches the material-safe intersection of all layers after reserving the exterior, central hole, and launcher clearance.

1. **Three holes:** equal radius from the canonical axis, 120 degrees apart. Search rotations and radii from largest safe radius inward.
2. **Two holes:** equal radius, 180 degrees apart. Search rotations and radii from largest safe radius inward.
3. **One hole:** select the common location with the greatest minimum material thickness to all protected boundaries.
4. **Zero holes:** if no 3 mm finished hole is safe, omit the complete fastener pattern and emit a sanitized warning.

The planner always prefers more holes over a larger bolt circle. It may reduce the radius to retain the current hole count before degrading to fewer holes.

Every candidate pattern must pass containment and clearance on every layer. The result records the retained count, centers, compensated path diameter, finished target diameter, and selected rotation/radius where applicable.

## Material and Geometry Priority

The conflict priority is:

1. layer exterior structural validity;
2. common central axle hole;
3. launcher clearance on the top two layers;
4. common screw-hole pattern;
5. red and blue engraving.

Lower-priority geometry cannot invalidate or shrink higher-priority geometry. Launcher geometry is all-or-none across the top two layers. Screw geometry is all-or-none for the selected 3-, 2-, or 1-hole pattern across every layer.

## Processing Animation

### Timing

- The processing presentation lasts at least 8,000 ms from accepted file selection to result transition.
- Each stage is visible for at least 1,500 ms:
  - reading;
  - analyzing;
  - simplifying;
  - slicing;
  - packaging.
- The remaining minimum duration is used as a final transition hold, making the total at least 8,000 ms.
- If real processing takes longer, show the result immediately after processing and the current minimum stage presentation complete; do not add a second eight-second delay.
- Progress presentation remains monotonic even if worker events arrive faster or out of order.

### Motion

- Automatic horizontal rotation uses 50% of the current angular speed.
- Before parsed geometry exists, show only the truthful neutral loading state.
- After geometry exists, retain the real translucent wireframe through analysis, slicing, and packaging.
- Slicing and packaging retain the existing exploded transition.
- The compact upper-left status overlay remains unobtrusive.
- Manual rotate, zoom, and reset controls remain absent.

### Cancellation

Selecting another file cancels the previous worker job, preview, timers, delayed stage transitions, and final hold. No event or delayed completion from the old job may update the new job. File replacement also clears the previous material confirmation; the new job cannot start until a material is explicitly selected again.

Reduced-motion preference continues to disable continuous rotation while retaining staged geometry and progress information. Minimum timing still applies so stage text remains understandable.

## Result Summary and Warnings

The result page reports:

- launcher mode: detected, fallback template, or safely omitted;
- screw-hole mode: 3, 2, 1, or safely omitted;
- top-layer retained red and blue contour counts;
- top-layer omitted red and blue contour counts;
- material/kerf profile used for compensation;
- sanitized launcher, fastener, engraving, and existing central-hole warnings.

Warnings flow through the canonical document and both PDFs where they affect physical assembly or safety. They must obey the existing count, length, privacy, and control-character bounds.

## Error Handling

- Detector ambiguity falls back to the versioned Knight Fortress template.
- An unsafe detected or fallback launcher group is omitted with a warning; conversion continues.
- Screw patterns degrade 3 to 2 to 1 to 0; zero emits a warning and conversion continues.
- Individual unsafe engraving contours are omitted; conversion continues with counts.
- Invalid canonical geometry fails closed before artifact generation.
- A later artifact failure retains the completed real preview, geometry decisions, and warnings while withholding incomplete downloads and identifying only a validated bounded artifact.
- Time limits retain evidence without inventing an artifact identity.

## Output Contract

The completed page continues to offer exactly five downloads:

1. `cut-and-engrave.svg`
2. `cut-and-engrave.dxf`
3. `preview.pdf`
4. `exploded-view.pdf`
5. ZIP containing exactly the preceding four files

Every artifact must contain the same launcher, screw-hole, central-hole, and engraving decisions after its defined sheet-space transformation.

## Verification

### Unit and contract tests

- three-hook detection, centrality, threefold symmetry, deterministic rotation, rejection, and fallback;
- reference-template normalization, compatibility rejection, averaging, versioning, and privacy;
- identical top-two-layer launcher geometry and all-or-none safety behavior;
- 3/2/1/0 screw degradation, 120/180-degree symmetry, maximum safe radius, thickest single-hole location, all-layer containment, and warning provenance;
- material kerf compensation for launcher and 3.00 mm finished screw holes;
- required per-upload material selection, valid-profile filtering, worker-boundary revalidation, and replacement-file material reset;
- top-layer 12-red/12-blue limits, deterministic ranking, clipping, omission, array migration, and budgets;
- canonical validation rejecting mixed or inconsistent geometry;
- animation minimum total/stage times, half-speed rotation, monotonic events, cancellation, reduced motion, and slow-job behavior;
- warning privacy, bounds, PDF visibility, and exact artifact identity.

### Browser and integration tests

- real parsed model visibility throughout processing;
- compact overlay remains unobstructive on desktop and mobile;
- no manual camera controls;
- result summaries and warnings;
- exact five-download and four-entry ZIP contracts;
- SVG, DXF, PDF, exploded PDF, and ZIP reconciliation.

### Real-model and release tests

- Both supplied Knight Fortress STL files must run without skip.
- Their compatible detected launcher contours must produce the versioned numeric fallback template.
- Full unit, Chromium, typecheck, build, E2E, performance, and fixture suites must pass before integration.

## Acceptance Criteria

1. The top layer retains up to 12 reliable red and 12 reliable blue contours; lower layers retain current one-per-color behavior.
2. The launcher interface is detected or recovered from the Knight fallback and appears identically on the top two layers, or is omitted everywhere with a warning.
3. Screw holes safely degrade 3 to 2 to 1 to 0 and any retained pattern crosses every layer at identical centers.
4. Every engraving contour respects black-cut protected regions and clearance.
5. Material compensation targets a 3.00 mm finished screw hole and launcher assembly clearance.
6. Processing lasts at least 8 seconds, each stage at least 1.5 seconds, and automatic rotation runs at half the current speed.
7. File replacement cancels old processing and timing state.
8. Result summaries and both PDFs communicate assembly-relevant warnings.
9. All five downloads reconcile to the same canonical decisions, and ZIP still contains exactly four files.
10. User STL files and local paths remain private and uncommitted.
11. Every upload requires an explicit valid material selection before processing, and only the bounded manufacturing subset crosses the worker boundary.
