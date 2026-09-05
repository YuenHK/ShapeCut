# Projected 2.5D containment optimization

The containment hot path prepares exterior scale and edge bounds once per call. Point classification retains its original per-point tolerance. Clearance retains the original running minimum and rejects as soon as that minimum proves insufficient. No UI, launcher rule, repair decision, projection, WASM rollout or geometric tolerance changed.

## Same-host comparison

Baseline commit: `65ca8d6`. Optimized production commit: `e09730c`.

Each external reference received one warmup and five measured `convertAutomatically` calls in Node on the same host, baseline before candidate. These measurements exclude artifact packaging and are not browser release-gate measurements. Baseline B included one 18.22-second outlier; the table reports medians and all five rounded samples below.

| Reference | Baseline median | Optimized median | Time reduction |
| --- | ---: | ---: | ---: |
| A | 14.232 s | 10.266 s | 27.9% |
| B | 14.701 s | 10.815 s | 26.4% |

Measured milliseconds:

- A baseline: 14506.266, 14231.674, 14060.479, 13796.813, 14250.768.
- A optimized: 10343.255, 10265.523, 10200.412, 10266.200, 10227.421.
- B baseline: 14555.404, 14550.544, 14701.037, 18219.478, 14921.398.
- B optimized: 10701.010, 10896.225, 11137.498, 10814.575, 10747.222.

Every warmup and measured result matched its reference baseline for mode, repair acceptance, layers, colored layers and assembly. On the last run of each case/version, `createOutlinePackage` generated and verified the six downloadable outputs. The five standalone artifact contents, project/manifest JSON and every unpacked ZIP member matched byte-for-byte by SHA-256 comparison. Private paths, geometry and hashes remain outside committed evidence.

## Scope of acceptance

Verification on the final production code:

- Hole-focused suite: 38/38 tests passed, including faithful legacy AABB and delayed cancellation regressions.
- Hole, depth-field, launcher and automatic pipeline integration: 4 files, 157 tests passed.
- Chromium worker default-TypeScript and actual-WASM canonical-artifact cases: 2 passed, 35 unrelated cases filtered out, unchanged 15-second per-test timeout.
- Typecheck and production build passed; 178 modules built.
- Independent task and final-scope review: zero Critical, Important or Minor findings.
- Working diff whitespace check passed.

The changes are committed on the local optimization branch; this report does not assert GitHub Pages deployment.

This confirms the targeted TypeScript optimization and identical reference outputs. It does not enable WASM or supersede the historical A3 blocked release evidence, establish a memory reduction, or complete physical launcher testing. Browser responsiveness and full packaging time must not be inferred from these conversion-only timings.

## Final polygon fast rejection

Production commit `df40d46` additionally rejects points outside the original tolerance-expanded segment bounds before computing segment length/cross products. The original terminal bounds remain, preserving non-finite behavior. Independent review found no blocking issues; a later-checkpoint cancellation trace was suggested as optional coverage, while checkpoint placement is unchanged.

The same baseline, host, harness, one warmup and five measured conversions were used again. All twelve canonical results and both final artifact sets match the baseline exactly. These remain Node conversion-only measurements, not browser or packaging timings.

| Reference | Baseline median | Final median | Time reduction |
| --- | ---: | ---: | ---: |
| A | 14.232 s | 9.612 s | 32.5% |
| B | 14.701 s | 9.994 s | 32.0% |

Measured final milliseconds:

- A: 9611.653, 9502.108, 9624.841, 9491.226, 9635.902.
- B: 9993.797, 9975.330, 10137.682, 10131.169, 9969.351.

Focused direct-dependency tests passed (6 files, 170 tests), and typecheck passed. Final release-wide verification is recorded separately after completion.
