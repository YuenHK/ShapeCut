# ShapeCut Apple Workbench UI Design

**Date:** 2026-07-23

**Status:** Approved in conversation; awaiting written-spec review

**Scope:** Visual and interaction redesign only. Geometry analysis, slicing rules, material safety, artifacts, and privacy behavior remain unchanged.

## 1. Goals

ShapeCut will use a bright silver-white, Apple-inspired workbench that makes the 3D model the visual center of a one-click fabrication flow. The experience should feel cinematic and highly crafted without hiding manufacturing status, warnings, or errors.

Success means:

- the upload-to-download flow remains one clear path;
- the model stays visible throughout upload, material selection, processing, completion, and failure;
- motion responds immediately, remains interruptible, and communicates the current operation;
- the full experience targets desktop and laptop screens, with a simplified responsive mobile presentation;
- reduced-motion, reduced-transparency, higher-contrast, low-capability, and WebGL-failure paths remain usable;
- all current output files and safety behavior remain unchanged.

## 2. Chosen Direction

The approved direction is a single central workbench with showcase-level motion throughout the entire flow. The visual language uses ShapeCut branding rather than copying macOS chrome or using Apple marks.

The implementation will combine:

- CSS for glass materials, responsive layout, focus feedback, and compositor-friendly surface transitions;
- the existing Three.js renderer for wireframe models, slicing, feature traces, particles, lighting, and depth;
- a small internal spring layer for direct UI feedback and reversible transitions;
- automatic full, energy-saving, and static effect levels.

No general-purpose animation framework will be added unless implementation evidence shows that the internal spring layer cannot meet the defined interaction contract.

## 3. Visual System and Layout

### 3.1 Workbench

- A single large central stage contains the model and remains the primary visual anchor.
- The page background uses restrained silver-white gradients, a subtle technical grid, and blue-white environmental light.
- The scene changes depth and illumination by workflow state, but the controls and status text retain stable positions and readable contrast.
- Contextual control cards appear around the model only when needed instead of permanently filling both sides.
- The top bar becomes a floating translucent toolbar containing ShapeCut identity, local-processing privacy status, and current-step wayfinding.

### 3.2 Upload and Cards

- The empty workbench doubles as the upload target.
- Drag entry adds a pointer-relative highlight, subtle parallax, and an inward magnetic response.
- Drop confirmation gathers the perimeter light toward the model origin.
- Material, status, warning, result, and error cards use continuous rounded corners, hierarchy-appropriate blur, bright top-edge highlights, and context-aware shadows.
- Light translucent surfaces are not stacked directly on other light translucent surfaces; nested content uses a more opaque inner material.

### 3.3 Typography and Color

- Use the platform system font stack with optical sizing enabled.
- Large titles use tighter tracking and leading; body and status copy use comfortable leading and neutral tracking.
- Black continues to mean cut, red continues to mean deep engraving, and blue continues to mean light engraving.
- Color is always paired with labels or recognizable geometry, so manufacturing meaning never relies on color alone.
- ShapeCut keeps a cool blue accent while neutral silver-white materials dominate the interface.

### 3.4 Responsive Behavior

- Desktop and laptop screens receive the full workbench, surrounding contextual cards, and complete environmental effects.
- Mobile uses one vertical workbench, fewer simultaneous floating cards, lower particle density, shallower depth, and bottom-docked contextual controls.
- The functional one-click flow and every safety message remain available on mobile.

## 4. Motion and Interaction

### 4.1 Motion Principles

- Press feedback begins on pointer-down, not after click completion.
- Interactive surfaces compress and brighten instantly, then return using a critically damped spring with no decorative overshoot.
- Momentum bounce is reserved for interactions that inherit actual gesture velocity.
- Panels open from their trigger and leave along the same path.
- An animation may be interrupted or reversed without waiting for its nominal completion.
- The implementation animates live presentation values and must not jump to a stale logical target after interruption.
- Layout-affecting properties are not animated in continuous sequences; use transforms, opacity, and renderer state.

### 4.2 Workflow Choreography

**Idle and upload**

- The transparent wireframe model, when available, rotates slowly around its vertical axis.
- Low-density contour particles and a quiet platform light remain active.
- Dragging a file over the workbench creates pointer-relative parallax and magnetic attraction.

**Reading and analysis**

- A transparent wireframe progressively resolves from the uploaded mesh.
- A scan plane travels through the model height while trustworthy contours briefly brighten.
- Status cards remain anchored to the model rather than replacing it.

**Simplification and slicing**

- The model transitions into an exploded view.
- Layers separate in processing order while the scene continues its slow horizontal rotation.
- Cut geometry receives black/neutral high-contrast traces, deep engraving receives red traces, and light engraving receives blue traces.
- Trace motion visualizes actual available preview geometry; it must not invent completed features.

**Packaging and completion**

- Layers briefly reassemble to confirm completion, then return to a readable exploded arrangement.
- SVG, DXF, preview PDF, exploded-view PDF, and ZIP cards materialize from the workbench with synchronized visual feedback.
- Downloads become actionable as soon as the artifacts are ready; animation never gates them.

**Failure**

- Continuous scene movement settles, the platform light dims, and the error card originates near the affected operation.
- No aggressive shake, flashing red field, or blocking decorative sequence is used.
- Retry and model replacement remain immediately available.

## 5. Component Architecture

`OneClickConverter` remains the owner of upload, reading, material, processing, result, and failure state. Geometry and packaging service interfaces remain unchanged.

New visual boundaries:

- `AppleWorkbench`: maps the current converter state to layout, lighting, surface, and effect-level presentation.
- `WorkbenchChrome`: floating toolbar, privacy indicator, current-step wayfinding, and contextual controls.
- `WorkbenchSurface`: upload target, material card host, processing status host, result host, and failure host.
- `WorkbenchScene`: extension of the existing Three.js preview integration.
- `MotionSurface`: reusable pointer-down feedback and interruptible spring transition primitive.
- `useEffectLevel`: resolves full, energy-saving, or static presentation.
- motion and material tokens: central definitions for response, damping, transforms, opacity, blur, radii, shadow, and color.

`WorkbenchScene` contains three independently controllable layers:

1. Model layer: wireframe rotation, scanning, and exploded slices.
2. Feature layer: cut, deep-engrave, and light-engrave traces derived from preview data.
3. Environment layer: platform rings, particles, illumination, and depth cues.

These layers consume presentation state only. They do not mutate converter state or manufacturing geometry.

## 6. Effect-Level Contract

### Full

- Complete wireframe rotation, scan, exploded movement, contour particles, depth, glow, and contextual shadows.
- Used when motion is allowed and renderer/device capability meets the defined threshold.

### Energy-saving

- Reduced particle count, shallower parallax, lighter shadows, lower render resolution where appropriate, and fewer simultaneous effects.
- Selected automatically for constrained renderer/device signals or sustained frame-budget pressure.
- All state and feature cues remain present.

### Static

- No continuous rotation, parallax, particle travel, large exploded displacement, or elastic response.
- State changes use short opacity cross-fades or immediate updates.
- Selected for `prefers-reduced-motion: reduce` and as the final renderer fallback.

Effect-level changes must not reset conversion, discard previews, delay cancellation, or alter output.

## 7. Accessibility and Fallbacks

- All operations remain available by keyboard with visible blue focus rings.
- Pointer interaction has an equivalent keyboard action.
- `prefers-reduced-motion: reduce` selects the static effect contract.
- `prefers-reduced-transparency: reduce` replaces glass blur with high-opacity surfaces.
- `prefers-contrast: more` uses near-solid surfaces, explicit borders, and stronger text/feature contrast.
- Large moving objects reduce opacity while travelling to limit visual discomfort.
- WebGL initialization or runtime failure falls back to CSS presentation and does not block conversion or downloads.
- Status, completion, warning, and error messages remain semantic live content where currently applicable.

## 8. Performance and Truthfulness

- The UI may warm render resources, but visual preparation cannot block file selection or conversion.
- Continuous motion uses `requestAnimationFrame` and pauses when the page is not visible.
- Effects are bounded by scene budgets; particle systems and trace effects have explicit maximum counts.
- The effect-level controller may downgrade during a session but does not automatically upgrade during active processing, avoiding visual instability.
- Presentation timers never claim a later processing state than the real pipeline state.
- Visual effects may hold an earlier presentation briefly for continuity, but downloads and errors bypass that hold immediately.

## 9. Error Handling

- Existing domain and artifact error messages remain authoritative.
- Visual-layer errors are isolated and reported as presentation degradation, not conversion failure.
- If scene data is incomplete, the UI shows the last trustworthy model or a neutral workbench rather than fabricated geometry.
- If a download artifact fails, the retained analysis, warnings, and any valid result information remain accessible as they are today.

## 10. Verification

Implementation verification will include:

- all existing unit, browser, build, typecheck, public fixture, and authorized private STL tests;
- state-to-presentation tests for upload, reading, material, every processing stage, result, and failure;
- reduced-motion, reduced-transparency, high-contrast, energy-saving, and WebGL-failure fallbacks;
- keyboard navigation, focus visibility, accessible names, and non-color feature identification;
- desktop primary viewport and mobile simplified viewport screenshot/interaction checks;
- interruption checks while changing model, cancelling, receiving an error, and downloading during motion;
- checks that animation never changes or delays generated SVG, DXF, PDFs, or ZIP contents;
- renderer lifecycle tests covering warm-up, visibility pause, downgrade, failure, and cleanup.

## 11. Out of Scope

- Changes to mesh repair, feature extraction, launcher clearance, fastener placement, material rules, slicing, or packaging.
- New output formats or changes to existing artifact names.
- Sound or haptic feedback.
- User-selectable visual themes beyond automatic accessibility and capability adaptation.
- A general animation framework dependency unless separately justified and approved.
- Direct imitation of macOS window controls or use of Apple trademarks.
