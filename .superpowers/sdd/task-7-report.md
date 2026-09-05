# Task 7 implementation report

## Release decision

Production WASM remains disabled by default. The fixed-host release verifier correctly exits 1 and reports:

- `knight-performance`
- `knight-actual-wasm`
- `synthetic-actual-wasm`
- `live-byte-baseline`
- `main-thread-responsiveness`
- `cancellation`
- `canonical-geometry`
- `production-bundle`
- `private-acceptance`

The physical official-launcher coupon fit test is separately reported as external and outstanding. This task does not claim whole-branch approval or physical launcher acceptance.

## TDD RED to GREEN

- Release verifier RED: the focused suite could not resolve the missing verifier module. GREEN: the strict canonical evidence parser now requires five distinct measured job generations per case and rejects reused/cross-generation publication evidence. The generator has its own regeneration and hostile-schema tests; it consumes committed raw measurements plus a separate validation sidecar instead of inventing pass values.
- Workflow RED: two build-contract tests failed because `.github/workflows/ci.yml` was absent and Pages lacked locked Rust/browser/release gates. GREEN: 19/19 combined release/workflow contract assertions pass. CI and Pages now pin the Rust toolchain and wasm-pack, cache locked Cargo inputs, run `cargo test --locked`, regenerate/verify WASM, run serial Node and Chromium differential tests, exercise the release verifier contract, verify the committed blocked evidence state, and inspect the production build.
- Actual-WASM RED: the first private benchmark run expected an active WASM partition but observed none. The original attribution to post-projection Float32 eligibility was not established by that observation and was disproved by the 2026-09-05 source-file diagnosis: both references have rejected safe repairs and bypass the exact segment source entirely. The release verifier still requires both `origin: wasm` and an actual partition observation for both references.
- Harness RED: the first draft expected the long-lived geometry worker count to be zero after successful output, then a repeated run restored the saved project and blocked the material selector. GREEN: the benchmark uses the existing discard-project control between trials and emits append-safe per-trial sanitized evidence. It completed both references in 3.6 minutes.
- Per-run evidence RED: the reference probe exposed cumulative publications and the synthetic raw schema confused repeat indices with worker generations. GREEN: each reference run now consumes only publications after its prior cursor; every raw trial carries a globally unique sanitized `runId`, while `jobGeneration` exists only inside an observed publication. Synthetic resource/time/no-outline terminals retain `layerCount: null`; a successful job must carry the actual positive layer count and a publication must match it. A positive generator integration builds five measured real-publication records for every case and passes the release verifier, while the committed fallback evidence remains blocked.
- Generation reset RED: the verifier incorrectly required worker generation to be unique across independent page jobs. GREEN: only `runId` is globally unique; each publication merely requires its own `jobGeneration === generation`. The positive generator integration now deliberately uses generation `1` on every fresh-page run and remains eligible. A scoped Chromium E2E uses the same terminal logger as the synthetic harness and recorded a real successful result with a positive layer count in 9.1 seconds.

No production geometry predicate, tolerance, UI, style, typography, colour, layout, launcher rule, artifact rule, or exact Float32 eligibility rule was relaxed.

## Fixed-host benchmarks

Host contract: Apple Silicon arm64, Chromium, one warmup then five measured runs, single worker. Private input paths, filenames and geometry hashes are absent from the committed evidence and report.

| Case | Measured interval | Measured values (ms) | Median (ms) | Actual WASM |
| --- | --- | --- | ---: | --- |
| Reference A | conversion stage | 15529, 15513, 16036, 15515, 15523 | 15523 | no; TypeScript fallback |
| Reference A | upload to reconciled six downloads | 15794, 15796, 16320, 15781, 15791 | 15794 | no; TypeScript fallback |
| Reference B | conversion stage | 16530, 16548, 16534, 16525, 16536 | 16534 | no; TypeScript fallback |
| Reference B | upload to reconciled six downloads | 16793, 16813, 16798, 16822, 16789 | 16798 | no; TypeScript fallback |
| Synthetic 200k | selection to typed terminal | 14951, 14936, 14936, 15838, 13926 | 14936 | no publication; TypeScript/resource path |
| Synthetic 500k | selection to typed terminal | 2249, 2243, 2242, 2248, 2231 | 2243 | no publication; TypeScript/resource path |
| Synthetic 1M | selection to typed terminal | 3268, 3218, 3217, 3737, 3221 | 3221 | no publication; TypeScript/resource path |

The Knight target fails: neither reference is at or below 15 seconds and no actual WASM partition was used. The 2026-09-05 route diagnosis confirms both references directly use projected extraction after rejected safe repairs. Transform-aware exact slicing does not accelerate that branch. Profile the projected route before selecting the next optimization; preserve repair decisions and canonical output.

## Memory, responsiveness and cancellation

- Synthetic runtime-attributable peaks: 38,896,356 / 25,096,084 / 50,096,084 bytes for 200k / 500k / 1M.
- Longest main-thread task across the 18 fixed-host synthetic runs: 291 ms; the 100 ms responsiveness gate failed.
- Every synthetic job reached typed `RESOURCE_LIMIT`; the 1M median was 3.221 seconds and every 1M trial was inside 120 seconds. No synthetic job published WASM segments.
- The current runtime tracker covers STL, parsed/safe-repair/extraction meshes, bounded preview, WASM batch, partition copies/metadata/results, simultaneous merge inputs/output, retained preview, and cleanup.
- There is no comparable pre-Task-6 runtime-owner observation. The report therefore does not derive a theoretical denominator or claim a 30% reduction; the verifier emits `live-byte-baseline` and blocks release.

## Geometry and artifact acceptance

- Public fixture validator: 10/10 expected outcomes; 8 automatic successes; output comparison passed.
- Private runtime validator: 2/2 references passed. Fixed launcher status, one safe plan, six artifact cuts, template version/fingerprint, zero fit offset, canonical rotation, positive exterior expansion, expected decoration omissions, black geometry stability, and artifact geometry reconciliation passed.
- Full private browser acceptance: A and B both produced two deterministic complete runs with six reconciled downloads. ZIP members were unpacked and compared through canonical name/content parsing rather than ZIP metadata bytes alone.
- Differential Node/Chromium gates preserve canonical layers, launcher decisions, feature evidence and all artifacts.

## Verification matrix

- Focused release/workflow contracts: 2 files, 19 tests passed.
- Full serial Node: 78/78 files; 1,874 passed, 4 skipped; 289.02 seconds.
- Full Chromium: 9/9 files; 142/142 passed; 83.87 seconds under the unchanged 15-second per-test gate.
- Full E2E with external A/B: 19 passed, 3 truthful conditional skips; A 38.8 seconds, B 40.2 seconds. The skips were one legacy path-only optional case and two explicit benchmark-only cases; the actual A/B release cases passed.
- Fixed-host synthetic benchmark: 18/18 reached a typed terminal outcome in 2.3 minutes; release thresholds are evaluated separately and failed where reported.
- Rust: 1 unit + 21 integration tests passed; locked; clippy `-D warnings` passed.
- Raw WASM boundary: 31/31 passed.
- Tracked WASM artifacts: 4/4 verified; Rust 1.98.0 and wasm-pack 0.15.0.
- Public and private fixture validators: passed.
- Typecheck, production build and `git diff --check`: passed. Build transformed 178 modules and emitted one hashed slice worker, one hashed WASM asset, zero source maps, and no private path/account data.
- Current release evidence CLI: exits 1 by design with the nine unmet software gates above; production default-off is preserved. Gates without controlled raw validation evidence are deliberately false/unknown even where earlier test runs passed; CI regenerates the committed JSON and requires a byte-for-byte diff plus a privacy scan.

## Follow-up and external gate

1. Profile the references' projected 2.5D extraction route and select an optimization of that actual workload. A transform-aware exact input contract is a separate improvement for repair-accepted meshes, not a remedy for these two references.
2. Capture a comparable old/new runtime-owner baseline before claiming the required 30% live-byte reduction.
3. Repeat the same one-warmup/five-measured fixed-host benchmark and require both actual-WASM reference runs plus the speed target.
4. Perform the physical official-launcher coupon fit test externally and record signed fabrication evidence.
