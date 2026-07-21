# Software validation results

Last verified: 2026-07-21

ShapeCut now exposes one workflow: selecting one STL immediately runs analysis, exact slicing when safe, otherwise bounded 2.5D largest-exterior projection, validation, and package generation. There are no repair, axis, material, decomposition, next-step, or export-confirmation controls in the main UI.

## Current automated evidence

- Safe acceptance STL: one selection reaches `exact` mode, displays a real WebGL wireframe/exploded viewport, and provides all five downloads.
- Synthetic stepped/holed mesh: exact mode retains one qualified black central hole plus reliable deep-red and light-blue regions; reduced-motion uses no animation frame and a WebGL-unavailable run produces the SVG fallback.
- Open or empty inputs: fail closed in plain Traditional Chinese when no valid projected exterior exists.
- Both external Knight acceptance files: 2/2 reach `outline-2.5d` / `warning` with zero skips and all five downloads. External files are supplied only through environment variables and are never committed.
- Group acceptance reconciles authentic non-zero removed-component evidence. Every reliable black/red/blue entity is reconciled across SVG, DXF, both PDFs and the ZIP records. For each retained real-file hole, the test independently recomputes finite/unique/simple geometry, orientation, strict containment, cell/diameter-based clearance, polygon area/diameter, centroid-to-axis distance, and translation-only runtime-to-export geometry.
- Runtime integration starts from a structured-cloned `convertAutomatically()` result with genuine non-zero raster removal. Forged aggregate, layer, aggregate/layer mismatch, swapped identity metadata, and exact-mode non-zero evidence fail closed.

## Resource and responsiveness evidence

- The complete safe conversion starts measurement immediately before `setInputFiles` and covers preview reception, explosion display, both-PDF packaging, URL creation, all five downloads and independent artifact parsing. It permits no main-thread task of 100 ms or longer.
- The 100k-triangle case must reach a typed resource/time classification within 35 seconds with no main-thread task of 100 ms or longer. The 500k-triangle case must reach a typed resource/time failure within 20 seconds.
- Cancellation begins only after the worker reports the real `pdf:create:before` packaging checkpoint, then selects another model, proves worker termination/replacement, and requires a complete second result.
- Latest local performance verification: complete safe conversion 2.3 seconds, 100k classification 30.7 seconds, 500k rejection 1.5 seconds, and packaging cancellation/replacement 3.9 seconds. Each complete-flow record also captures the active WebGL vendor/renderer; assertions remain backend-neutral because Chromium may use hardware acceleration or a software fallback. Timings vary by machine; fixed assertions remain authoritative.

## Output safety contract

All formats are regenerated from the same canonical colored contours and provenance. Black is `CUT_BLACK`, red is `DEEP_RED`, and blue is `LIGHT_BLUE`; these roles describe cut/relative depth and never literal machine settings. Layer order, ID, Z interval, feature ID, role, color, points, cardinality and all three fingerprints must reconcile. ZIP records are exactly `cut-and-engrave.svg`, `cut-and-engrave.dxf`, `preview.pdf`, and `exploded-view.pdf`, in that order, and are byte-identical to the four individual downloads.

A deterministic, non-secret removal-evidence fingerprint additionally binds the source hash, mode, and ordered layer ID/index/Z/count records. It detects accidental or runtime mutation, including sum-preserving count swaps; it is not cryptographic authentication against a party able to recompute the fingerprint.

2.5D output remains an approximate outer-profile result, not a repaired 3D solid. A central hole is retained only when its actual geometry passes the closed/simple/contained/clearance/near-axis rule and its equivalent diameter is at least `max(0.5 mm, layer width × 1%)`; missing or unreliable features are omitted. Output remains material-independent and supplies no laser power, speed, or passes.

## Fresh verification matrix

The final release run executes `npm test`, browser tests, both real Knight E2E cases, the full E2E suite, fixture validation, the dedicated performance suite, typecheck, production build, whitespace checks, and a final worktree/private-path audit. Exact suite counts below are recorded only from that fresh run.

| Command | Fresh result |
| --- | --- |
| `npm test` | 42 files, 1072 tests passed; exact artifact mutations 21/21 |
| `npm run test:browser -- --run` | 5 files, 38 tests passed |
| External fixture presence check | 2 files present |
| `npm run test:e2e -- --workers=1` | 15/15 passed, including Knight 2/2; 0 skipped |
| `npm run validate:fixtures` | 10/10 expected outcomes passed; 8 automatic successes |
| `npm run test:performance` | 4/4 passed; latest timings 2.3 s, 30.7 s, 1.5 s and 3.9 s |
| `npm run typecheck` | passed |
| `npm run build` | passed; 57 modules transformed |
