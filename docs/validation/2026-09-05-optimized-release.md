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
