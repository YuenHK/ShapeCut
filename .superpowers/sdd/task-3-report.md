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
