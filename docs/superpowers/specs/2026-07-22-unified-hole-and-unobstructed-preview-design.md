# Unified Central Hole and Unobstructed Preview Design

Date: 2026-07-22
Status: Approved

## Goal

Improve the one-click conversion flow so every exported layer uses one safe, aligned central axle hole and the real model remains visible during loading, analysis, slicing, and packaging.

## Approved Decisions

- Use the same central-hole contour, size, and position on every layer.
- Prefer the largest reliable candidate that is safe for every layer, rather than blindly using the absolute largest candidate.
- Use a compact status overlay at the upper-left of the viewport.
- Remove zoom, reset, and similar viewport buttons from the rotating animation.
- Show the real parsed model as soon as geometry is available; do not fabricate a model before parsing completes.

## Unified Central-Hole Selection

### Candidate collection

The extractor continues to identify reliable central-hole candidates from individual layers. Each candidate retains its contour, center, confidence, and source-layer information.

### Global reconciliation

After layer extraction, the converter evaluates candidates globally:

1. Order reliable candidates from largest to smallest.
2. Align each candidate to the agreed model center.
3. Test the complete contour against every layer's safe interior region, including the existing edge-clearance rule.
4. Select the first candidate that safely fits every layer.
5. Copy that exact contour and center to every layer.

This produces a physically aligned axle passage through the complete laminated assembly. A candidate that would cut through any layer exterior is rejected even if it is the largest detected hole.

### No safe common hole

If no reliable candidate fits every layer, the conversion continues without a central cut. The result reports a visible warning that the central hole was omitted for structural safety. The tool must not silently substitute an unsafe cut.

### Output consistency

The reconciled central hole is the single source used by SVG, DXF, preview PDF, exploded-view PDF, and the corresponding files inside the ZIP archive. All output formats must therefore agree on position and geometry.

## Loading and Processing Viewport

### Before geometry is available

While the STL bytes are being read and parsed, show a short, minimal loading state. There is no rotating model during this interval because valid geometry does not yet exist.

### After parsing

As soon as parsed geometry is available:

- display the real model;
- rotate it horizontally at a steady speed;
- use the existing translucent wireframe treatment;
- automatically frame the model at a useful scale;
- keep the animation visible through analysis, slicing, and packaging.

During layer analysis and slicing, transition the same model into the existing exploded-layer visualization. Stage changes must not replace the viewport with a blocking card.

### Status presentation

Replace the large centered foreground panel with a compact translucent panel in the upper-left corner. It contains only the current stage, concise supporting text, and progress. Its footprint must remain small enough that the centered model is substantially unobstructed on desktop and mobile layouts.

### Controls

Remove zoom-in, zoom-out, and reset controls from the processing animation and completed rotating preview. Camera scale is managed automatically. The completed result may retain its layer selector because that control changes the reviewed layer rather than the camera.

## State and Error Handling

- Parse failure: stop and report the actual readable error; no false preview is shown.
- Simplification succeeds but no safe common hole exists: continue producing outputs and show the central-hole safety warning.
- A later export failure must preserve the same global-hole decision and report the affected artifact.
- The warning state must be represented consistently in the on-screen summary and relevant PDF safety notes.

## Acceptance Criteria

1. Every layer with a central cut has byte-equivalent or geometrically equivalent hole contours at the same coordinates.
2. The selected hole passes containment and clearance checks for every layer.
3. When no globally safe candidate exists, no layer receives a central cut and a warning is shown.
4. Once STL geometry has parsed, the real model rotates visibly without a large centered panel covering it.
5. Analysis and slicing show an unobstructed rotating exploded view.
6. No zoom, reset, or equivalent camera buttons appear in processing or completed animation views.
7. The completed layer selector remains usable.
8. SVG, DXF, both PDFs, and ZIP-contained artifacts use the same central-hole decision.

## Verification Scope

- Unit tests for global candidate ordering, all-layer containment, consistent propagation, and safe omission.
- Component tests for the compact upper-left status overlay and absence of camera controls.
- Browser tests covering pre-parse loading, post-parse rotation, exploded-stage transition, and mobile visibility.
- Knight Fortress regression tests using both supplied STL files.
- Export consistency checks across SVG, DXF, PDFs, and ZIP entries.
