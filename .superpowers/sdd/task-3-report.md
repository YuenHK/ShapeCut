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
- Publishes only a frozen public result record over the controlled wrapper's
  already-owned arrays. Raw pointer/length ABI and WASM memory views remain
  confined to `slice-kernel-wrapper.mjs`.
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
- Generated wasm-pack output remains git-ignored by the existing repository
  policy. A fresh checkout must run `npm run build:geometry-wasm` before the
  browser test or production build; later CI integration is Task 7 scope.
- Focused ESLint could not run because this repository has no
  `eslint.config.js|mjs|cjs`; ESLint 9 exited 2 before reading files. Typecheck,
  Node, Chromium, Rust/clippy and production gates are green; no lint-config
  change was made in this task.
- wasm-pack still reports its existing platform warning and falls back to its
  installed wasm-bindgen path. Both builds completed and were byte-identical.
