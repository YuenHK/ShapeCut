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

## Re-review round 3: findings 10–12

Date: 2026-08-31
Implementation commit: `93bfe1b` (`fix(wasm): enforce checkpoint and deploy provenance`)

### Finding 10: fail-closed checkpoint reflection

- `readSliceKernelAbort()` now contains callback invocation and the complete
  prototype, own-key, data-descriptor, reason and source validation inside one
  fail-closed `try` boundary. Any callback, revoked proxy or reflection trap
  failure is sanitized to `DEADLINE_CHECK_FAILED`.
- Production Chromium tests cover immediate and delayed revoked proxies and
  throwing `ownKeys`, `getPrototypeOf` and `getOwnPropertyDescriptor` traps.
  Every resulting error is also passed to `CanonicalFallbackGuard`; all eight
  cases remain fallback-ineligible with `FALLBACK_NOT_ALLOWED`.

RED command:

```text
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
```

RED result: 15 passed and 4 failed. The four delayed traps already reached the
controlled adapter's fail-closed wrapper, but every immediate trap escaped
reflection validation and was incorrectly mapped to `EXECUTION_FAILED`.

GREEN result: the same command passed 19/19 in Chromium. The final focused Node
contract suite passed 31/31 across the slice contract and workflow/build
contract files.

### Finding 11: main deployment provenance gate

- The main-push Pages workflow now has a separate `regenerate_wasm` job. It
  installs Rust 1.98.0 with `wasm32-unknown-unknown`, installs wasm-pack 0.15.0
  with `--locked`, and directly runs
  `node scripts/verify-geometry-wasm-regeneration.mjs`.
- The normal `build` job explicitly needs `regenerate_wasm`. The `deploy` job
  explicitly needs both `regenerate_wasm` and `build`, so a main deployment
  cannot publish if pinned source-to-tracked-artifact regeneration fails.
- The byte comparison does not go through a rewriteable `package.json` npm
  script. Both the Pages main gate and PR provenance workflow directly invoke
  the verifier script.
- The PR workflow path trigger covers `crates/geometry-wasm/**`, generated
  artifacts, the build script, both verifier scripts, both workflow files,
  `package.json`, `package-lock.json`, `Cargo.lock` and
  `rust-toolchain.toml`.

Workflow contract RED/GREEN:

```text
npx vitest run src/test/geometry-wasm-build-contract.test.ts
```

Initial RED result: 1 passed and 3 failed because regeneration used npm
indirection, Pages lacked a provenance dependency, triggers were incomplete and
all Actions used mutable tags. An added explicit deploy dependency produced a
second RED of 3 passed and 1 failed while deploy still depended only
transitively on the gate. Final result: 4/4 passed.

YAML syntax gate:

```text
ruby -e 'require "yaml"; ARGV.each { |path| YAML.parse_file(path) }' \
  .github/workflows/deploy-pages.yml \
  .github/workflows/verify-geometry-wasm.yml
```

Result: both workflow files parsed successfully.

### Finding 12: immutable official Action pins

The exact current major-version refs were resolved from each official action
Git repository, rather than a mirror or search result:

```text
git ls-remote https://github.com/actions/checkout.git refs/tags/v6 refs/tags/v6^{}
git ls-remote https://github.com/actions/setup-node.git refs/tags/v6 refs/tags/v6^{}
git ls-remote https://github.com/actions/configure-pages.git refs/tags/v5 refs/tags/v5^{}
git ls-remote https://github.com/actions/upload-pages-artifact.git refs/tags/v4 refs/tags/v4^{}
git ls-remote https://github.com/actions/deploy-pages.git refs/tags/v4 refs/tags/v4^{}
```

Resolved pins:

- `actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6`
- `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6`
- `actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5`
- `actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b # v4`
- `actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4`

The workflow contract dynamically enumerates every `.yml` and `.yaml` file in
`.github/workflows`, rejects every non-40-character `uses:` ref, requires a
major-version comment, and compares the action/revision/comment tuple with the
officially resolved allowlist above.

### Round 3 fresh-checkout verification

Committed `93bfe1b` was cloned to a new path containing spaces and Chinese:

```text
git clone --local . "/tmp/ShapeCut Task 3 round 3 中文 fresh"
cd "/tmp/ShapeCut Task 3 round 3 中文 fresh"
npm ci --ignore-scripts --cache "/tmp/ShapeCut Task 3 round 3 中文 npm cache"
env PATH=/usr/local/bin:/usr/bin:/bin \
  CARGO_HOME="/tmp/ShapeCut Task 3 round 3 中文 empty cargo" \
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
CARGO_ENCODED_RUSTFLAGS=$'-Cdebuginfo=0\x1f--remap-path-prefix=/tmp/Existing round 3 中文 path=/workspace/existing' \
  node scripts/verify-geometry-wasm-regeneration.mjs
git status --porcelain
```

Results: standard offline build after dependency installation passed with no
Rust/Cargo/rustup/wasm-pack in PATH and an empty Cargo home; Node 31/31,
Chromium 19/19 and raw boundary 31/31 passed. Direct pinned regeneration in the
same fresh path produced the tracked 37,856-byte SHA-256
`4aa7f77d0e50116c28ee06212408d72efede27e33d1e4723de65ab67d3c3795a`.
The fresh checkout remained clean.

### Round 3 complete verification and concerns

- Focused Node contract/workflow tests — 31/31 passed.
- Production Chromium adapter tests — 19/19 passed.
- Controlled raw WASM boundary — 31/31 passed.
- Pinned regeneration verifier — tracked and temporary output matched
  byte-for-byte.
- `npm run typecheck` — exit 0.
- Standard build without Rust tools in PATH, with empty Cargo home and npm
  offline — exit 0; one 37.86 kB WASM, zero maps and no forbidden path or
  source-map material.
- Rust fmt, native and wasm32 clippy with `-D warnings`, locked tests and wasm32
  release check — all passed; 1 unit and 20 integration tests passed.
- `git diff --check` — exit 0.
- Full `npm test` passed 69/71 files and 1723 tests (4 skipped). The same two
  pre-existing heavy conversion tests from round 2 exceeded their 5-second
  limit under full-suite load; each exact test again passed when run alone
  (1/1 each). No unrelated timeout or conversion implementation was changed.
- The main deployment now performs online Rust/wasm-pack installation and will
  take longer; failure is intentional and blocks publication when provenance
  cannot be verified. Offline capability remains limited to normal build/test
  after Node dependencies are installed.
- No round 3 change touches UI/CSS, fonts, colours, production deadline,
  canonical merge, materials, launcher code or official release artifacts.

## Re-review round 4: findings 13–14

Date: 2026-08-31
Implementation commit: `40dc905` (`fix(wasm): harden record and typed array inspection`)

### Finding 13: canonical strict-record snapshots

- Strict request and result inspection now wraps object/prototype/own-key,
  `Object.hasOwn()` and descriptor operations in one fail-closed boundary. Any
  caller-controlled reflection failure becomes the supplied
  `INVALID_REQUEST` or `INVALID_RESULT` code with a sanitized message.
- Exact keys must be own data properties. Their verified descriptor values are
  copied into an internal `Map` snapshot. Validation reads only
  `snapshot.get(...)`; it never performs ordinary field access on the caller's
  record after inspection.
- Direct and production tests cover revoked proxies and throwing
  `getPrototypeOf`, `ownKeys` and `getOwnPropertyDescriptor` traps. Separate
  throwing `get` traps prove ordinary property access is not invoked: valid
  descriptor snapshots continue successfully.
- Hostile inspection errors receive non-rewriteable, identity-backed fallback
  eligibility: `SliceKernelError` is frozen and the publication guard checks an
  internal `WeakSet`, not a mutable public flag. Hostile request and result
  inspection cannot claim TypeScript compatibility fallback. A positive test
  confirms an ordinary non-hostile `INVALID_RESULT` remains eligible before
  canonical publication.

Direct RED command:

```text
npx vitest run src/wasm/slice-kernel-contract.test.ts
```

RED result: 30 passed and 17 failed. Reflection traps escaped as raw
`TypeError`/`Error`, caller `get` traps were invoked, Proxy/own-property typed
arrays escaped inspection, and hostile `INVALID_RESULT` values remained
fallback-eligible.

Production RED command:

```text
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
```

RED result: 22 passed and 9 failed. Hostile request records and typed arrays
were collapsed to `EXECUTION_FAILED`, while the ordinary request `get` trap was
invoked.

Final GREEN: direct contract 50/50 and production Chromium adapter 31/31.

### Finding 14: intrinsic exact typed-array inspection

- The adapter captures the intrinsic `%TypedArray%.prototype` getters for
  `length`, `buffer`, `byteLength` and `byteOffset`, plus intrinsic `values()`
  and `at()`. Inspection invokes them with `Reflect.apply`, so a Proxy or own
  accessor cannot spoof the brand or metadata.
- Exact concrete prototype is required. Hazardous own keys including
  `constructor`, `buffer`, `length`, byte metadata and methods used after
  validation are rejected without invoking their accessors.
- `ArrayBuffer.prototype.byteLength` is invoked intrinsically on the returned
  buffer, rejecting shared buffers and non-ArrayBuffer values. Intrinsic
  `values()` performs detached-buffer validation.
- The view must start at byte offset zero, be element-aligned, have exact
  `length * BYTES_PER_ELEMENT`, and span the complete owned backing buffer.
- Direct hostile matrices cover Proxy-wrapped views, throwing own
  `constructor`/`buffer`/`length`, detached and shared buffers, non-zero offset,
  partial backing buffers and a misaligned prototype spoof for both request and
  result validation. Production adapter tests cover the corresponding request
  cases. Every inspection failure keeps its caller-supplied validation code and
  is denied fallback.
- Immutable public result `at()` and iteration now also use the captured
  intrinsics rather than caller-overridable typed-array methods.

### Round 4 fresh-checkout verification

Committed `40dc905` was cloned into a new checkout whose path contains spaces
and Chinese:

```text
git clone --local . "/tmp/ShapeCut Task 3 round 4 中文 fresh"
cd "/tmp/ShapeCut Task 3 round 4 中文 fresh"
npm ci --ignore-scripts --cache "/tmp/ShapeCut Task 3 round 4 中文 npm cache"
env PATH=/usr/local/bin:/usr/bin:/bin \
  CARGO_HOME="/tmp/ShapeCut Task 3 round 4 中文 empty cargo" \
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
CARGO_ENCODED_RUSTFLAGS=$'-Cdebuginfo=0\x1f--remap-path-prefix=/tmp/Existing round 4 中文 path=/workspace/existing' \
  node scripts/verify-geometry-wasm-regeneration.mjs
git status --porcelain
```

Results: the fresh standard build ran offline after dependency installation
with no Rust/Cargo/rustup/wasm-pack in PATH and an empty Cargo home. Focused
Node 54/54, Chromium 31/31 and raw boundary 31/31 passed. Direct pinned
regeneration produced the tracked 37,856-byte SHA-256
`4aa7f77d0e50116c28ee06212408d72efede27e33d1e4723de65ab67d3c3795a`;
the checkout remained clean.

### Round 4 complete verification and concerns

- Direct contract — 50/50 passed.
- Workflow/build contract — 4/4 passed; both workflow YAML files parsed.
- Production Chromium adapter — 31/31 passed.
- Controlled raw WASM boundary — 31/31 passed.
- Typecheck and restricted standard production build — exit 0; one 37.86 kB
  WASM, zero maps and no forbidden path/source-map material.
- Pinned regeneration — tracked and temporary generated files matched
  byte-for-byte.
- Rust fmt, native and wasm32 clippy with `-D warnings`, locked tests and wasm32
  release check — all passed; 1 unit and 20 integration tests passed.
- Full `npm test` passed 67/71 files and 1744 tests (4 skipped). Four unrelated
  geometry-heavy tests exceeded their existing 5-second limits under full
  parallel load: the two previously reported conversion tests plus one
  projected-contour test and one launcher-ranking test. All four exact tests
  passed when rerun individually (1/1 each). No unrelated timeout or geometry
  implementation was changed.
- `npm ci` continues to report the existing audit state of 1 moderate and 3
  high vulnerabilities; dependency changes remain outside Task 3.
- No round 4 change touches UI/CSS, fonts, colours, production deadline,
  canonical merge, materials, launcher code or official release artifacts.

## Re-review round 5: findings 15–16

Date: 2026-08-31
Implementation commit: `f3faf14` (`fix(wasm): seal fallback provenance and typed array snapshots`)

### Finding 15: unforgeable fallback provenance

- Public `SliceKernelError` construction is now fallback-ineligible for every
  code, including `LOAD_FAILED`, `EXECUTION_FAILED`, `INVALID_RESULT` and
  `RESOURCE_LIMIT`. Supplying the former fourth boolean argument cannot grant
  eligibility.
- The fallback authority is an unexported frozen identity in the contract
  module. Eligibility additionally requires exact base-class construction, so
  a public subclass cannot acquire it. The publication guard continues to
  validate membership in its private `WeakSet`; the public boolean is only a
  frozen diagnostic projection.
- Only the controlled runtime mapper and ordinary post-inspection result
  validation invoke the private issuer. Request/reflection/typed-array
  inspection, abort, deadline, cancellation and disposal paths remain
  fallback-ineligible.
- Direct tests cover default-looking public codes, an explicit forged fourth
  argument and subclass construction. Positive tests prove a real production
  asset load failure and ordinary malformed result version remain eligible.

RED command:

```text
npx vitest run src/wasm/slice-kernel-contract.test.ts
```

RED result: 50 passed and 12 failed. Five failures demonstrated public/default
and subclass provenance forgery; the remaining failures demonstrated the
typed-array TOCTOU cases below.

Final GREEN: direct contract 63/63 and production Chromium adapter 34/34.

### Finding 16: fixed defensive snapshots across checkpoints

- The permanent `validatedRequests` outer-identity `WeakSet` was removed.
  `parseSliceBatchResult()` revalidates and recopies every supplied request,
  including a previously returned validated request.
- Exact typed-array inspection captures intrinsic brand/length/buffer/
  byte-length/byte-offset/`at`/`values`/`set` operations and exact concrete
  prototypes. It rejects proxies, detached/shared/partial/non-zero-offset views
  as before, and now also rejects every resizable `ArrayBuffer` before any
  checkpoint can run.
- Request and encoded result arrays are copied with captured intrinsic `set()`
  into newly allocated fixed backing buffers before the first untrusted
  checkpoint. Validation and all later reads use captured lengths and
  intrinsic `at()` against those private copies. The caller and checkpoint
  never receive the copies used by controlled WASM execution or result
  validation.
- Result arrays are inspected and copied before request validation invokes its
  checkpoint, preventing a reentrant checkpoint from adding own properties or
  detaching the encoded result views.
- Direct tests cover checkpoint-reentrant request/result own-property mutation
  and detach, rejection-before-checkpoint of request/result resizable buffers,
  plus own-property, detach and numeric mutation of a previously validated
  request. Production tests cover reentrant own-property mutation/detach and
  resizable request rejection. Every hostile validation rejection is typed and
  denied fallback.

Production RED command:

```text
npx vitest --config vitest.browser.config.ts run src/wasm/load-slice-kernel.browser.test.ts
```

RED result: 31 passed and 3 failed: the adapter used caller-owned buffers after
checkpoint own-property mutation/detach and accepted a resizable request.

### Round 5 verification

Focused Node, workflow, Chromium and controlled raw boundary:

```text
npx vitest run src/wasm/slice-kernel-contract.test.ts \
  src/test/geometry-wasm-build-contract.test.ts
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
npm run test:geometry-wasm-boundary
npm run typecheck
npm run verify:geometry-wasm-generated
```

Results: Node 67/67, Chromium 34/34 and raw boundary 31/31 passed; typecheck and
the four-artifact tracked verifier exited 0.

Production, workflow, deterministic and Rust/WASM gates:

```text
npm run build
node scripts/verify-geometry-wasm-regeneration.mjs
ruby -e 'require "yaml"; ARGV.each { |path| YAML.parse_file(path) }' \
  .github/workflows/deploy-pages.yml \
  .github/workflows/verify-geometry-wasm.yml
cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check
cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked
cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --locked \
  --all-targets -- -D warnings
cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --locked \
  --target wasm32-unknown-unknown -- -D warnings
cargo check --manifest-path crates/geometry-wasm/Cargo.toml --locked \
  --target wasm32-unknown-unknown --release
git diff --check
```

Results: production build exited 0 with one 37.86 kB WASM; pinned regeneration
matched all tracked artifacts byte-for-byte; both workflows parsed; Rust fmt,
native test, native/wasm32 clippy with `-D warnings`, and wasm32 release check
all passed (1 unit and 20 integration tests).

Fresh checkout at commit `f3faf14` used a path containing spaces and Chinese:

```text
git clone --local . "/tmp/ShapeCut Task 3 round 5 中文 fresh"
cd "/tmp/ShapeCut Task 3 round 5 中文 fresh"
npm ci --ignore-scripts --cache "/tmp/ShapeCut Task 3 round 5 中文 npm cache"
env PATH=/usr/local/bin:/usr/bin:/bin \
  CARGO_HOME="/tmp/ShapeCut Task 3 round 5 中文 empty cargo" \
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
CARGO_ENCODED_RUSTFLAGS=$'-Cdebuginfo=0\x1f--remap-path-prefix=/tmp/Existing round 5 中文 path=/workspace/existing' \
  node scripts/verify-geometry-wasm-regeneration.mjs
git status --porcelain
```

Results: after the clean dependency install, the standard build/test path ran
offline with no Rust-family tool in `PATH` and an empty Cargo home. Build,
Node 67/67, Chromium 34/34 and raw boundary 31/31 passed. The separate pinned
regeneration preserved the existing unit-separator flags and reproduced the
tracked 37,856-byte artifact byte-for-byte. The fresh checkout remained clean.
No offline regeneration claim is made.

Full `npm test` passed 69/71 files and 1759 tests (4 skipped). Two existing
geometry-heavy tests exceeded their 5-second timeout under full parallel load:

```text
npx vitest run src/export/outline-package.test.ts \
  -t 'packages a real material-bound pipeline result'
npx vitest run src/test/e2e-helpers.test.ts \
  -t 'reconciles a genuine converted package with fixed launcher and three shared fasteners'
```

Each exact test passed when rerun alone (1/1). No unrelated timeout or geometry
implementation was changed. `npm ci` still reports the existing audit state of
1 moderate and 3 high vulnerabilities; dependency remediation is outside Task
3. No round 5 change touches UI/CSS, fonts, colours, production deadline,
canonical merge, materials, launcher code or official release artifacts.

## Re-review round 6: findings 17–18

Date: 2026-08-31
Implementation commit: `35c809c` (`fix(wasm): close runtime authority and bound snapshots`)

### Finding 17: closed operation-bound fallback authority

- The arbitrary exported `createSliceKernelRuntimeError(code, message)` issuer
  was removed. Both the contract module and the compatibility loader module
  expose no code-to-eligible-error mapper.
- Loader creation, controlled execution mapping, ordinary result validation,
  the private fallback capability and its membership `WeakSet` now share one
  module closure. `load-slice-kernel.ts` only re-exports the two closed
  `loadSliceKernel()` / `disposeSliceKernel()` operations. External importers
  can no longer choose an error code and mint fallback membership.
- Public `SliceKernelError` construction, its former fourth argument and
  subclasses remain ineligible. A real fetch failure still becomes an eligible
  sanitized `LOAD_FAILED`, and a completely inspected ordinary result with an
  invalid version remains an eligible `INVALID_RESULT`.
- Result typed arrays are completely brand/lifecycle inspected before semantic
  version/status validation can issue ordinary-result fallback. Combining an
  invalid version with a hostile Proxy view therefore remains typed
  `INVALID_RESULT` but cannot claim fallback.

Initial RED command:

```text
npx vitest run src/wasm/slice-kernel-contract.test.ts
```

RED result: 60 passed and 6 failed. One failure showed the exported mapper
minting an eligible `LOAD_FAILED`; the remaining failures covered snapshot
revalidation and cadence below.

Additional issuer/result-validation RED:

```text
npx vitest run src/wasm/slice-kernel-contract.test.ts \
  -t 'does not grant ordinary-result fallback before complete typed-array inspection'
```

Result: 1/1 failed because the invalid version issued eligibility before the
Proxy typed array had been inspected. Final direct contract result: 71/71.

### Finding 18: bounded intrinsic snapshots and private request reuse

- Request handling is split into a no-checkpoint strict inspection phase and a
  private materialization phase. Production execution retains a
  `TrustedSliceBatchRequestSnapshot`; result parsing consumes that same private
  request and its captured counts without revalidating or re-copying it.
- Request and result allocations have explicit byte/count/work caps before any
  allocation. Every destination allocation is bracketed by pre/post
  checkpoints. The existing controlled wrapper remains the sole approved
  whole-output 8 MiB copy boundary.
- Each defensive copy uses captured concrete typed-array constructors to make
  a fixed source chunk and captured intrinsic `set()` to copy at most the
  request's approved interval (maximum 4,096 elements). There is a checkpoint
  after every chunk; near-limit tests require at least 17 request and 28 public
  result checkpoints for arrays just over two maximum intervals.
- Before and after every untrusted checkpoint, the adapter intrinsically
  revalidates exact prototype/brand, length, byte length, backing identity,
  detached/resizable state and forbidden own properties for all caller-owned
  views. Captured request inspections remain active through the controlled
  deadline hook and result parsing, while controlled/private destination views
  are never exposed to the caller or checkpoint.
- Immediate and delayed cancellation/deadline retain their original
  `CANCELLED` / `DEADLINE_EXCEEDED` code and abort source during allocation and
  chunk copying. Lifecycle/own-property mutation is typed
  `INVALID_REQUEST`/`INVALID_RESULT` and fallback-ineligible at immediate,
  delayed and controlled-execution checkpoints.

Initial cadence RED was part of the 60/6 run above: an 8,193-element request
observed only 6 checkpoints instead of the required minimum 17, and immediate
request/result own-property or detach mutation was incorrectly accepted.

Delayed controlled-checkpoint RED:

```text
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts \
  -t 'revalidates caller request lifecycle at a delayed controlled checkpoint'
```

Result: 1/1 failed; mutation at checkpoint 14 was not observed and execution
continued to checkpoint 50. The final test stops at checkpoint 14 with typed
`INVALID_REQUEST` and fallback denied.

### Round 6 verification

Focused gates:

```text
npx vitest run src/wasm/slice-kernel-contract.test.ts \
  src/test/geometry-wasm-build-contract.test.ts
npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts
npm run typecheck
npm run test:geometry-wasm-boundary
npm run build
git diff --check
```

Results: Node contract/workflow 75/75, Chromium 35/35 and controlled raw WASM
31/31 passed. Typecheck, tracked artifact verification, production build and
diff check exited 0; the build contains one 37.86 kB WASM.

Deterministic, workflow and Rust/WASM gates:

```text
node scripts/verify-geometry-wasm-regeneration.mjs
ruby -e 'require "yaml"; ARGV.each { |path| YAML.parse_file(path) }' \
  .github/workflows/deploy-pages.yml \
  .github/workflows/verify-geometry-wasm.yml
cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check
cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked
cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --locked \
  --all-targets -- -D warnings
cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --locked \
  --target wasm32-unknown-unknown -- -D warnings
cargo check --manifest-path crates/geometry-wasm/Cargo.toml --locked \
  --target wasm32-unknown-unknown --release
```

Results: pinned regeneration matched all four tracked artifacts byte-for-byte;
both workflows parsed; Rust fmt, 1 unit test, 20 integration tests,
native/wasm32 clippy with `-D warnings` and wasm32 release check passed.

Fresh checkout at committed `35c809c`:

```text
git clone --local . "/tmp/ShapeCut Task 3 round 6 中文 fresh"
cd "/tmp/ShapeCut Task 3 round 6 中文 fresh"
npm ci --ignore-scripts --cache "/tmp/ShapeCut Task 3 round 6 中文 npm cache"
env PATH=/usr/local/bin:/usr/bin:/bin \
  CARGO_HOME="/tmp/ShapeCut Task 3 round 6 中文 empty cargo" \
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
CARGO_ENCODED_RUSTFLAGS=$'-Cdebuginfo=0\x1f--remap-path-prefix=/tmp/Existing round 6 中文 path=/workspace/existing' \
  node scripts/verify-geometry-wasm-regeneration.mjs
git status --porcelain
```

Results: after clean dependency installation, the standard build/test path ran
offline with no Rust-family tool in `PATH` and an empty Cargo home. Build,
Node 75/75, Chromium 35/35 and raw boundary 31/31 passed. The separate pinned
regeneration preserved the existing unit-separator flags and reproduced the
tracked 37,856-byte artifact byte-for-byte. The fresh checkout remained clean;
no offline regeneration claim is made.

Full `npm test` passed 68/71 files and 1766 tests (4 skipped). Two existing
geometry-heavy tests exceeded their 5-second timeout, and one App async test
did not settle under full-suite load. Each exact test passed when rerun alone:

```text
npx vitest run src/app/App.test.tsx \
  -t 'propagates a replacement omission decision and keeps regeneration blocked through the App adapter'
npx vitest run src/export/outline-package.test.ts \
  -t 'packages a real material-bound pipeline result'
npx vitest run src/test/e2e-helpers.test.ts \
  -t 'reconciles a genuine converted package with fixed launcher and three shared fasteners'
```

Results: 1/1 each. No unrelated timeout, UI or geometry implementation was
changed. `npm ci` still reports the existing audit state of 1 moderate and 3
high vulnerabilities. No round 6 change touches UI/CSS, fonts, colours,
production deadline, canonical merge, materials, launcher code or official
release artifacts.
