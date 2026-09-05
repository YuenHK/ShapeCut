# Projected geometry performance implementation plan

Approved scope: optimize the existing projected 2.5D path used by both external reference meshes.

## Constraints

Preserve all numerical predicates, tolerance formulas, canonical contours, hole selection, launcher placement/fit/exterior expansion, decoration omissions and six outputs. Preserve cancellation/deadlines. No UI changes. WASM remains default-off. No persistent cache of mutable caller geometry. Measure the same inputs on the same host; do not treat CPU sample percentages as speedup.

## Task 1: Containment hot path

Files: `src/domain/outline-features/hole.ts`, `src/domain/outline-features/hole.test.ts`.

Capture an independent baseline oracle for strict containment. Cover concavity, touching/crossing edges, midpoint escape, clearance threshold (including the existing 1e-12 allowance), translations, mixed scales, reversed loops, malformed/degenerate cases and cancellation. Reuse exterior scale within one call while retaining per-point tolerance semantics. Use precomputed conservative edge bounds only where the original predicate proves rejection. Avoid repeated full boundary distance calculation where the existing boolean clearance result can be determined early with identical semantics. Run focused geometry tests, typecheck and private output comparison. Commit implementation and measured report.

## Task 2: End-to-end evidence and review

Measure baseline and optimized reference A/B with one warmup and five timed conversions each on this host. Compare canonical output and all six artifacts; unpack ZIP contents rather than comparing timestamps. Record timing distributions and medians. Run relevant hole/depth/launcher/automatic suites and browser acceptance as warranted. Obtain independent correctness review of the complete change. If further polygon-intersection changes are needed, isolate them behind their own oracle tests before implementation. Do not claim release acceptance from a microbenchmark or change previously failed gates without evidence.
