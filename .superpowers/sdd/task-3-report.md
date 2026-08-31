# Task 3 report: TypeScript WASM fail-closed boundary

Date: 2026-08-31
Branch: `codex/wasm-geometry`
Base: `d122b74e035b91abcf8e397b3b307c752009784c`

## Scope delivered

- Added the strict TypeScript `SliceKernel` request/result contract and typed,
  sanitized `SliceKernelError` mapping.
- Validates exact request/result schemas, exact typed-array classes, non-shared
  ownership, result version/status, finite values, strict planes, indices,
  offsets, endpoint segment shape, all nine diagnostic counters, request-derived
  counter bounds, work limits, safe integers and the 8 MiB owned-result cap.
- Keeps TypeScript request/result validation checkpointed in chunks no larger
  than the validated interval of at most 4,096 items.
- Publishes a frozen public result record whose values use immutable iterable
  access objects over the controlled wrapper's already-owned arrays. Raw
  pointer/length ABI, mutable typed arrays and WASM memory views remain confined
  behind `slice-kernel-wrapper.mjs` and the TypeScript parser.
- Added a browser loader that fetches the production-compatible Vite WASM URL,
  single-flights concurrent loads, clears rejected loads for retry, sanitizes
  load failures and explicitly disposes/replaces the adapter.
- Added `CanonicalFallbackGuard`: TypeScript compatibility fallback is eligible
  only for typed load/execution/result/resource failures before any canonical
  publication. `CANCELLED`, `DEADLINE_EXCEEDED` and
  `DEADLINE_CHECK_FAILED` are never downgraded. Publication is marked before
  the publisher callback runs, so a throwing publisher cannot reopen fallback.
- Added a Vite production gate that emits exactly one hashed WASM asset even
  before later tasks wire the loader into the app, disables inlining/source
  maps and rejects duplicate WASM assets or forbidden local path material.
- Hardened the existing WASM build script with deterministic Rust path remapping
  and binary scanning after the first bundle inspection exposed Cargo registry
  paths in the generated binary.
- Added the `.d.mts` declaration for the sole controlled JavaScript wrapper;
  TypeScript application code does not import the generated raw ABI.
- No UI, CSS, font, size, colour, layout, canonical merge, material, official
  launcher, artifact or production 120-second deadline file was changed.

## TDD evidence

### Initial Node RED

Command:

```text
npm test -- --run src/wasm/slice-kernel-contract.test.ts
```

Result: suite failed before collection because
`./slice-kernel-contract` did not exist. This was the expected missing-boundary
RED after the tests were written first.

### Initial Chromium RED

Command:

```text
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
```

Result: Vite/Chromium failed to resolve `./load-slice-kernel`, the expected RED
before the browser loader existed.

### Strict-schema RED

After the minimum parser existed, the strict-schema regression was added and
run with the focused Node command. Result: 22 tests passed and 1 failed because
an unrecognized request field was accepted. The minimum GREEN added exact-key,
plain-record and data-property validation for both requests and results.

### Production bundle RED

The first `npm run build` succeeded but emitted zero WASM assets because the
loader is intentionally not integrated until later tasks and Rollup removed the
unused module. The minimum Vite gate now emits the asset when absent, while
rejecting more than one asset.

A subsequent binary scan found `/Users/.../.cargo/registry/...` strings inside
the pre-existing generated WASM. The existing build script then received Rust
path remapping and a binary scanner. The regenerated WASM and production bundle
contain none of `/Users/`, `/private/` or `sourceMappingURL=`.

### GREEN

- Node contract: 23 passed, 0 failed.
- Real Chromium loader: 5 passed, 0 failed.
- Controlled real WASM boundary: 29 passed, 0 failed.
- Rust: 1 unit and 20 integration tests passed, 0 failed.

## Fresh verification before commit

- `cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check` — exit 0.
- Native locked clippy with all targets/features and `-D warnings` — exit 0.
- wasm32 locked release clippy with `-D warnings` — exit 0.
- `cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked` —
  1 unit + 20 integration passed; doc tests passed.
- wasm32 locked release `cargo check` — exit 0.
- Two consecutive `npm run build:geometry-wasm` runs — 37,329 bytes, zero
  source maps, identical SHA-256
  `464f35b437185a00a4ce4c922d198af0b3a50f2d182840a87e2d7cc13177eaa9`.
- `npm run test:geometry-wasm-boundary` — 29/29 passed.
- Node syntax checks for the build script, raw boundary test and controlled
  wrapper — exit 0.
- `npm test -- --run src/wasm/slice-kernel-contract.test.ts` — 23/23 passed.
- `npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts`
  — 5/5 passed in real headless Chromium.
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0; emitted exactly
  `dist/assets/geometry_wasm_bg-Caoxm5lz.wasm`, 37.33 kB.
- Production inspection — exactly one `.wasm`, zero `.map`, and no
  `/Users/`, `/private/` or `sourceMappingURL=` in `dist`.
- `git diff --check` — exit 0.

## Self-review

- Re-read the approved design, Task 3 brief, full Task 3 diff and controlled
  wrapper contract.
- Confirmed all application calls flow through the controlled wrapper and no
  generated raw module import was added to TypeScript.
- Confirmed request validation, result validation and raw wrapper checks all use
  the same strict boolean checkpoint semantics; thrown/non-boolean callbacks
  fail closed, while `true` remains a typed cancellation and cannot fallback.
- Confirmed the compatibility fallback guard locks before canonical publication
  and no current canonical producer/default path was changed.
- Confirmed loader failures expose fixed public messages without underlying URL,
  filesystem or exception detail.
- Confirmed disposal clears adapter references and generation-protects a pending
  load from being published after disposal.

## Concerns and boundaries

- The loader is deliberately not connected to canonical extraction in Task 3;
  later integration must use `CanonicalFallbackGuard` at the actual publication
  boundary. Current production geometry remains on the TypeScript path.
- Generated wasm-pack output remains git-ignored by repository policy. The
  standard `build` and browser-test scripts now run locked deterministic WASM
  generation automatically, including in a fresh checkout.
- Focused ESLint could not run because this repository has no
  `eslint.config.js|mjs|cjs`; ESLint 9 exited 2 before reading files. Typecheck,
  Node, Chromium, Rust/clippy and production gates are green; no lint-config
  change was made in this task.
- wasm-pack still reports its existing platform warning and falls back to its
  installed wasm-bindgen path. Both builds completed and were byte-identical.

## Reviewer-finding fixes

Date: 2026-08-31
Review source: `.superpowers/sdd/task-3-review-findings.md`
Implementation commit: `ff33bc7d56320ab08e689566e6ab21d65dcba1a9`

### Finding 1: atomic canonical publication

- Replaced the transient fallback boolean check with explicit unforgeable
  publication tokens and the state machine
  `idle -> wasm_claimed|fallback_claimed -> published`.
- WASM and TypeScript fallback claims atomically reserve the only publication
  right. Forged, late and duplicate tokens fail with
  `PUBLICATION_CONFLICT`; cancellation/deadline errors fail with
  `FALLBACK_NOT_ALLOWED`.
- Publication moves to `published` before invoking the callback, so async
  interleaving or a throwing publisher cannot reopen fallback.

RED command:

```text
npm test -- --run src/wasm/slice-kernel-contract.test.ts
```

RED result: 18 passed and 6 failed because the claim APIs did not exist and the
old guard accepted duplicate/late publication. GREEN: 24/24 at that cycle; the
final focused suite is 26/26.

### Finding 2: disposal generation and operation tokens

- Every kernel operation captures a frozen kernel/generation token and checks
  it before work, after request validation, after the controlled call, and after
  result parsing.
- Instance `dispose()` clears only its matching loader generation/cache. A
  stale instance cannot evict a replacement; pending and late results cannot be
  returned after disposal.

RED command:

```text
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
```

RED result: 5 passed and 2 failed. Instance disposal returned the same cached
kernel, and reentrant disposal from controlled checkpoint 5 still resolved a
result. GREEN: 7/7 in Chromium.

### Finding 3: structured errors without regex classification

- Rust WASM errors now cross the generated boundary as JavaScript `Error`
  objects with stable `code` and `phase` fields.
- The controlled wrapper publishes `SliceKernelBoundaryError` with exact
  request/execution/result phase and code. The TypeScript adapter maps only
  these fields using an exhaustive switch; it does not inspect error text.
- Deadline-check failure and deadline exceeded remain exact and distinct.

RED command:

```text
npm run test:geometry-wasm-boundary
```

RED result: the two new structured-code tests failed because previous errors
were plain `TypeError`/string values. After the first minimum change, exact-code
tests passed and the old regex assertions failed, exposing the final Rust export
that still converted output errors to strings. Replacing that conversion and
updating all raw assertions to exact code/phase produced 31/31 GREEN.

Static gate:

```text
if rg -n "RegExp|\\.test\\(|match\\(|/.*deadline|/.*limit" \
  src/wasm/load-slice-kernel.ts; then exit 1; fi
```

Result: exit 0 with no matches.

### Finding 4: fresh-checkout standard prerequisites

- Added `prebuild` and `pretest:browser`; both invoke the locked deterministic
  `build:geometry-wasm` script. Generated wasm-pack output remains ignored and
  does not need manual preparation.

Initial real fresh-checkout RED:

```text
git clone --local . <fresh>/repo
cd <fresh>/repo
npm ci --ignore-scripts
npm run build
```

Result before the fix: exit 1, `ENOENT` for
`src/wasm/generated/geometry_wasm_bg.wasm`.

Final real fresh-checkout GREEN from committed `ff33bc7`:

```text
git clone --local . <fresh>/repo
cd <fresh>/repo
test -z "$(git status --porcelain)"
test ! -e src/wasm/generated/geometry_wasm_bg.wasm
npm ci --ignore-scripts
npm run build
mv src/wasm/generated <fresh-generated-backup>/generated
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
npm test -- --run src/wasm/slice-kernel-contract.test.ts
npm run test:geometry-wasm-boundary
test -z "$(git status --porcelain)"
```

Results: standard build self-generated the 37,856-byte WASM and emitted exactly
one hashed asset with zero maps; after generated output was removed again, the
standard browser-test script regenerated it and passed 7/7. Node passed 26/26,
raw boundary passed 31/31, and the fresh checkout remained clean.

### Finding 5: exact own-key schema

- Strict records now use `Reflect.ownKeys()` and require exactly the expected
  string data properties. Extra non-enumerable strings, symbols and accessors
  fail closed.

RED/GREEN command:

```text
npm test -- --run src/wasm/slice-kernel-contract.test.ts
```

RED: 24 passed and 1 failed because a hidden request key was accepted. GREEN:
25/25 at that cycle; final suite 26/26.

### Finding 6: immutable public values

- Replaced public typed arrays with frozen `ReadonlySliceArray` access objects.
  They expose only `length`, `byteLength`, `elementType`, `at()` and iteration;
  internal owned typed arrays and buffers are private and never published.
- Real Node and Chromium tests attempt index assignment, `set()` and `fill()`;
  all throw `TypeError`, and subsequent iteration remains byte-for-byte intact.

RED/GREEN command:

```text
npm test -- --run src/wasm/slice-kernel-contract.test.ts
```

RED: 25 passed and 1 failed because index assignment mutated the validated
array. GREEN: 26/26; the same mutation checks pass in the 7/7 Chromium suite.

## Post-review fresh verification

- `cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check` — exit 0.
- Native locked clippy, all targets/features, `-D warnings` — exit 0.
- wasm32 locked release clippy, `-D warnings` — exit 0.
- Locked Rust tests — 1 unit + 20 integration passed; doc tests passed.
- wasm32 locked release check — exit 0.
- Two consecutive `npm run build:geometry-wasm` runs — 37,856 bytes each,
  identical SHA-256
  `4aa7f77d0e50116c28ee06212408d72efede27e33d1e4723de65ab67d3c3795a`.
- `npm run test:geometry-wasm-boundary` — 31/31 passed.
- `npm test -- --run src/wasm/slice-kernel-contract.test.ts` — 26/26 passed.
- `npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts`
  — standard pretest rebuilt WASM; Chromium 7/7 passed.
- `npm run typecheck` — exit 0.
- Standard `npm run build` — standard prebuild rebuilt WASM; Vite build passed.
- Bundle inspection — exactly one hashed 37.86 kB WASM, zero `.map`, no
  `/Users/`, `/private/` or `sourceMappingURL=` material.
- Node syntax checks for build script, raw test and controlled wrapper — exit 0.
- `git diff --check` — exit 0.

## Post-review self-review

- Verified no controlled-wrapper error classification depends on error text.
- Verified every operation retains and rechecks its immutable generation token
  across both controlled execution and TypeScript result parsing.
- Verified public result access has no `buffer`, numeric index, `set`, `fill`,
  `subarray` or other mutation route.
- Verified publication claims are one-shot and token identity is checked before
  any callback runs.
- Verified the nine implementation files do not touch UI/CSS, the production
  deadline, canonical merge, materials, launcher geometry or artifacts.

## Re-review round 2: findings 7–9

Date: 2026-08-31
Implementation commit: `ba908d4` (`fix(wasm): close adapter abort and build boundaries`)

This section supersedes the earlier report statements that generated WASM is
ignored and that standard build/browser tests regenerate it. Normal build and
browser-test paths now consume tracked, hash-verified generated artifacts. Only
the separate regeneration gate invokes the pinned Rust toolchain and
`wasm-pack`.

### Finding 7: phase-independent abort reason and source

- The public TypeScript adapter checkpoint now returns an exact discriminated
  abort record: cancellation is `{ reason: "cancelled", source:
  "user"|"superseded" }`; deadline is `{ reason: "deadline", source:
  "runtime-deadline" }`; no abort is `undefined`.
- The adapter validates the abort record with `Reflect.ownKeys()` and data
  descriptors. Boolean, malformed, accessor, thrown and mismatched
  reason/source values fail closed.
- Only the controlled wrapper receives the raw strict boolean deadline hook.
  The adapter retains the observed abort record across that call and maps every
  request, controlled-execution and result checkpoint to the same
  `SliceKernelError` code, `abortReason` and `abortSource`.

RED command:

```text
npx vitest --config vitest.browser.config.ts run src/wasm/load-slice-kernel.browser.test.ts
```

RED result: 7 passed and 4 failed. Both immediate and delayed cancellation and
deadline cases were incorrectly returned as `DEADLINE_CHECK_FAILED`.

GREEN results:

- `npx vitest run src/wasm/slice-kernel-contract.test.ts` — 27/27 passed.
- `npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts` —
  11/11 passed in Chromium, including all four immediate/delayed cases.
- `npm run typecheck` — exit 0.

### Finding 8: encoded Rust flags and path safety

- Path remapping now uses `CARGO_ENCODED_RUSTFLAGS` with ASCII unit separators
  (`0x1f`). An existing encoded sequence is retained before the two generated
  remap flags. `RUSTFLAGS` is deliberately removed from the child environment
  so Cargo never receives both incompatible flag channels.
- The build contract test drives the real build script through a fake pinned
  `wasm-pack`, captures its child environment, and verifies an existing flag
  containing spaces and Chinese remains one encoded argument.

RED command:

```text
npx vitest run src/test/geometry-wasm-build-contract.test.ts
```

RED result: 2/2 failed. The build child received space-delimited `RUSTFLAGS`,
and the standard package scripts still invoked regeneration.

GREEN path verification from committed `ba908d4`:

```text
git clone --local . "/tmp/ShapeCut Task 3 中文 fresh"
cd "/tmp/ShapeCut Task 3 中文 fresh"
CARGO_ENCODED_RUSTFLAGS=$'-Cdebuginfo=0\x1f--remap-path-prefix=/tmp/Existing 中文 path=/workspace/existing' \
  npm run verify:geometry-wasm-regeneration
```

Result: Rust 1.98.0 and wasm-pack 0.15.0 rebuilt the crate from the checkout
whose path contains spaces and Chinese. The 37,856-byte output matched the
tracked SHA-256
`4aa7f77d0e50116c28ee06212408d72efede27e33d1e4723de65ab67d3c3795a`
byte-for-byte.

### Finding 9: tracked normal-build artifacts and separate regeneration

- Tracked `geometry_wasm.js`, `geometry_wasm_bg.wasm` and both declaration
  files, plus a pinned manifest containing size and SHA-256 for the exact four
  generated files.
- `verify:geometry-wasm-generated` uses Node built-ins only and fails if the
  manifest/tool versions/artifact set/size/hash differ. Standard `build` and
  `test:browser` call this verifier and never invoke Rust or wasm-pack.
- Pages explicitly verifies the tracked artifacts before typecheck/build. Its
  workflow contains no Rust, Cargo or wasm-pack setup.
- `.github/workflows/verify-geometry-wasm.yml` is an independent online
  regeneration gate. It explicitly installs Rust 1.98.0 with the wasm target,
  installs wasm-pack 0.15.0 with `--locked`, verifies both tracked files and a
  clean temporary regeneration, then compares both to the same pinned hashes.
- Offline capability is claimed only for standard build/test after Node
  dependencies are installed. Regeneration is not claimed offline and its CI
  install step may use the network.

Fresh-checkout verification:

```text
git clone --local . "/tmp/ShapeCut Task 3 中文 fresh"
cd "/tmp/ShapeCut Task 3 中文 fresh"
npm ci --ignore-scripts --cache "/tmp/ShapeCut Task 3 中文 npm cache fresh"
env PATH=/usr/local/bin:/usr/bin:/bin \
  CARGO_HOME="/tmp/ShapeCut Task 3 中文 empty cargo" \
  npm_config_offline=true /bin/sh -c '
    for tool in cargo rustc rustup wasm-pack; do
      if command -v "$tool" >/dev/null 2>&1; then exit 1; fi
    done
    npm run build &&
    npm test -- --run src/wasm/slice-kernel-contract.test.ts \
      src/test/geometry-wasm-build-contract.test.ts &&
    npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts &&
    npm run test:geometry-wasm-boundary
  '
git status --porcelain
```

Results: the fresh npm cache installed 312 packages; the restricted PATH
contained none of Cargo, rustc, rustup or wasm-pack; the Cargo home was empty;
and npm was offline during standard build/test. Production build passed, Node
29/29 passed, Chromium 11/11 passed, raw boundary 31/31 passed, and the fresh
checkout remained clean. The first attempt at this check had run `npm ci` in
the source worktree rather than the clone and therefore failed at `tsc: command
not found`; the command above is the corrected fresh-checkout run and result.

### Round 2 full verification

- `npm run verify:geometry-wasm-regeneration` — tracked verification and clean
  pinned regeneration passed twice; exact hash above.
- `npm run test:geometry-wasm-boundary` — 31/31 passed.
- `cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check` — exit
  0.
- Native locked clippy with all targets/features and `-D warnings` — exit 0.
- wasm32 locked release clippy with `-D warnings` — exit 0.
- Locked Rust tests — 1 unit + 20 integration passed; doc tests passed.
- wasm32 locked release check — exit 0.
- `npm run typecheck` — exit 0.
- Standard build with Rust tools absent from PATH, an empty Cargo home and
  `npm_config_offline=true` — exit 0; exactly one 37.86 kB WASM asset, zero
  maps, and no `/Users/`, `/private/` or `sourceMappingURL=` material.
- Node syntax checks for the build/verifier/raw-wrapper scripts — exit 0.
- `git diff --check` — exit 0.
- Full `npm test` was run twice: both runs passed 69/71 files and
  1721 tests (4 skipped), with the same two unrelated 5-second conversion
  timeouts in `src/test/e2e-helpers.test.ts` and
  `src/export/outline-package.test.ts`. Both exact tests pass when rerun alone
  (1/1 each). No unrelated timeout or production geometry code was changed.

### Round 2 self-review and concerns

- Confirmed TypeScript imports only the controlled wrapper; no application
  module imports the generated raw JS ABI.
- Confirmed cancellation and deadline codes are selected from the retained
  abort record rather than the checkpoint phase or an error message.
- Confirmed normal Pages/Node build paths do not reference Rust, Cargo,
  wasm-pack, Cargo caches or regeneration scripts.
- Confirmed only the separate regeneration workflow installs tools and that it
  pins and verifies exact versions before byte comparison.
- Confirmed the round 2 diff does not touch UI/CSS, fonts, colours, production
  deadline, canonical merge, material logic, launcher code or release
  artifacts.
- Remaining concern: the full Node suite's two existing heavy conversion tests
  consistently exceed their 5-second limit under full-suite load, although
  both pass in isolation. This is reported rather than hidden by an unrelated
  timeout change.
- `npm ci` reports the repository's existing audit state of 1 moderate and 3
  high vulnerabilities; dependency changes were outside this task.
