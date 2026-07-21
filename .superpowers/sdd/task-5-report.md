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
- Maps the selected manufacturing-axis direction to display Y with a quaternion; the containing scene rotates only around display Y.
- Builds actual per-layer exterior, central-hole, deep-red, and light-blue line geometry using canonical `#000000`, `#E5484D`, and `#3A78D4` colors.
- Adds a translucent mint scan plane, visible center axis, stage-aware scan position, and symmetric layer explosion around `(layerCount - 1) / 2`.
- Supports pointer drag, Left/Right keyboard rotation, `+`/`-` zoom, Home/R reset, and labelled on-screen controls.
- Uses RAF only after intersection visibility is confirmed, while the document is visible, and when reduced motion is off. Reduced motion applies stable rotation and the final stage explosion immediately.
- Falls back on absent WebGL or renderer construction failure to actual exterior/hole/red/blue SVG paths from the payload.
- Replacement and unmount cleanup covers source/wireframe/layer/plane/axis geometries, shared materials, renderer/context, canvas, RAF, ResizeObserver, IntersectionObserver, document visibility listener, resize fallback, React pointer handlers, and reduced-motion media listener.

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
