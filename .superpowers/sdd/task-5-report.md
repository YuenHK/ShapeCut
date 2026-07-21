# Task 5 report — real rotating and exploded process viewport

## Status

Complete. Added the standalone process viewport and scene controller without integrating the Task 6 application flow.

## RED evidence

- Added the viewport, scene-controller, and Chromium tests before production code.
- Focused unit command failed in 2 suites because `OutlineProcessViewport` and `outline-process-scene` did not exist.
- Chromium command failed in 1 suite for the same missing production module, confirming the intended feature gap.
- During self-review, a new visibility regression first failed because one RAF was scheduled before `IntersectionObserver` confirmed the host was visible; the controller was then changed to wait for a positive intersection.

## Implementation

- `OutlineProcessScene` consumes the transferred `Float32Array` positions and `Uint32Array` indices directly in one source `BufferGeometry`, then renders a transparent mint `WireframeGeometry`.
- Maps mesh and contours through one consistent reflected display frame; the containing scene rotates only around display Y.
- Builds actual per-layer exterior, central-hole, deep-red, and light-blue line geometry using canonical `#000000`, `#E5484D`, and `#3A78D4` colors.
- Adds a translucent mint scan plane, visible center axis, stage-aware scan position, and symmetric layer explosion around `(layerCount - 1) / 2`.
- Supports pointer drag, Left/Right keyboard rotation, `+`/`-` zoom, Home/R reset, and labelled on-screen controls.
- Uses RAF only after intersection visibility is confirmed, while the document is visible, and when reduced motion is off. Reduced motion applies stable rotation and the final stage explosion immediately.
- Falls back on absent WebGL or renderer construction failure to actual exterior/hole/red/blue SVG paths from the payload.
- Replacement and unmount cleanup covers source/wireframe/layer/plane/axis geometries, shared materials, canvas attachment, RAF, ResizeObserver, IntersectionObserver, document visibility listener, resize fallback, React pointer handlers, and reduced-motion media listener. Task 7 now releases one usable default renderer/context into a bounded idle pool for the next processing/result viewport; lost, excess, custom, and explicitly drained renderers are disposed with context loss.

## Verification

- Focused unit: 2 files, 7/7 tests passed.
- Real Chromium: 1 file, 1/1 test passed.
- TypeScript: `npm run typecheck` passed with no diagnostics.
- Full unit suite: 42 files, 1041/1041 tests passed.
- `git diff --check`: passed.

## Self-review and scope

- Verified mesh attributes retain the exact transferred typed-array objects rather than decorative/sample geometry.
- Verified all layer offsets are deterministic and symmetric along display Y, the mapped manufacturing axis.
- Verified canonical line colors and actual fallback path commands.
- Verified replacement disposes the old payload resources before retaining the replacement and dispose is idempotent.
- Verified the initial unknown intersection state cannot start continuous animation.
- No App, OneClickConverter, worker flow, E2E, documentation, package export, external STL, or Task 6 integration files were changed.

## Concerns

- None blocking. Task 6 still needs to pass the live preview payload/stage into this standalone viewport.

## Review follow-up: basis alignment, bounded fallback, and lifecycle ownership

### RED evidence

- X/Y/Z/oblique translated asymmetric mesh/contour regressions failed because extraction had no shared public basis helper and the viewport used independent mesh and contour transforms.
- A legal 24-layer payload carrying four 4,096-point contours per layer failed SVG fallback with `RangeError: Maximum call stack size exceeded`.
- Construction ownership evidence showed six materials were allocated for a black-only payload while only four were reachable for disposal.
- With `IntersectionObserver` unavailable, the scene incorrectly scheduled RAF; SVG fallback also exposed five focusable controls with no effect.
- The React boundary called `setPayload` immediately after the scene factory had already consumed the identical payload.

### Fixes

- Extracted `createOutlineAxisBasis` and `projectPointToOutlineBasis` from the raster projection path and made both extraction and viewport consume that single deterministic basis.
- Extended `OutlinePreviewPayload.axis` with `planeX`/`planeY`; the pipeline publishes them, runtime validation recomputes and checks them, the feature evidence fingerprint includes them, and structured clone tests retain them.
- Mesh vertices now use the display matrix `(planeX, axial direction, planeY)` about the selected origin. Layer contours remain in the matching X/Z extraction coordinates, use real axial midpoints on display Y, and add only the symmetric explosion offset. Independent contour-bounds recentering was removed.
- Replaced fallback spread-based bounds with iterative finite accumulation and covered the maximum legal 393,216-point input in unit and Chromium.
- Replaced scene traversal disposal with explicit geometry/material ownership registries and lazy role-material construction. Replacement, construction failure, and final disposal are idempotent and exact.
- RAF now remains stopped when intersection visibility cannot be established. Real Chromium covers non-reduced animation plus pause/resume.
- SVG fallback omits inert controls; WebGL controls are at least 44 x 44 CSS pixels. Status text is an `aria-live="polite"` status.
- The viewport records the payload consumed by its factory and skips the redundant initial `setPayload`, while still replacing a different payload exactly once.

### Verification

- Shared raster basis: 11/11 passed.
- Review-focused unit: 74/74 passed, including the viewport React boundary in addition to the requested `.test.ts` glob.
- Chromium viewport: 3/3 passed.
- Full unit suite: 42 files, 1053/1053 passed.
- TypeScript and diff checks passed before final commit.

### Concerns

- None blocking. Test-only preview fixtures were minimally extended with the required deterministic basis fields; no Task 6 runtime integration was added.
