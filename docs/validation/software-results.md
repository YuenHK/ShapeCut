# Software validation results

Last verified: 2026-07-20

ShapeCut now exposes one workflow: selecting one STL immediately runs analysis, exact slicing when safe, otherwise bounded 2.5D largest-exterior projection, validation, and package generation. There are no repair, axis, material, decomposition, next-step, or export-confirmation controls in the main UI.

## Current automated evidence

- Safe acceptance STL: one selection reaches `exact` / `success` and downloads the five-record package.
- Open or empty inputs: fail closed in plain Traditional Chinese when no valid projected exterior exists.
- Both external Knight acceptance files: one selection reaches `outline-2.5d` / `warning`, shows `已簡化模型`, and downloads the package. External files are supplied only through environment variables and are never committed.
- Group acceptance reconciles a non-zero removed-component aggregate and ordered per-layer records across manifest JSON, project JSON, SVG, DXF, PDF, and the ZIP entries.
- Runtime integration starts from a structured-cloned `convertAutomatically()` result with genuine non-zero raster removal. Forged aggregate, layer, aggregate/layer mismatch, swapped identity metadata, and exact-mode non-zero evidence fail closed.

## Resource and responsiveness evidence

- The 100k-triangle browser test starts its elapsed clock immediately before file selection and its Long Tasks clock immediately before `setInputFiles`, therefore including input change and browser file reading. It must complete within 35 seconds with no application main-thread task of 100 ms or longer.
- The 500k-triangle case must end as a plain resource/time failure within 20 seconds.
- The latest local verification completed the 100k case in approximately 3.5 seconds and the 500k rejection in approximately 1.0 second. Timings vary by machine; fixed assertions remain authoritative.

## Output safety contract

All formats are regenerated from the same canonical CUT contours and provenance. Per-layer removal metadata binds layer ID, order, Z interval, and count; the aggregate must equal the layer sum. Exact output requires every removal count to be zero. ZIP records are exactly `cut.svg`, `cut.dxf`, `preview.pdf`, `project.json`, and `manifest.json`.

2.5D output remains an approximate outer-profile result, not a repaired 3D solid. Holes, internal details, and smaller disconnected components are removed. Output remains material-independent and supplies no laser power, speed, or passes.
