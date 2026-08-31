# Task 2 report: deterministic Rust WASM slice kernel

Date: 2026-08-31
Branch: `codex/wasm-geometry`
Base: `7ead9dcbb300933530748585d39801f09474fd35`
Commit: `7bb36e44feb447c2e89eb7086a0a4b345b864e07`

## Scope delivered

- Added a pure Rust `slice_layer_batch` kernel and a `wasm-bindgen` typed-array boundary.
- Encoded result version, status code, per-plane segment offsets, `Float64Array`
  endpoints and fixed-index `Uint32Array` diagnostic counters.
- Enforced deterministic plane -> triangle -> edge traversal and canonical positive zero.
- Rejected non-finite positions/planes, incomplete buffers, out-of-range indices,
  non-strict plane order, zero check interval, excessive vertex/triangle/plane/work
  counts, allocation failure and checked integer overflow.
- Bounded segment output and used checked `Vec::try_reserve_exact` allocations.
- Reported and skipped degenerate triangles; reported coplanar and ambiguous
  triangle-plane evidence without making the TypeScript success/warning/failure decision.
- Added the locked Rust dependency graph, pinned repository toolchain, pinned
  `wasm-pack` version check, release build script, source-map gate and byte-size report.
- No UI, CSS, typography, colour, layout, launcher geometry or production deadline
  files were modified.

## Toolchain and installation

- `rustup 1.29.0 (28d1352db 2026-03-05)` installed from the official
  `https://sh.rustup.rs` script with `--profile minimal`.
- `rustc 1.98.0 (88d9e12ae 2026-08-18)` and
  `cargo 1.98.0 (797e8a9bc 2026-08-05)` are pinned by root
  `rust-toolchain.toml`, including `rustfmt`, `clippy` and
  `wasm32-unknown-unknown`.
- `wasm-pack 0.15.0` installed with
  `cargo install wasm-pack --version 0.15.0 --locked`; the build script rejects
  any other version.
- Node.js `v24.18.0`; npm `11.16.0`.

## TDD evidence

RED command:

```text
cargo test --manifest-path crates/geometry-wasm/Cargo.toml
```

RED result: expected compile failure `E0432` because the tests referenced the
not-yet-implemented `slice_layer_batch`, result constants, diagnostics and typed
error codes. This established that the new tests did not pass against an empty
kernel.

GREEN command:

```text
cargo test --manifest-path crates/geometry-wasm/Cargo.toml
```

GREEN result after the minimum implementation: 9 integration tests passed, 0
failed. The suite covers tetrahedron output/order, coplanar evidence, degenerate
evidence, NaN/Infinity, out-of-range and incomplete indices, incomplete positions,
unsorted/duplicate planes, zero check interval, bounded allocation/work and
bitwise deterministic repeat output.

## Fresh verification before commit

- `cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check` — exit 0.
- `cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --all-targets --all-features --locked -- -D warnings`
  — exit 0.
- `cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --target wasm32-unknown-unknown --release --locked -- -D warnings`
  — exit 0.
- `cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked` — 9 passed,
  0 failed; doc tests 0 failed.
- `cargo check --manifest-path crates/geometry-wasm/Cargo.toml --target wasm32-unknown-unknown --release --locked`
  — exit 0.
- `npm run build:geometry-wasm` — release build succeeded; generated WASM was
  28,838 bytes with 0 source maps.
- Node `initSync` smoke test called the generated WASM tetrahedron path and
  observed offsets `[0, 3, 6]`, 24 endpoint values and 6 segments.
- Two consecutive release builds produced the identical SHA-256
  `b6d17afda7196a19c2b833dd50d4db654bd182b31d1feec47b7a85427db94787`.
- Generated output search found no `.map`, `sourceMappingURL`, `/private/` or
  `/Users/` path material.
- `git diff --check` — exit 0.

## Self-review

- Verified every dynamic Rust allocation is pre-bounded and uses a checked
  reservation; every count multiplication/addition and output conversion is
  checked before use.
- Verified production code contains no `unsafe`, `unwrap`, `expect`, `panic!`,
  `todo!` or `unimplemented!`.
- Verified output append order is plane index, source triangle index, then
  crossing edge index; per-plane offsets are cumulative segment counts.
- Verified `.superpowers/sdd/progress.md` was pre-existing/unrelated and was not
  staged or modified by this task.

## Concerns and boundaries

- `wasm-pack 0.15.0`'s bundled `wasm-opt` rejected Rust 1.98 bulk-memory and
  non-trapping conversion instructions on this Apple Silicon host. The script
  therefore uses documented `--no-opt`; Cargo release still uses size
  optimisation, single codegen unit, LTO, abort panics and symbol stripping.
  The resulting 28,838-byte binary is deterministic. A future toolchain upgrade
  may re-enable compatible `wasm-opt` after fresh verification.
- `deadline_check_interval` provides deterministic periodic resource/checkpoint
  gates and a diagnostic count. Wall-clock cancellation remains outside this
  pure synchronous kernel and belongs to the later worker termination/generation
  contract; no production deadline was changed.
- This task supplies raw slice segments and evidence only. TypeScript canonical
  validation, worker cancellation, differential parity and UI-safe fallback are
  explicitly later tasks and are not claimed here.

## Reviewer-finding fixes

Date: 2026-08-31
Review source: `.superpowers/sdd/task-2-review-findings.md`
Fix commit: `0f4ec29b4d43d9657afabbde268d5d9bb8832bfa`

### Changes

- Replaced wasm-bindgen slice arguments with borrowed JavaScript typed-array
  references. The wrapper validates lengths, divisibility, count limits,
  work limits and deadline interval before allocating or copying into WASM.
- Replaced cloning typed-array getters with zero-copy pointer/length fields.
  The generated `SliceBatchResult.free()` is the explicit disposal boundary;
  boundary tests prove the object cannot be reused after disposal.
- Bounded output to 262,144 segments (8 MiB endpoint payload) and verified a
  typed `OutputLimit` failure at the real WASM boundary.
- Replaced per-segment exact reservation with bounded geometric endpoint growth.
  A 50,000-segment regression test observes no more than eight growth events.
- Plane classification now uses local axial/vertex magnitude. Degeneracy and
  planar ambiguity use local triangle edge scales, so unrelated/unreferenced
  coordinates do not change a triangle's classification.
- Added a maximum deadline check interval of 4,096 work items and an actual
  bounded abort hook. WASM invokes
  `globalThis.__shapecut_geometry_should_abort()` at each checkpoint; `true`, a
  thrown hook, or a missing hook all fail closed. No production deadline value
  was changed.
- Shared on-plane edge evidence now sets `STATUS_GEOMETRY_EVIDENCE`.

### Additional RED evidence

1. Local tolerance/status RED:

```text
cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked
```

Result: 14 tests ran; 10 passed and 4 failed as intended:
`huge_xy_extent_does_not_turn_tiny_axial_crossing_into_coplanar_evidence`,
`mixed_scale_triangles_use_local_degeneracy_tolerance`,
`unreferenced_far_vertex_does_not_change_slice_or_evidence`, and
`paired_shared_on_plane_edge_sets_geometry_evidence_status`.

2. Geometric allocation RED: the same command failed to compile with `E0432`
because `DIAGNOSTIC_ENDPOINT_ALLOCATION_GROWTH_COUNT` did not yet exist.

3. Deadline RED: the same command failed to compile with `E0432`/`E0599`
because the maximum interval, bounded abort function, and typed deadline errors
did not yet exist.

4. Real WASM ABI RED after building the pre-fix boundary:

```text
node scripts/test-geometry-wasm-boundary.mjs
```

Result: 4/4 failed as intended: pointer/length fields were absent, the abort
hook was not called, oversized input grew WASM memory before rejection, and
oversized output did not fail.

### Fresh GREEN and release verification

- `cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check` — exit 0.
- `cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --all-targets --all-features --locked -- -D warnings`
  — exit 0.
- `cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --target wasm32-unknown-unknown --release --locked -- -D warnings`
  — exit 0.
- `cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked` — 17
  integration tests passed, 0 failed; doc tests 0 failed.
- `cargo check --manifest-path crates/geometry-wasm/Cargo.toml --target wasm32-unknown-unknown --release --locked`
  — exit 0.
- `npm run build:geometry-wasm` — release build passed; WASM 34,605 bytes;
  source maps 0.
- `npm run test:geometry-wasm-boundary` — 4/4 passed, covering zero-copy
  pointer/length output and disposal, bounded abort, oversized input preflight,
  and oversized output failure.
- Node WASM smoke — offsets `[0, 3, 6]`, 24 endpoint values, 6 segments, then
  explicit disposal; passed.
- Two consecutive builds produced identical SHA-256
  `0f47123725d3a849b79f721267979dfa2ee1e56bcdf52e3bc56b89b4e20da06d`.
- Generated artifact gate found no `.map`, `sourceMappingURL`, `/private/`, or
  `/Users/` content. Both Node scripts passed `node --check`.
- `git diff --check` — exit 0.

### Remaining boundaries

- The caller/loader must install the deadline hook before the first kernel call;
  omission intentionally returns `DeadlineCheckFailed` rather than running
  without bounded checks.
- Zero-copy output views are valid only while their `SliceBatchResult` remains
  undisposed. The later TypeScript boundary must validate/copy the views before
  calling `free()`.
- The previously documented `wasm-opt` compatibility issue remains; Cargo
  release LTO/size optimisation is still active and deterministic.

## Re-review round 2 fixes

Date: 2026-08-31
Review source: `.superpowers/sdd/task-2-review-findings.md`, findings 6–9
Implementation commit: `0df76798df5770af162d19fdd5882db093eb5f48`

### Changes

- This round supersedes the round 1 note that deferred raw-view copying to a
  later TypeScript boundary; the controlled synchronous copy/free boundary is
  implemented here.
- The imported deadline hook now returns a raw `JsValue`. Rust accepts only an
  actual JavaScript boolean; missing functions, throws, `undefined`, `null`,
  numbers (including `NaN`), Promises and all other types map to
  `DeadlineCheckFailed`. An unconditional initial checkpoint makes the hook
  mandatory even for an empty request.
- The public raw WASM deadline interval is now an uncoerced `JsValue`. Rust
  verifies that it is a finite, safe, positive integer no greater than 4,096
  before conversion to `u32`; fractions, infinities, negatives, zero, unsafe
  integers and 32-bit wrapping values fail closed.
- Input typed arrays are allocated and copied in bounded chunks with the same
  hook before allocation and at most every requested interval. Finite position
  and plane validation, index validation, triangle degeneracy preprocessing,
  output copying and output validation use chunks of at most 4,096 items.
- Added `src/wasm/slice-kernel-wrapper.mjs` as the sole controlled JavaScript
  result boundary. It synchronously validates raw pointer/length metadata,
  creates local raw views, copies them into owned arrays, validates the copied
  result and frees the raw Rust result exactly once in `finally`. It restores
  the prior global hook in all exits and rejects reentrant calls, so raw views
  never cross the wrapper or survive into a later call/memory growth.
- No UI, CSS, typography, colour, layout, launcher geometry or production
  deadline was changed.

### Round 2 TDD evidence

1. Native checkpoint RED:

```text
cargo test --manifest-path crates/geometry-wasm/Cargo.toml \
  validation_checkpoints_large_inputs_even_without_plane_work -- --exact --nocapture
```

Result: the new test failed as intended with
`large finite validation must checkpoint in chunks, observed 0 checks`.

2. Controlled-wrapper RED:

```text
npm run test:geometry-wasm-boundary
```

Result: Node failed with `ERR_MODULE_NOT_FOUND` for the not-yet-implemented
`src/wasm/slice-kernel-wrapper.mjs`.

3. Empty-hook and output-copy RED after the first minimum implementation:

```text
npm run test:geometry-wasm-boundary
```

Result: 24 tests ran; 22 passed and 2 failed as intended. The empty request did
not yet require the hook (`Missing expected exception`), and the 5,000-segment
output observed only 21 checkpoints instead of the required bounded output
copy/validation checkpoints.

GREEN commands:

```text
cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked
npm run build:geometry-wasm
npm run test:geometry-wasm-boundary
```

Result: 19 Rust integration tests passed with 0 failures; 26 real Node/WASM
boundary tests passed with 0 failures. Boundary coverage includes strict hook
types and empty requests, raw interval edge cases, large copy/validation/prepass
checkpoint counts, exact-once free, owned retained views after free, and a later
call that forces WASM memory growth.

### Fresh verification

- `cargo fmt --manifest-path crates/geometry-wasm/Cargo.toml -- --check` — exit 0.
- `cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --all-targets --all-features --locked -- -D warnings`
  — exit 0.
- `cargo clippy --manifest-path crates/geometry-wasm/Cargo.toml --target wasm32-unknown-unknown --release --locked -- -D warnings`
  — exit 0.
- `cargo test --manifest-path crates/geometry-wasm/Cargo.toml --locked` — 19
  integration tests passed, 0 failed; doc tests 0 failed.
- `cargo check --manifest-path crates/geometry-wasm/Cargo.toml --target wasm32-unknown-unknown --release --locked`
  — exit 0.
- `npm run build:geometry-wasm` — release build passed; WASM 37,561 bytes;
  source maps 0.
- `npm run test:geometry-wasm-boundary` — 26/26 passed.
- `node --check scripts/test-geometry-wasm-boundary.mjs` and
  `node --check src/wasm/slice-kernel-wrapper.mjs` — exit 0.
- Two consecutive fresh builds produced identical SHA-256
  `b2a427ef4144121e606d0fece34e43431f5368fe37df94292a915b33ef58bf36`.
- Generated artifact gate found no `.map`, `sourceMappingURL`, `/private/`, or
  `/Users/` material. `git diff --check` exited 0.
- Tool versions remain the pinned versions recorded above: rustc/cargo 1.98.0,
  wasm-pack 0.15.0, Node.js 24.18.0 and npm 11.16.0. No new installation was
  required for round 2.

### Self-review and remaining concerns

- Reviewed the boundary for strict boolean handling, safe numeric conversion,
  checked lengths/pointers/alignment, bounded allocations, integer overflow,
  exact-once disposal and deterministic plane -> triangle -> edge ordering.
- Production Rust/JavaScript added in this round contains no `unsafe`, panic,
  unchecked pointer arithmetic, `todo!` or `unimplemented!`.
- The generated low-level wasm-bindgen module necessarily retains its raw ABI;
  application code must import the controlled wrapper only. The boundary test
  imports the generated module solely to verify memory ownership and exact-once
  disposal; it does not return a raw view.
- The previously documented `wasm-opt` compatibility concern remains. Cargo
  release LTO/size optimisation is active, and the artifact is deterministic.
