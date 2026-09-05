# Software validation results

Performance matrix verified: 2026-09-04. Reference routing diagnosis verified: 2026-09-05.

## WASM geometry A3 release decision

Production WASM remains off. On the same Apple Silicon/Chromium host, each external reference received one warmup followed by five measured runs. Reference A conversion-stage median was 15.523 seconds and complete upload-to-reconciled-six-download median was 15.794 seconds. Reference B medians were 16.534 seconds and 16.798 seconds. All ten measured reference runs completed without WASM publication. A fresh source-file diagnosis on 2026-09-05 established that both references have rejected safe repairs and go directly to TypeScript projected extraction; neither enters the exact segment source or its Float32 preflight. The earlier attribution to post-projection rounding was incorrect. The result still fails both the actual-WASM gate and the `both <=15 seconds` performance alternative.

The automatically generated synthetic 200k/500k/1M selection-to-terminal medians were 14.936/2.243/3.221 seconds. Each model's own production job reached typed `RESOURCE_LIMIT`, including 1M well inside 120 seconds; none published canonical WASM segments. Across the 18 runs, the longest observed main-thread task was 291 ms, so responsiveness also remains a failed release gate. Runtime-attributable peak observations were 38,896,356/25,096,084/50,096,084 bytes. No comparable pre-Task-6 runtime owner observation exists, so the required 30% reduction is not claimed.

Canonical differential geometry, launcher fingerprint/rotation/fit/exterior-expansion/decoration-omission decisions, layers, the six downloads, and unpacked canonical ZIP members remain covered by the existing Node, Chromium, private fixture, and E2E gates. The physical official-launcher coupon fit test remains external and outstanding. A future transform-aware exact path requires a new differential contract, but cannot improve these two references while their existing projected-extraction route is preserved. Reference performance work must first profile that route.

ShapeCut now exposes one workflow: selecting one STL immediately runs analysis, exact slicing when safe, otherwise bounded 2.5D largest-exterior projection, validation, and package generation. There are no repair, axis, material, decomposition, next-step, or export-confirmation controls in the main UI.

## Current automated evidence

- Safe acceptance STL: one selection reaches `exact` mode, displays a real WebGL wireframe/exploded viewport in a consistent reflected display frame, and provides all six downloads.
- Synthetic stepped/holed mesh: exact mode retains one qualified black central hole plus reliable deep-red and light-blue regions; reduced-motion uses no animation frame and a WebGL-unavailable run produces the SVG fallback.
- Open or empty inputs: fail closed in plain Traditional Chinese when no valid projected exterior exists.
- Both external Knight acceptance files: 2/2 reach `outline-2.5d` / `warning` with zero skips and all six downloads. External files are supplied only through environment variables and are never committed.
- Group acceptance reconciles authentic non-zero removed-component evidence. Every reliable black/red/blue entity is reconciled across SVG, DXF, both PDFs and the ZIP records. A bounded test-only worker probe captures every raw exact/projected hole candidate before selection; for every real-file layer, the test independently recomputes qualification, nearest-axis banding, largest-area/min-X/min-Y tie-breaking, retained identity/geometry/diagnostics, and omission when none qualify. Both Knight files pass with zero skipped layers.
- Runtime integration starts from a structured-cloned `convertAutomatically()` result with genuine non-zero raster removal. Forged aggregate, layer, aggregate/layer mismatch, swapped identity metadata, and exact-mode non-zero evidence fail closed.

## Resource and responsiveness evidence

- The complete safe conversion starts measurement immediately before `setInputFiles` and covers preview reception, explosion display, both-PDF packaging, URL creation, all six downloads and independent artifact parsing. It permits no main-thread task of 100 ms or longer.
- The 100k-triangle case must reach a typed resource/time classification within 35 seconds with no main-thread task of 100 ms or longer. The 500k-triangle case must reach a typed resource/time failure within 20 seconds.
- Cancellation uses a legal 24-layer, four-contour-per-layer, 512-point-per-contour workload (49,152 points). The test asserts those cardinalities before checking cancellation, waits for the actual worker `pdf:create:before` checkpoint, then proves termination/recreation and a complete replacement result. The 1,024-point-per-contour maximum-layer variant returns typed `TIME_LIMIT` at the real worker boundary in 30.26 seconds; the 512-point variant completes locally in 24.51 seconds.
- Latest local performance verification: the dedicated four-case suite passed in 51.7 seconds overall; its 100k classification case completed in 30.7 seconds. The fresh full E2E run also completed its 100k classification case in 30.3 seconds. Each complete-flow record captures the active WebGL vendor/renderer; assertions remain backend-neutral because Chromium may use hardware acceleration or a software fallback. Timings vary by machine; fixed assertions remain authoritative.

## Output safety contract

All formats are regenerated from the same canonical colored contours and provenance. Black is `CUT_BLACK`, red is `DEEP_RED`, and blue is `LIGHT_BLUE`; these roles describe cut/relative depth and never literal machine settings. `preview.pdf` draws every contour at the exact canonical fabrication-sheet coordinate used by SVG and DXF, while its display uses a consistent reflected display frame. Both PDFs visibly state that red/blue are relative processing levels and that machine-specific settings follow material test cuts. Layer order, ID, Z interval, feature ID, role, color, points, cardinality and all three fingerprints must reconcile. SVG and DXF parsers consume their complete root/section streams and recompute the exact 5 mm margin/gap/row layout extents from rendered entities before accepting SVG mm dimensions/viewBox or DXF `EXTMAX`. PDF acceptance validates the envelope/xref endpoint, exact reachable indirect-object set, page tree, boxes, resources, font encoding, decoded visible labels, dictionary keys/name values, string objects, and the decoded canonical content stream. The five ZIP artifact members are `cut-and-engrave.svg`, `cut-and-engrave.dxf`, `preview.pdf`, `exploded-view.pdf`, and `launcher-fit-coupon.svg`; each is byte-identical to its standalone download. The ZIP also carries canonical `project.json` and `manifest.json` records.

A deterministic, non-secret removal-evidence fingerprint additionally binds the source hash, mode, and ordered layer ID/index/Z/count records. It detects accidental or runtime mutation, including sum-preserving count swaps; it is not cryptographic authentication against a party able to recompute the fingerprint.

2.5D output remains an approximate outer-profile result, not a repaired 3D solid. A central hole is retained only when its actual geometry passes the closed/simple/contained/clearance/near-axis rule and its equivalent diameter is at least `max(0.5 mm, layer width × 1%)`; missing or unreliable features are omitted. Output remains material-independent and supplies no laser power, speed, or passes.

## Fresh verification matrix

The final release run executes `npm test`, browser tests, both real Knight E2E cases, the full E2E suite, fixture validation, the dedicated performance suite, typecheck, production build, whitespace checks, and a final worktree/private-path audit. Exact suite counts below are recorded only from that fresh run.

| Command | Fresh result |
| --- | --- |
| `npm test -- --maxWorkers=1 --fileParallelism=false` | 78/78 files; 1874 passed, 4 skipped |
| `npm run test:browser -- --run` | 9/9 files; 142/142 passed under the unchanged 15-second per-test gate |
| External fixture presence check | 2 files present; full private validation 2/2 passed |
| `npm run test:e2e -- --workers=1` | 19 passed, 3 truthful conditional skips; external A/B both passed |
| `npm run validate:fixtures` | 10/10 expected outcomes passed; 8 automatic successes; launcher runtime A/B passed |
| Fixed-host synthetic release benchmark | 18/18 runs reached a typed terminal outcome; one warmup and five measured runs for 200k/500k/1M. Release thresholds are evaluated separately and are not implied by this count. |
| `cargo test --locked --manifest-path crates/geometry-wasm/Cargo.toml` | 22/22 passed |
| Raw WASM boundary | 31/31 passed |
| Release verifier | Correctly exits non-zero for the current default-off evidence and reports nine unmet software gates; unsupported validation claims remain false/unknown |
| `npm run typecheck` | passed |
| `npm run build` | passed; 178 modules transformed; one hashed WASM and one hashed slice-worker asset; zero source maps |
