# ShapeCut A3 Rust WASM Geometry Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在GitHub Pages瀏覽器內以Rust WASM和2至4個獨立Web Workers加速重型STL切片，同時保持現有canonical geometry、官方三爪孔及六種輸出完全受驗證。

**Architecture:** 現有GeometryClient仍擁有工作取消及UI contract；geometry orchestrator worker解析及驗證mesh，將Z層分成有界batch交給獨立slice workers。Rust WASM只計算triangle-plane segments，TypeScript reducer仍負責拓撲、特徵、三爪孔、canonical merge及artifacts。

**Tech Stack:** TypeScript 5.9、React 19、Vite 7、Vitest 4、Playwright、Rust stable、wasm-bindgen、wasm-pack、Web Workers、transferable typed arrays。

## Global Constraints

- GitHub Pages、本機處理及現有UI樣式不變；不得加入後端或更改字體、大小、字型、顏色。
- 第一階段不用SharedArrayBuffer；不得依賴COOP／COEP。
- 新production code嚴格TDD；每項任務先取得正確RED再最小GREEN。
- Rust不得決定材料、三爪孔、輪廓角色、警告文字或artifact內容。
- 所有平行結果必須deterministic；worker完成順序不得改變canonical output。
- Knight A/B目標為中位數至少2倍或均不高於15秒；峰值可歸因live bytes降低至少30%。
- 取消後1秒內active slice workers必須為0。
- 未達效能或幾何差異gate時，WASM不得成為production預設。

---

### Task 1: Repair the reproducible baseline and add benchmark contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.test.ts`
- Create: `src/performance/geometry-benchmark-contract.ts`
- Create: `src/performance/geometry-benchmark-contract.test.ts`
- Create: `scripts/benchmark-geometry.ts`
- Create: `docs/validation/wasm-baseline.md`

**Interfaces:**
- Produces: `GeometryBenchmarkSample`, `summarizeGeometryBenchmark(samples)`, JSON benchmark schema with stage milliseconds, elapsed milliseconds, estimated live bytes, triangle count and layer count.

- [ ] Add a failing dependency-contract test proving `npm exec vite-node -- --version` and the validator child process resolve inside a linked worktree.
- [ ] Run the focused test and record RED caused by the missing executable.
- [ ] Pin the direct `vite-node` package and regenerate the lockfile without bulk dependency upgrades.
- [ ] Add file-level 20-second timeout only to the heavy automatic pipeline describe block; do not change production deadlines.
- [ ] Add RED tests rejecting benchmark samples with filenames, paths, hashes, non-finite values, negative durations or inconsistent totals.
- [ ] Implement frozen benchmark schemas and median/p95 summaries.
- [ ] Run typecheck, the 68-file serial Node suite and public fixture validation; record exact baseline counts and failures.
- [ ] Commit: `test: establish wasm geometry baseline`.

### Task 2: Add the deterministic Rust WASM slice kernel

**Files:**
- Create: `crates/geometry-wasm/Cargo.toml`
- Create: `crates/geometry-wasm/src/lib.rs`
- Create: `crates/geometry-wasm/tests/slice_layer_batch.rs`
- Create: `scripts/build-geometry-wasm.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: finite positions, valid triangle indices and sorted plane values.
- Produces: `slice_layer_batch` encoded result with version, plane offsets, Float64 endpoints and Uint32 diagnostic counters.
- Boundary contract: Rust input reserve/resize/copy and plane traversal checkpoint at most every 4,096 items. The controlled JavaScript wrapper owns the sole contiguous allocator primitive: each owned typed-array allocation is hard-capped at 8 MiB with strict checkpoints immediately before and after it; all copy and validation remains chunked.

- [ ] Install/pin the Rust stable toolchain and wasm32-unknown-unknown target in the documented local/CI setup.
- [ ] Write Rust RED tests for a tetrahedron, coplanar triangle, degenerate triangle, non-finite vertex, out-of-range index, unsorted planes and deterministic repeat output.
- [ ] Implement finite validation, checked allocation and canonical plane/triangle/edge ordering.
- [ ] Run `cargo test --manifest-path crates/geometry-wasm/Cargo.toml`.
- [ ] Add a reproducible wasm build script with locked dependencies, `--release`, no source maps and a size report.
- [ ] Commit: `feat: add deterministic wasm slice kernel`.

### Task 3: Define and verify the TypeScript WASM boundary

**Files:**
- Create: `src/wasm/slice-kernel-contract.ts`
- Create: `src/wasm/slice-kernel-contract.test.ts`
- Create: `src/wasm/load-slice-kernel.ts`
- Create: `src/wasm/load-slice-kernel.browser.test.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Produces: `SliceKernel.sliceLayerBatch(request, checkpoint): Promise<SliceBatchResult>`; validates versioned typed arrays before canonical code sees them.

- [ ] Write Node RED tests for malformed version, offsets, endpoint length, non-finite endpoint, extra plane, diagnostic overflow and unsafe allocation.
- [ ] Implement strict parser and immutable public result.
- [ ] Write Chromium RED loading the built WASM asset from the production-compatible Vite path.
- [ ] Implement lazy single-flight loading, sanitized load errors and explicit disposal.
- [ ] Verify the production build emits one hashed WASM asset and no source map or absolute path.
- [ ] Commit: `feat: validate browser wasm geometry boundary`.

### Task 4: Add deterministic layer partitioning and bounded worker pool

**Files:**
- Create: `src/workers/slice-partitioner.ts`
- Create: `src/workers/slice-partitioner.test.ts`
- Create: `src/workers/slice.worker.ts`
- Create: `src/workers/slice-worker-pool.ts`
- Create: `src/workers/slice-worker-pool.test.ts`
- Create: `src/workers/slice-worker-pool.browser.test.ts`

**Interfaces:**
- Produces: `partitionSliceWork(mesh, planes, workerCount)`; `SliceWorkerPool.run(request, onProgress)`; `cancel(): Promise<void>`; `activeWorkerCount`.

- [ ] Write RED tests for hardware policy 1/2/4, byte-cost balancing, no missing/duplicate planes and stable partitions.
- [ ] Implement deterministic partitioning using triangle-plane overlap estimates.
- [ ] Write RED tests for FIFO submission, transferable ownership, out-of-order completion canonical reorder, worker crash, malformed result, cancellation and one-second zero-worker gate.
- [ ] Implement a maximum four-worker pool with generation tokens and hard termination.
- [ ] Run Node and Chromium worker suites.
- [ ] Commit: `feat: add bounded wasm slice worker pool`.

### Task 5: Integrate WASM segments into canonical extraction

**Files:**
- Modify: `src/domain/outline-2.5d/extract.ts`
- Create: `src/domain/outline-2.5d/segment-source.ts`
- Create: `src/domain/outline-2.5d/segment-source.test.ts`
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/workers/geometry-api.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `src/workers/geometry-worker.browser.test.ts`

**Interfaces:**
- Adds: `ExactSegmentSource.collect(mesh, specs, deadline, checkpoint)`; TypeScript source remains the differential oracle and fallback.

- [ ] Write differential RED tests comparing TypeScript and WASM raw segments for closed, open, non-manifold, coplanar, stepped and disconnected meshes.
- [ ] Refactor existing exact extraction behind `ExactSegmentSource` without behavior changes; verify existing tests green.
- [ ] Connect the worker pool source and canonical-sort every returned segment.
- [ ] Add fail-closed comparison sampling in non-production test builds; reject any topology or diagnostic mismatch.
- [ ] Preserve progress stages, preview limits, error mapping, source evidence and official launcher planning.
- [ ] Run automatic pipeline, geometry API and real Chromium worker suites.
- [ ] Commit: `feat: accelerate canonical slicing with wasm`.

### Task 6: Reduce peak memory and keep UI responsive

**Files:**
- Modify: `src/domain/pipeline/automatic-outline-pipeline.ts`
- Modify: `src/workers/geometry-client.ts`
- Modify: `src/workers/geometry.worker.ts`
- Modify: `src/app/processing-timeline.test.ts`
- Create: `src/performance/geometry-memory.test.ts`
- Modify: `e2e/performance.spec.ts`

**Interfaces:**
- Produces bounded preview copies, stage live-byte observations and deterministic cleanup after packaging/cancel/replacement.

- [ ] Write RED tests for duplicate full-mesh buffers, retained batch inputs, late progress and nonzero active workers after cancellation.
- [ ] Transfer partition buffers, release batch/WASM memory after merge and retain only bounded preview geometry.
- [ ] Generate artifacts sequentially and revoke/release intermediate buffers at the existing ownership boundaries.
- [ ] Verify no main-thread task of 100ms or longer for 200k/500k/1M synthetic models.
- [ ] Commit: `perf: bound browser geometry memory`.

### Task 7: Performance, geometry and release acceptance

**Files:**
- Create: `scripts/verify-wasm-geometry-release.ts`
- Create: `src/test/wasm-geometry-release.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy-pages.yml`
- Modify: `README.md`
- Modify: `docs/validation/software-results.md`

**Interfaces:**
- Produces canonical release evidence for TypeScript/WASM differential geometry, five-run medians, live bytes, cancellation and bundle inspection.

- [ ] Run five warmed trials for Knight A/B and synthetic 200k/500k/1M models on the fixed Chromium/Apple-Silicon benchmark host.
- [ ] Verify launcher fingerprint/rotation/fit/exterior expansion, omission decisions, layer geometry and all artifact reconciliations match.
- [ ] Verify at least2x median speedup or both Knight models at most15seconds, at least30percent live-byte reduction, no100ms main-thread task and cancellation within1second.
- [ ] Add CI Rust cache/toolchain, locked cargo test, WASM build, Node/browser differential tests and production bundle inspection.
- [ ] Run typecheck, serial Node, full Chromium, scoped Playwright performance, private/public fixtures, production build and `git diff --check`.
- [ ] Request independent whole-branch review and fix every Critical/Important finding.
- [ ] Commit: `docs: verify wasm geometry acceleration`.
