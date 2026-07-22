# ShapeCut Colored Features and Exploded Preview Design

**Date:** 2026-07-21  
**Status:** User-approved design, pending written-spec review  
**Scope:** Extend the existing one-click ShapeCut workflow with a retained central hole, two depth-derived engraving features, real 3D progress visualization, and revised downloadable artifacts.

## Goal

Preserve more useful geometry from an uploaded STL without returning to an engineering wizard. Each layer keeps its largest exterior, one reliable central axle hole, and up to two reliable depth-derived surface features. The browser visualizes the real model and real layers throughout processing. Outputs remain one-click, fail-closed, and independent of any specific material or laser machine.

## User Decisions

- Red and blue are semantic processing levels only. They do not encode actual laser power, speed, passes, or material settings.
- Per layer:
  - black contains the largest exterior and the largest reliable central hole;
  - red contains the largest reliable deeper surface feature;
  - blue contains the largest reliable shallower surface feature.
- The central hole is the largest enclosed hole nearest the selected rotational axis. Its position may vary slightly by layer.
- A hole is retained only when its equivalent diameter is at least `max(0.5 mm, 1% of the layer model width)`.
- Red and blue features come from an adaptive per-layer surface-depth map. Depth, not area order alone, chooses red versus blue.
- The processing visualization uses the approved centered exploded-view direction: transparent wireframe, horizontal rotation, axial layer expansion, and real colored feature overlays in a consistent reflected display frame.
- The exploded-view PDF includes layer order, thickness, X/Y dimensions, central-hole diameter, central axis, and a color legend.
- Downloads are SVG, DXF, preview PDF, exploded-view PDF, and a ZIP containing exactly those four files.

## One-click Data Flow

1. The user selects one STL. The existing 128 MiB pre-read and worker-boundary limits remain in force.
2. After bytes are available and parsing begins, the page renders the actual mesh as a transparent mint wireframe rotating horizontally around the selected vertical display axis.
3. The restartable geometry worker parses, analyzes, selects an axis, repairs only where the existing safety contract permits, and schedules 6–24 deterministic layers.
4. For each layer, the worker builds:
   - the retained largest exterior;
   - candidate enclosed holes;
   - an adaptive surface-depth field for engraving features.
5. The layer analyzer selects and validates the central hole, deeper feature, and shallower feature. It never invents a missing feature.
6. As real layers become available, the UI changes from a scanning-plane visualization to an axial exploded view. The displayed lines are derived from validated layer records, not decorative placeholders.
7. The packaging worker creates and verifies the four individual artifacts and the ZIP under the existing shared deadline and hard worker-replacement cancellation contract.
8. The result page exposes the primary ZIP download, four secondary downloads, the interactive exploded view, warnings, and expandable technical data.

## Layer Geometry Model

Each validated layer contains the following distinct geometry roles:

```ts
type ColoredFeatureLayer = {
  readonly id: string;
  readonly index: number;
  readonly zStart: number;
  readonly zEnd: number;
  readonly exterior: ClosedPolygon;
  readonly centralHole?: ClosedPolygon;
  readonly deepFeature?: ClosedPolygon;
  readonly lightFeature?: ClosedPolygon;
  readonly diagnostics: LayerFeatureDiagnostics;
};
```

The representation keeps the central hole separate from the exterior rather than reverting to unrestricted polygon holes. The exporter interprets `exterior` and `centralHole` as black CUT geometry. `deepFeature` and `lightFeature` are closed engraving regions and are never treated as cut holes.

### Exterior

- Preserve the existing component-local, pre-grid bounds evidence and direct X/Y span-drift limit.
- Retain only the largest valid exterior component.
- Reject the entire conversion if the exterior is empty, open, self-intersecting, degenerate, outside resource/deadline limits, or exceeds fidelity drift.

### Central hole

- Enumerate enclosed voids inside the retained exterior before the hole-filling step used by the simplified 2.5D fallback.
- Treat nested closed loops as hole candidates; multiple disjoint exterior loops remain exact-contour ambiguity and use the existing projected fallback rather than being misclassified as holes.
- Order qualified candidates by centroid distance from the selected axis. Consider every candidate within `max(0.5 mm, 2% of layer width)` of the nearest distance to be equally central, then select the greatest area, breaking a remaining tie by lowest minimum X then Y. This prevents a remote decorative opening from replacing the axle hole without allowing tiny axis noise to beat a substantially larger near-axis hole.
- Require a finite, simple, closed contour strictly inside the exterior.
- Require equivalent diameter `>= max(0.5 mm, layer width * 0.01)`.
- Retain at most one central hole per layer.
- Do not synthesize or propagate a hole into a layer where no reliable candidate exists.
- If the hole is invalid, omit it and emit a sanitized warning; the valid exterior may still be exported.

### Adaptive depth features

- Project actual source-triangle surface depth within the layer and retained exterior into a bounded height/depth field; do not derive depth from the already-simplified outline.
- Exclude the central-hole area and a safety clearance around black CUT geometry from feature candidates.
- Derive adaptive bands from the layer's finite, non-zero depth samples. Red contains samples at or above the 75th percentile; blue contains samples from the 40th percentile up to, but not including, the red threshold. Require useful depth contrast of at least `max(2 * raster cell size, 0.5% of layer planar diameter)`; otherwise omit both feature bands. These relative thresholds allow differently scaled models without fixed millimeter depths.
- Morphologically clean each band, fill incidental micro-holes, label connected regions, and keep only the greatest valid connected region for that band.
- Red is the deeper retained region; blue is the shallower retained region. Area does not reverse their depth meaning.
- A feature must be finite, closed, non-self-intersecting, above a bounded minimum area, strictly contained by the exterior, and disjoint from the central hole and its clearance.
- A layer may contain zero, one, or two engraving features. Missing or unreliable features are omitted rather than fabricated.

## Color and Machine Semantics

The canonical roles and colors are:

| Role | Color | Meaning |
| --- | --- | --- |
| `CUT_BLACK` | `#000000` | Exterior and central axle hole; intended cut geometry |
| `DEEP_RED` | `#E5484D` | Deeper engraving-level region |
| `LIGHT_BLUE` | `#3A78D4` | Shallower engraving-level region |

Red and blue do not mean literal 80% or 40% machine power. The UI and both PDFs state that colors are relative processing levels. Users must assign machine-specific settings externally after material-specific test cuts.

No output may contain material profiles, power percentages, speeds, pass counts, production-ready claims, private paths, email addresses, or the source STL.

## Visualization and Interaction

### Loading and parsing

- As soon as parsed vertices are available, render the actual mesh as a mint transparent wireframe on the existing white/mint background.
- Rotate horizontally at a slow constant rate.
- Never retain the model after reload or embed it in an output.

### Analysis

- Animate a scanning plane through the model.
- Add real exterior, hole, red-feature, and blue-feature lines only when their corresponding validated layer data exists.
- Progress text remains accessible through `role="status"` and does not rely on animation alone.

### Layering

- Expand validated layers along the selected axis into a centered exploded view.
- Continue slow horizontal rotation while processing.
- Display black, red, and blue overlays using the same canonical color roles as the exports.

### Result

- Keep the actual exploded view interactive: pointer/keyboard rotation where supported, zoom, and reset.
- Show layer order and allow a layer to be highlighted without editing manufacturing geometry.

### Accessibility and fallback

- With `prefers-reduced-motion`, stop automatic rotation and replace scanning/explosion motion with direct state changes and short opacity transitions.
- Without WebGL, render an SVG wireframe/layer fallback from the same validated geometry. Preview failure never blocks successful geometry conversion.
- All controls retain visible focus and a minimum 44 px target.
- Mobile layouts remain single-column and avoid side-by-side views.

## Artifact Contract

All artifacts are generated from one validated colored-feature document and carry matching source, geometry, diagnostics, layer-order, and feature fingerprints.

### `cut-and-engrave.svg`

- Separate groups for each physical layer.
- Within every layer, separate `CUT_BLACK`, `DEEP_RED`, and `LIGHT_BLUE` groups.
- Exterior and central hole use black geometry.
- Metadata identifies layer order and Z range without exposing private data or machine settings.

### `cut-and-engrave.dxf`

- Three explicit layers: `CUT_BLACK`, `DEEP_RED`, and `LIGHT_BLUE`.
- Include both standard ACI and true-color values where supported.
- Preserve physical layer identity and order in entity metadata.
- Do not write power, speed, passes, or material records.

### `preview.pdf`

- Show the flat sheet layout used for fabrication.
- Include layer number, scale, and black/red/blue legend.
- Render the exact same cut and engraving geometry as SVG/DXF.

### `exploded-view.pdf`

- Render a vertical exploded assembly around a visible central axis.
- Label assembly order, layer number, Z thickness, X/Y dimensions, and detected central-hole diameter.
- Include the black/red/blue legend and the machine-setting disclaimer.
- If a layer has no reliable hole or feature, show an explicit dash rather than an invented value.

### `shapecut-files.zip`

The ZIP contains exactly:

1. `cut-and-engrave.svg`
2. `cut-and-engrave.dxf`
3. `preview.pdf`
4. `exploded-view.pdf`

It contains no JSON, manifest, STL, directory entry, or additional file. Each ZIP payload must be byte-identical to its individual download. Technical fingerprints remain embedded in the four artifacts and in the in-memory verified document; no standalone diagnostic file is downloaded.

## UI Downloads

- Primary action: download `shapecut-files.zip`.
- Secondary actions: download each of the four individual files.
- Remove the current JSON/manifest download.
- Revoke all five object URLs on replacement, retry, failure, or unmount.
- Generic output names must not derive from private source paths or user filenames.

## Error and Warning Policy

- Invalid exterior: fail the conversion and provide no manufacturing artifacts.
- Invalid or absent central hole: omit only the hole and warn.
- Invalid or absent deep/light feature: omit only that feature and warn.
- A result with an omitted requested feature uses warning status, but the warning text distinguishes feature omission from 2.5D simplification.
- Resource or time limit: fail with the existing typed Traditional Chinese error contract.
- New file selection terminates in-flight parsing, feature extraction, animation-data preparation, and packaging through worker replacement and stale-result gating.
- WebGL/preview failure: fall back visually and continue geometry processing.

## Verification and Acceptance

### Geometry tests

- Exterior remains component-local and within the existing direct 3% span-drift limit.
- The closest qualifying central hole wins; remote decorative holes, micro-holes, open gaps, nested noise, and self-intersections are rejected.
- Hole threshold uses the exact `max(0.5 mm, 1% width)` rule.
- Red and blue regions are chosen by depth band, not reversed by area.
- At most one hole, one red feature, and one blue feature exist per layer.
- Every engraving feature is strictly inside the exterior and outside the hole clearance.
- Triangle order and worker serialization do not change the result.

### Artifact reconciliation

- Parse SVG and DXF into exact ordered colored-feature records.
- Regenerate and byte-check both PDFs.
- ZIP has exactly four records and no unsafe or sanitized alternative names.
- Individual and zipped payloads are byte-identical.
- Mutated color, role, hole, feature, layer order, dimensions, or fingerprint fails verification.
- Privacy/process/material scanners cover every artifact and ZIP record.

### UI and browser tests

- Real mesh wireframe appears after parsing and rotates horizontally.
- Real scan/layer data drives the explosion animation.
- Reduced-motion and no-WebGL fallbacks remain usable.
- Selecting a replacement file hard-cancels analysis and packaging without stale frames or URLs.
- Result exposes exactly the ZIP plus four individual downloads.

### Real fixtures and performance

- Both external Knight Fortress files complete without repair/axis/material interaction.
- Each produces a reliable central-hole result where the source geometry supports it; a test must not force a hole if the actual source has none.
- Real outputs contain valid black geometry and any reliable red/blue features derived from the mesh.
- The Group model still removes smaller disconnected components while retaining component-local bounds.
- Existing 100k/500k resource, main-thread, deadline, build, fixture, typecheck, and privacy matrices remain release gates.

## Out of Scope

- Literal laser power percentages or automatic machine recipes.
- Material-specific speed, passes, kerf, or production approval.
- Manual feature painting or per-layer editing.
- More than one central hole or more than two engraving feature regions per layer.
- Re-embedding the STL or a standalone JSON/manifest in the ZIP.
- Cloud upload or server-side model processing.
