# Task 4: Knight and Release Verification

## Status

Implementation verification is complete and final independent review is clean. The scoped geometry and release assertions pass. Physical compatibility remains explicitly unverified.

## Knight acceptance

Both private reference STLs completed within the 30-second conversion deadline:

| Reference | Conversion | Expansion | Rotation | Omitted layers | Black snapshot |
|---|---:|---:|---:|---|---:|
| A | 28,068.937 ms | 5.72 mm | 1.413716694115 rad | `outline-layer-4`, `outline-layer-5` | 150,324 bytes |
| B | 29,297.224 ms | 5.70 mm | 1.413716694115 rad | `outline-layer-4`, `outline-layer-5` | 148,074 bytes |

For both references, the top two layers retain all three official launcher cuts; the expansion is positive and at most 6.00 mm; every omission maps to a layer with no red or blue contours; preview/package generation preserves the snapshotted black geometry; and independent package verification passes.

## Release boundary and artifact verification

- Public worker transfers retain the canonical `assembly.decorationOmissions` decision while excluding `centralHoleSourceEvidence`, `decorationOmissionSourceEvidence`, and `internalValidationEvidence`.
- The worker reconstructs the three private evidence records only from its bounded internal cache when packaging.
- SVG, DXF, preview PDF, exploded PDF, project, manifest, standalone coupon, and the seven-member ZIP are parsed and reconciled. Project/manifest expansion and omission decisions must agree with the physical layers, and omitted layers must have no red or blue members.
- Mutation tests cover role, identity, ordering, geometry, PDF, JSON, manifest hash, ZIP record, and byte-identity drift.
- The earlier PDF review Minor was closed by positive visible-text anchors for `Scale 1:1 | BLACK CUT | RED DEEP | BLUE LIGHT` and `Central axis` before negative-label checks.
- Full Chromium exposed a stale synthetic cancellation result that failed new source-evidence validation before the PDF checkpoint. The fixture now reconstructs exact source exteriors, deterministic top-two expansion, and all 24 central-hole source records; the replacement/cancellation regression passes.

## Final-review fix wave

- Protected-cut topology is validated before work-budget classification, so a self-intersecting protected cut cannot be downgraded to a typed omission solely because the request is also over budget.
- The browser verifier now strictly parses and reconciles all canonical project/manifest material, launcher, fastener, top-feature, omission, privacy, member, and hash decisions. Mutation tests cover previously ignored synchronized metadata forgeries and private-note injection.
- JSON privacy scanning rejects every `.stl` token as well as POSIX, Windows, backslash-UNC, and forward-UNC paths; fresh-hash mutations cover both `private model (copy).stl` and a forward-UNC path.
- Omission order is checked against physical layer order rather than lexicographic layer IDs; the regression uses `layer-2` before `layer-10`.
- The UI and browser expectations now describe all seven ZIP members.
- The four trailing spaces in the two 2026-07-28 spec headers were removed; both working-tree and complete branch-range whitespace checks pass.

## Verification matrix

- Focused Knight test: 3/3 passed.
- Focused release matrix: 3 files / 20 tests passed.
- Real Chromium worker: 34/34 passed.
- Happy-path Chromium: 7/7 passed.
- Fixture/parser regressions: 4 files / 126 tests passed.
- Replacement/cancellation Chromium regression: 1/1 passed.
- Final-review core matrix: 3 files / 162 tests passed.
- Final-review covering matrix: 6/6 files and 774/774 assertions passed, followed by the known unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` RPC error; process exit was nonzero, so this command is not called passed.
- Repository serial Vitest: 65/65 files and 1,655/1,655 assertions passed, followed by one unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` RPC error; process exit was nonzero, so this command is not called passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Working-tree `git diff --check`: passed.
- Complete-range `git diff --check 3dc11a0`: passed.
- A supplemental sequential rerun passed the seven happy-path Chromium cases, then private model A timed out before release assertions because the material selector remained disabled; model B was interrupted when the extra rerun was stopped. The earlier focused Knight acceptance and real-worker browser evidence above remain the scoped release evidence.

## Outstanding physical gate

`physical coupon + official launcher latch/release/play/damage test: outstanding`

No physical compatibility or merge claim is made.

## 2026-07-29 continuation

The two software verification exceptions recorded above are now closed:

- The supplemental Chromium determinism cases explicitly discard the saved project before the repeated conversion. Supplied model A and supplied model B each passed their isolated two-conversion case.
- Vitest was migrated to the supported 4.1 line and Browser Mode to the official `@vitest/browser-playwright` provider. The complete serial command passed 65/65 files and 1,659/1,659 tests with exit 0; the former post-assertion `onTaskUpdate` RPC error did not recur.
- The complete browser-mode command passed 6/6 files and 82/82 tests.
- `vite-node` is declared directly because the release validation scripts invoke it directly.
- First-match exit reduced the protected-boundary hot-path cost while preserving the original `Math.hypot` and tolerance predicates. Post-review private fixture validation passed with reference A at 27,798.824 ms and reference B at 29,239.318 ms.

The physical coupon and official-launcher latch/release/play/damage gate remains outstanding.

---

# 2026-09-01 Task 4 Continuation: Deterministic Slice Worker Pool

Date: 2026-09-01

## Scope completed

- Added the exact device policy: `hardwareConcurrency <= 2` selects one worker,
  `3-5` selects two, and `>= 6` selects at most four.
- Added deterministic longest-processing-time partition assignment using
  triangle-plane overlap byte estimates. Every plane has one owner, each
  partition sorts its plane indices, and retained triangles preserve source
  triangle and edge order.
- Each worker receives only the vertices and triangles overlapping its assigned
  planes under the Rust-equivalent axial tolerance. Degenerate triangles are
  owned once by partition zero so remote and zero-plane evidence is preserved
  without copying the full mesh to every worker. The pool atomically consumes
  the caller's three distinct full-span fixed `ArrayBuffer`s after admission,
  then transfers each partition without `SharedArrayBuffer` or shared WASM
  memory.
- Added one-worker-per-partition FIFO submission, generation-token late-message
  rejection, strict result/error protocols, canonical global-plane merge, and
  immutable result facades.
- Added hard cancellation and replacement. All active workers are terminated
  synchronously, `activeWorkerCount` becomes zero before `cancel()` resolves,
  and cancelled/deadline/validation errors cannot claim fallback eligibility.
- Added an unforgeable private capability for pre-publication bundled-worker
  crash, load, execution, and resource fallback candidates. Injected worker
  factories cannot obtain the capability. The pool never performs a
  fallback itself and never retries or publishes a partial result.
- Added the existing WASM request work/allocation limits and the 8 MiB merged
  endpoint cap before large pool allocations.

## TDD evidence

The following RED states were observed before their production code was added:

1. `slice-partitioner.test.ts` failed because `./slice-partitioner` did not exist.
2. `slice-worker-pool.test.ts` failed because `./slice-worker-pool` did not exist.
3. The first Chromium pool run failed closed as `WORKER_CRASH` because
   `slice.worker.ts` did not exist.
4. Review tests failed because extra protocol fields were accepted, resource
   failure provenance was lost, and callers could forge fallback eligibility.
5. The oversized-plane test timed out because 16,385 planes were not rejected
   at admission.
6. Independent-review tests failed for duplicate planes, near-plane tolerance,
   remote/zero-plane degeneracy evidence, injected fallback provenance, and
   impossible diagnostic counters before those boundaries were corrected.

Every RED was followed by a focused GREEN run before the next behavior was
implemented.

## Fresh verification

- `cargo test --locked --manifest-path crates/geometry-wasm/Cargo.toml`:
  1 unit and 20 integration tests passed.
- `cargo clippy --locked --manifest-path crates/geometry-wasm/Cargo.toml --all-targets -- -D warnings`:
  passed.
- `npm run test:geometry-wasm-boundary`: 31 controlled-wrapper checks passed.
- Final Node boundary/partition/pool run: 3 files and 118 tests passed.
- Node tests include a real `node:worker_threads` isolate loading the tracked
  controlled wrapper and WASM bytes, executing `sliceLayerBatch`, and
  transferring its owned result to the pool.
- Vite Browser Mode tests exercise four real WASM module workers with exact
  plane/triangle/edge order, zero-plane remote degeneracy, hard cancellation,
  and real worker crash/malformed/deadline failure paths.
- Final Chromium loader/pool run: 2 files and 40 tests passed.
- `npm run verify:geometry-wasm-regeneration`: four generated files reproduced
  byte-for-byte; WASM size 37,856 bytes and zero source maps.
- `npm run typecheck`: passed.
- `npm run build`: passed; the existing hashed WASM asset was emitted and no
  source maps were produced.
- `git diff --check`: passed before report generation.
- The initial independent-review statement was premature and is superseded by
  the formal findings and closure evidence below. Task 5 owns production graph
  and bundled-artifact proof.

## Boundaries and remaining work

- Task 4 provides the partitioner, worker module, and pool only. Task 5 must
  connect this pool to canonical extraction before the worker appears in the
  production application graph.
- Task 6/7 retain the heavy-model memory, main-thread long-task, 120-second,
  Knight A/B, and end-to-end artifact acceptance gates. This report makes no A3
  performance-completion claim.
- No UI, CSS, font, material, launcher, canonical artifact, or production
  deadline code was changed.

## 2026-09-01 formal-review closure

The eight formal findings in `task-4-review-findings.md` were addressed with
focused RED/GREEN evidence before the fresh matrix:

1. Pool intake now delegates exact request inspection and atomic ownership to
   the Task 3 hardened helper. Pool-only fields are snapshotted from exact data
   descriptors; partitioning and submission use only the frozen private
   snapshot.
2. The active generation and deadline timer now exist before partitioning.
   Validation, degeneracy classification, overlap estimation and mesh copying
   yield in bounded chunks and re-check cancellation, generation and deadline.
   Cancellation during the maximum legal 500,000-triangle/500-plane
   (250,000,000 tests) partition starts zero workers and reaches zero active
   workers in under one second.
3. The bundled dedicated worker receives a one-shot, realm-gated capsule over
   the controlled wrapper's private result buffers and transfers them directly.
   Public window/Node consumers retain only immutable facades; the former
   `TypedArray.from` result copies were removed.
4. The default worker constructor and worker URL are captured at module load.
   A Chromium test replaces both globals after import and proves that the
   replacement cannot become the trusted worker path.
5. Per-result segment and byte caps run before endpoint traversal. Aggregate
   endpoint bytes are checked before a validated partition result enters the
   job result map. These protocol failures never receive fallback provenance.
6. A queued old-generation listener is invoked after replacement and cannot
   update new progress, result or worker count; replacement workers complete
   normally in canonical plane order.
7. TypeScript and Rust read the same exact f64 bit-pattern overlap corpus for
   positive/negative tolerance edges, high magnitudes and next-representable
   values. Rust follows its kernel boundary; TypeScript expands both bounds by
   one ULP and therefore only over-includes the immediately adjacent case.
8. Task 4 claims Vite Browser Mode real-worker behavior only. Production graph
   and emitted slice-worker artifact proof remain explicitly assigned to Task 5.

Focused and fresh verification before the implementation commit:

- Node contract/partition/pool: 3 files, 129 tests passed.
- Vite Chromium loader/pool: 2 files, 41 tests passed, including real WASM
  module workers, cancellation and post-load bootstrap replacement.
- Raw controlled-wrapper ABI: 31 checks passed.
- Rust: 1 unit and 21 integration tests passed; clippy with `-D warnings`
  passed.
- Shared Rust/TypeScript overlap corpus: 12 exact bit-pattern rows passed in
  both suites.
- Pinned WASM regeneration reproduced four tracked files byte-for-byte; WASM
  size is 38,157 bytes with zero source maps.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.

No SharedArrayBuffer, UI/CSS/typography/colour, material, launcher, canonical
artifact, or production 120-second deadline code was changed. Formal
independent re-review and Task 5 production-graph proof remain external gates;
this section makes no full A3 completion claim.

### Clean-checkout confirmation

Commit `165174d` was checked out detached into a new temporary worktree and
installed with `npm ci`. The following commands passed there without changing
tracked files:

- `npm test -- --run src/wasm/slice-kernel-contract.test.ts src/workers/slice-partitioner.test.ts src/workers/slice-worker-pool.test.ts`:
  3 files / 129 tests.
- `npm run test:browser -- --run src/wasm/load-slice-kernel.browser.test.ts src/workers/slice-worker-pool.browser.test.ts`:
  2 files / 41 tests in real Chromium Browser Mode.
- `npm run test:geometry-wasm-boundary`: 31 checks.
- `cargo test --locked --manifest-path crates/geometry-wasm/Cargo.toml`:
  1 unit / 21 integration tests.
- `cargo clippy --locked --manifest-path crates/geometry-wasm/Cargo.toml --all-targets -- -D warnings`:
  passed.
- `npm run typecheck`, `npm run build`, and
  `npm run verify:geometry-wasm-regeneration`: passed; four generated files
  matched byte-for-byte at 38,157 WASM bytes and zero source maps.

The temporary worktree was then removed. The only remaining non-Task-4
working-tree change is the parent-owned `.superpowers/sdd/progress.md`, which
was neither staged nor committed here.

## 2026-09-01 re-review round 2 closure

### Exact RED evidence

Finding 9 and Finding 12 RED command:

```text
npm test -- --run src/workers/slice-worker-pool.test.ts -t "shadow keys|fail-safe best-effort|pending partition yield"
```

Observed before production changes: 2 failed / 1 passed. A result endpoints
array with an own `Symbol.iterator` was accepted and the pool promise resolved
instead of rejecting. A constructed worker whose listener registration threw
was never terminated (`terminateAttempts` was 0 instead of 1). The original
timer test was not a valid RED because the pool had captured the native timer;
it was replaced by the isolated-bootstrap scheduler test below.

Finding 11 and Finding 10 RED command:

```text
npm run test:browser -- --run src/workers/slice-worker-pool.browser.test.ts -t "bootstrap primitives|arbitrary dedicated worker"
```

Observed before production changes: 2 failed. Post-load mutation of
`Worker.prototype.postMessage`, `Worker.prototype.terminate`, and
`EventTarget.prototype` add/remove methods caused `WORKER_CRASH`. An arbitrary
Blob dedicated worker observed `helperExported: true` and `escaped: true`.

Finding 13 corrected RED command:

```text
npm test -- --run src/workers/slice-worker-pool.test.ts -t "pending partition yield timer"
```

The test re-imported the pool after installing an isolated tracked scheduler.
Observed before production changes: one pending partition-yield timer remained
after `cancel()` resolved (`expected 0, received 1`).

### GREEN implementation and focused evidence

- Worker result arrays now pass the Task 3 captured intrinsic brand, length,
  byte-length, buffer, offset, fixed/full-span and forbidden-own-key inspector.
  Its frozen metadata drives per-result and aggregate caps before indexed
  numeric scans.
- The raw-return result helper was removed. The only worker path is a closed
  publisher that posts the three private buffers directly, is bound to the
  captured bundled slice-worker realm, and returns no raw view. Window, Node,
  and an arbitrary Blob dedicated worker retain only immutable facades.
- Trusted Worker/EventTarget add, remove, post and terminate methods plus
  `Reflect.apply` are captured at module evaluation. The bootstrap-mutation
  Chromium regression now completes the real WASM request.
- A worker enters the active set immediately after construction. Cleanup first
  removes it from the set, then independently attempts both listener removals
  and termination; cleanup exceptions cannot prevent exactly-once settlement.
- A job owns the currently pending partition-yield cancellation closure.
  Cancellation clears the timer and rejects the yield immediately. Async
  partition estimation, mesh remap/index/source-vertex arrays, assignment lists
  and partial partition lists clear their mutable containers in abort paths.

Focused GREEN commands:

```text
npm test -- --run src/workers/slice-worker-pool.test.ts -t "shadow keys|fail-safe best-effort|pending partition yield"
# 3 passed

npm run test:browser -- --run src/workers/slice-worker-pool.browser.test.ts -t "bootstrap primitives|arbitrary dedicated worker"
# 2 passed in Chromium
```

No UI, CSS, typography, colour, material, launcher, canonical artifact or
production deadline code was changed. Full and clean-checkout round-2 evidence
is appended after the final matrices below.

### Round 2 full and clean-checkout evidence

The complete matrix passed in the implementation worktree and again from a
detached clean checkout of commit `b6c726e` after `npm ci`:

- Node contract/partition/pool: 3 files / 133 tests.
- Real Chromium Browser Mode loader/pool: 2 files / 42 tests.
- Controlled raw WASM ABI: 31 checks.
- Rust: 1 unit / 21 integration tests; clippy `-D warnings` passed.
- TypeScript project typecheck and Vite production build: passed.
- Pinned WASM regeneration: four files matched byte-for-byte; 38,157 WASM
  bytes, zero source maps.
- `git diff --check` passed, and the clean checkout had no tracked changes
  after the matrix.

The temporary round-2 worktree and its task-owned dependency/build outputs were
removed. The primary worktree still contains only the parent-owned unstaged
`.superpowers/sdd/progress.md` outside these committed Task 4 changes. Task 5
still owns production graph/bundle proof, so no full A3 completion is claimed.

## 2026-09-01 re-review round 3 closure

### Exact RED evidence

The bootstrap URL and crafted-path regressions were first run against the
round-2 production code:

```text
npm run test:browser -- --run src/workers/slice-worker-pool.browser.test.ts -t "bootstrap primitives|crafted same-origin"
```

Observed before production changes: 2 failed. Replacing
`URL.prototype.toString` after pool import redirected the captured URL object
to an attacker Blob worker, whose malformed result reached the pool. A separate
same-origin worker named `crafted-slice.worker.test-fixture.ts` also passed the
substring realm gate and published its private typed-array buffers instead of
returning `{ closedEntryDenied: true }`.

The direct-transfer regression was applied to a detached checkout of round-2
commit `0149229` and run there:

```text
npm test -- --run src/wasm/slice-result-publisher.test.ts
```

Observed before production changes: 1 failed. After contract evaluation, a
replacement `%TypedArray%.prototype.buffer` getter threw `patched typed-array
buffer getter` from `publishBundledSliceBatchResult`; its ordinary transfer
array was also dependent on the mutable array iterator chain.

### GREEN implementation and focused evidence

- The pool now captures the intrinsic URL `href` getter at bootstrap,
  immediately serializes the bundled worker URL to a primitive string, and
  gives only that primitive to the captured Worker constructor. Post-load URL
  stringifier or constructor replacement cannot redirect the trusted path.
- The worker publisher captures WorkerLocation `href` through its intrinsic
  prototype getter. A production single-file worker is accepted only when its
  exact URL equals `import.meta.url`; Vite development accepts only the exact
  same-origin pathname derived from the contract module URL. Substring matches
  and crafted same-origin `slice.worker` names are rejected.
- Result ownership stores the three intrinsic backing buffers when ownership
  is created. Publication uses only those captured buffers in a frozen transfer
  array with an own captured iterator whose returned iterator has an own
  captured `next`. The frozen options record is posted through the captured
  worker primitive, then every owned buffer must satisfy intrinsic detached
  postconditions.

Focused GREEN commands:

```text
npm test -- --run src/wasm/slice-result-publisher.test.ts
# 1 passed

npm run test:browser -- --run src/workers/slice-worker-pool.browser.test.ts -t "bootstrap primitives|crafted same-origin|loads WASM in bounded workers"
# 3 passed in Chromium
```

### Round 3 full worktree evidence

- Node contract/publisher/partition/pool: 4 files / 134 tests passed.
- Real Chromium Browser Mode loader/pool: 2 files / 43 tests passed.
- Controlled raw WASM ABI: 31 checks passed.
- Rust: 1 unit / 21 integration tests passed; clippy `-D warnings` passed.
- TypeScript project typecheck and Vite production build passed.
- Pinned WASM regeneration reproduced four tracked files byte-for-byte at
  38,157 WASM bytes and zero source maps.
- `git diff --check` passed.

No UI, CSS, typography, colour, material, launcher, canonical artifact or
production deadline code was changed. Task 5 still owns production graph and
emitted slice-worker artifact proof; no full A3 completion is claimed.

### Round 3 detached clean-checkout confirmation

Commit `8c74aa6` was checked out detached into a new temporary worktree and
installed with `npm ci`. The full round-3 matrix passed again with the same
counts: Node 4 files / 134 tests; real Chromium 2 files / 43 tests; raw WASM
31 checks; Rust 1 unit / 21 integration tests; clippy `-D warnings`; typecheck;
Vite build; and pinned byte-for-byte regeneration of four files at 38,157 WASM
bytes and zero source maps. `git diff --check` passed and `git status --short`
was empty after the matrix. The temporary checkout was then removed.
