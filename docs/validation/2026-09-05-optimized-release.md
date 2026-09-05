# Optimized TypeScript release verification

Production code: `df40d46`. No UI styling, launcher tolerance or WASM default-off change.

Fresh local release verification on 2026-09-05:

- Serial Node suite: 80 files passed; 1,907 tests passed, 4 conditional skips.
- Chromium browser suite: 9 files, 142 tests passed with the configured 15-second timeout.
- End-to-end Chromium suite: 17 passed, 6 skipped. Both external reference cases were enabled; each completed twice with six reconciled, deterministic downloads. The skipped cases were the legacy checkout-relative reference lookup and five explicitly opt-in historical release benchmarks.
- Responsiveness: normal conversion had no 100 ms main-thread task through previews, PDFs and download URLs; the 100k-triangle case reached a bounded terminal classification. PDF packaging cancellation/replacement passed.
- Public fixture validation: all 10 expected outcomes passed, including intentional manual-axis and invalid-mesh classifications; output comparison passed.
- WASM boundary: 31 checks passed. Rust: 22 tests passed. These validate the dormant implementation, not eligibility to enable it.
- Pages-path production build: passed, 178 modules; tracked WASM artifacts verified.
- Historical WASM rollout verifier: passed in `--expect-blocked` mode. Its nine blocked gates remain unchanged and WASM stays disabled.
- Independent final-delta review: no Critical or Important findings. Optional later-checkpoint trace coverage is not a blocker; checkpoint placement is unchanged.

The same-host conversion medians improved by 32.5% and 32.0%, with identical canonical geometry and artifact contents; see [detailed comparison](2026-09-05-projected-optimization.md). This is not a claim of universal speedup, memory reduction or lossless handling of every mesh. The references continue to use the disclosed 2.5D warning-mode fallback.

Physical launcher fit, material, kerf and structural safety still require the supplied test coupon and real fabrication checks. Software output verification cannot certify physical compatibility.

Deployment is verified separately against the published commit and actual Pages assets after pushing; the local checks above alone do not prove publication.

## Cross-platform publishing diagnosis

The first Linux deployment attempt correctly stopped at the strict artifact verifier. Linux emitted 38,169 bytes versus the original macOS 38,157 bytes. Section inspection isolated the size difference to the non-executable `producers` custom section: Linux records `walrus 0.26.4` and `wasm-bindgen 0.2.127 (a579ee62b)`; the local source-built tool records `walrus 0.26.5` and `wasm-bindgen 0.2.127`. Equal section sizes alone do not prove equal executable content; strict regenerated artifact verification remains required after metadata normalization.

The runner also lacked `rg`. The old inverted shell privacy scan could therefore accept a missing executable as success. Both workflows now use a Node-only fail-closed scanner, tested with an empty PATH, forbidden inputs and no matching evidence files. Failures never print the offending content. Independent review found no blocking issues.

Commit `02eb9c1` strips only the `producers` section after validating one of the two observed exact producer pairs. It rejects unknown, missing, duplicated or truncated metadata. The new 38,095-byte file is byte-for-byte the original file without its final 62-byte metadata section; executable bytes are unchanged. The full artifact hash verifier is unchanged. Build/privacy contract tests (8), WASM boundary checks (31), local pinned regeneration and independent review passed. Linux regeneration must still confirm no other cross-platform differences.
