# Task 5 Report: WASM Segments in Canonical Extraction

## Status

DONE_WITH_CONCERNS. Production canonical extraction now consumes validated,
canonical-sorted WASM segments for sufficiently large batches. Small batches
select the existing TypeScript source before worker startup to avoid paying a
worker/WASM startup penalty; this is capability routing, not an error fallback.
TypeScript still owns topology, material validation, launcher planning,
canonical assembly, preview and all release artifacts.

No UI, CSS, typography, colour, layout, material rule, launcher rule or
production processing deadline was changed.

## TDD evidence

RED:

- The new segment-source suite initially failed because the module and adapter
  did not exist.
- Supplied segment batches were ignored by exact extraction and the automatic
  pipeline did not call an injected source.
- The real production worker acceptance timed out waiting for a WASM
  publication and then exposed a sanitized `NO_OUTLINE` result.
- Small-model real-worker tests exceeded their existing 15-second browser test
  limit after unconditional worker startup.

Root causes and GREEN:

- Added `ExactSegmentSource`, the existing TypeScript oracle and the WASM pool
  adapter; focused source/extraction tests pass 70/70.
- The original `NO_OUTLINE` was an unbounded `Infinity` pipeline deadline being
  rejected by the pool's safe-integer ownership contract. Only the transport
  representation is mapped to `Number.MAX_SAFE_INTEGER`; finite deadlines and
  production policy are unchanged.
- Added a 4,096 triangle-plane work threshold so small jobs select TypeScript
  before worker startup. Acceptance can explicitly force the real WASM route;
  private reference A/B remain above the production threshold.
- Restored the TypeScript oracle's original triangle-order segment traversal;
  only the differential copy and every WASM batch are canonical-sorted. This
  avoids changing the established downstream traversal cost.

## Implementation

- `segment-source.ts` owns immutable exact segment batches, deterministic
  endpoint direction/order for WASM, on-plane edge reconciliation, diagnostic
  comparison, Float32 precision preflight and the closed fallback boundary.
- Only trusted pool startup/load/execution failures marked eligible by the
  Task 4 pool may restart from TypeScript before publication. Cancellation,
  deadline, invalid request, precision validation, protocol validation,
  differential mismatch and post-result validation never fallback.
- Automatic extraction projects once, asks the selected source for segments,
  and gives the same projection and segments to the existing TypeScript
  topology reducer. Existing progress stages and public result shape remain
  unchanged.
- The publication boundary is carried into the pipeline: after an accepted
  WASM batch is returned, later exact-topology ambiguity fails closed and
  cannot switch to projected TypeScript extraction. TypeScript-oracle
  ambiguity during differential comparison is likewise converted to a
  non-fallback `DIFFERENTIAL_MISMATCH` before the publication callback.
- The production geometry worker owns one source and one pool. An
  acceptance-query-only probe proves publication without entering the public
  API or any artifact.

## Canonical and artifact verification

- Real Chromium raw-segment differential: 10/10 passed, covering closed, open,
  duplicate, stepped, disconnected, mixed-scale, degenerate, coplanar and
  one-sided non-manifold evidence plus unsafe-precision fail-closed behavior.
  Every successful case explicitly asserted `origin: wasm`, so compatibility
  fallback cannot make a differential fixture pass silently.
- Production worker acceptance: 1/1 passed. It observed actual WASM publication
  and matched TypeScript canonical layers, launcher decision, feature evidence
  fingerprint, and SHA-256 identities for the canonical SVG, DXF and launcher
  coupon.
- Outline package reconciliation: 449/449 passed. A test-only 30-second file
  timeout is evidence-based: the slowest isolated case was 18.1 seconds under
  the former 5-second default. No production deadline changed.
- Private fixture A and B each passed the production one-click browser flow,
  six-download reconciliation and the separate focused release download path.
  No private path, file name, geometry hash or model byte is recorded here or
  committed.

## Build, WASM and fixture gates

- Typecheck: passed.
- Rust: 22/22 passed (1 unit plus 21 integration tests).
- Raw WASM boundary: all 31 checks passed.
- Tracked generated artifacts: verified; pinned fresh regeneration reproduced
  all four files byte-for-byte.
- Public fixture validator: 10/10 passed, 8 automatic successes and output
  comparison passed.
- `/ShapeCut/` production build: passed. It emitted one hashed slice worker and
  one hashed WASM asset (`slice.worker-BoiGYt_n.js` and
  `geometry_wasm_bg-Bt8U_Fm2.wasm`); the hashed production geometry worker
  points to both under
  `/ShapeCut/assets/`, and the slice worker points to that same WASM. There are
  no source maps, private models or absolute local paths. The two pre-existing
  public sample STL files remain in the site bundle.

## Full-suite evidence and concerns

- Focused canonical serial run: 98/107 passed. All nine failures were the
  same geometry-heavy automatic-pipeline cases at the approved file-level
  20-second timeout. The timeout was not broadened.
- Fresh full serial Node: 73/75 files passed; 1,835/1,849 tests passed, 10
  failed and 4 skipped in 787.78 seconds. Nine failures were the same approved
  automatic-pipeline 20-second timeouts. The other was a genuine-package
  reconciliation test at its existing 5-second default; the work completed in
  18.979 seconds. There was no canonical or artifact assertion mismatch.
- Fresh full Chromium after the final publication fix: 8/9 files and 130/136
  tests passed. All six failures were existing 15-second geometry-worker
  timeouts. Focused production WASM publication and artifact invariance passed
  1/1 in 33.36 seconds; focused raw differential passed 10/10.
- Full E2E without private environment inputs: 12 passed, 1 skipped, 2 did not
  run and 3 failed. Two failures were only the absent private A/B environment
  inputs and both pass in the conditional private run. The remaining 100k
  synthetic case returned bounded `NO_OUTLINE` while its test expects only
  `RESOURCE_LIMIT` or `TIME_LIMIT`; no deadline or error mapping was weakened
  to hide that classification difference. This performance case already
  failed on the pre-Task-5 baseline by reaching no alert within 35 seconds;
  Task 6/7 own its resource/performance policy, so Task 5 does not relabel a
  genuine empty-topology result as a resource failure.

## Self-review and independent review

- `git diff --check` passed. Self-review confirmed no UI/CSS/typography/colour,
  production deadline, material, launcher or artifact-format edits.
- Generated screenshots and Vitest attachments are excluded from the commit;
  the controller-owned progress file remains untouched by this commit.
- Independent final re-review approved Task 5 with zero Critical and zero
  Important findings. The review specifically rechecked the post-publication
  no-mix boundary, non-fallback oracle ambiguity and per-fixture WASM-origin
  assertions.

This task does not claim the A3 two-times speed or memory target. Five-trial
performance acceptance remains Task 7 work.
