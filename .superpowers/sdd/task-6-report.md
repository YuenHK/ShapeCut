# Task 6 implementation report

## Scope and ownership

- Production WASM rollout remains disabled by default. The rollout path is enabled only by the existing `shapecut-wasm-rollout=1` query contract.
- No typography, sizing, colour, layout, or other UI styling changed.
- Binary STL presentation is performed inside the restartable geometry worker. It yields every 4,096 triangles, retains at most 2,000 sampled triangles (96,000 bytes), and remains cancellable by terminating the production worker boundary.
- Live-byte evidence now comes from runtime-owned `ArrayBuffer` identities. It covers the worker-received STL, parsed mesh, safe-repair mesh, selected extraction mesh, bounded preview, WASM batch, partition copies and metadata, transferred partition results, simultaneous merge input/output, merged WASM result, and retained result preview. Aliases of one backing buffer are counted once; ordinary positions and indices buffers are counted as distinct buffers belonging to the same mesh owner.
- Exact contour classification now fails closed before its quadratic loop comparison when one layer exceeds the existing contract of one exterior plus 64 hole candidates.
- Existing sequential packaging, replacement, URL revocation, and worker termination remain the cleanup boundaries; they were exercised by the complete serial performance suite.

## Review findings and TDD evidence

### RED

- The new runtime live-byte tests initially failed because only a theoretical estimator existed. It also described ordinary positions and indices buffers as duplicate full-mesh ownership.
- A runtime slice-pool test initially lacked any observation for transferred partition result arrays.
- Independent re-review found that the first tracker still cleared `partition.planeIndices` while each `ExpectedPartition` retained it, and cleared partition result inputs inside the merge callback while `job.results` still retained them. The revised RED requires 16 bytes of live single-worker plane metadata after transfer and a 384-byte simultaneous input/output merge observation; the old tracker reported neither lifecycle correctly.
- Accepted and rejected repair-path RED tests also found no `pipeline:repair-ready` or `pipeline:extraction-mesh` observations, proving the first tracker omitted the full typed buffers returned by `repairMeshSafe`.
- The 500,000-triangle presentation cancellation test timed out at its former `postMessage` spy because a fast scanner could finish before that spy represented cancellable in-progress work.
- The production safe-conversion Playwright case twice timed out waiting for its preview. Inspection of a fresh build found `dist/assets/geometry.worker-*.ts`: moving the worker URL into a variable had prevented Vite from bundling the geometry worker.
- After that blocker was removed, the complete serial suite exposed a second production blocker: the 100,000-triangle case remained in exact slicing after 35 seconds. Exact contour classification performed pairwise loop comparisons before enforcing its 64-hole bound. A 66-loop unit test first returned the later `multiple closed loops` ambiguity instead of failing the resource budget before classification.
- The first actual-WASM synthetic gate timed out waiting for `slice-pool:partitions-ready` because the acceptance work was posted only after the large production conversion had already occupied the geometry worker.

### GREEN

- The live-byte tracker counts actual backing-buffer identities, performs atomic owner replacement, rejects cross-owner claims, and reaches a zero-byte cleanup observation.
- Slice-pool observations include batch ownership, partition copies, transfer, partition results, merged WASM output, and cleanup. The production transfer test verifies the caller batch arrays are detached.
- Transferred partitions retain their still-referenced `planeIndices`. Merge now observes partition metadata, every input result buffer and the newly allocated output together; only `job.results.clear()` and the explicit result handoff release the input owners.
- The pipeline reports both accepted and rejected safe-repair buffers. Accepted repair transfers that buffer identity to extraction ownership while retaining the original parsed mesh; rejected repair retains its repair output beside the original extraction mesh until result handoff.
- The 500,000-triangle cancellation gate waits for `SHAPECUT_PRESENTATION_SCAN_STARTED`, invokes production `cancelActive()`, observes `SupersededError`, verifies worker termination and caller-buffer retention, and completes a replacement presentation.
- `geometry-client.ts` now uses Vite's `?worker&url` contract. A production-build regression test requires a referenced `geometry.worker-*.js` asset containing the worker acceptance surface and rejects a raw TypeScript artifact.
- Exact slicing rejects more than 65 layer loops before quadratic classification. The 100,000-triangle Playwright case now reaches a typed bounded terminal classification.
- The synthetic gate waits for the real material presentation canvas, starts actual WASM work before production conversion occupies the worker, waits for the runtime partition stage, uses the production Cancel control, and requires `created === terminated` plus `active === 0`.

## Runtime measurements

Fixed Chromium, one JSON-evidence trial per synthetic size. The observer was installed before file selection; `previewAt` was recorded only after `.material-presentation-preview canvas` became visible. These values are attributable buffers reported by the runtime tracker, not an estimate of whole-browser memory.

| Triangles | Preview reached | Cancelled total | Longest main-thread task | Presentation runtime peak | Geometry workers |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 200,000 | 861 ms | 4,137 ms | 0 ms | 10,096,084 bytes | created 1, terminated 1, active 0 |
| 500,000 | 1,356 ms | 4,431 ms | 0 ms | 25,096,084 bytes | created 1, terminated 1, active 0 |
| 1,000,000 | 1,850 ms | 4,900 ms | 0 ms | 50,096,084 bytes | created 1, terminated 1, active 0 |

For every size, the worker-side presentation observation comprised the actual worker STL buffer plus the fixed 96,000-byte sampled preview. The actual acceptance WASM workload then reported:

- `wasm-source:batch-ready`: 600,228 bytes.
- `slice-pool:partitions-ready`: 3,000,660 bytes total (600,228-byte owned batch plus 2,400,432 bytes of worker partitions).
- `slice-pool:partitions-transferred`: 96 bytes of still-retained `planeIndices` metadata after the transferable geometry buffers leave the coordinator.
- `slice-pool:cleanup`: 0 attributable bytes.

The focused production WASM canonical fixture separately observed a 15,260-byte merge instant: 5,772 bytes of pipeline-owned STL/mesh/preview state, 24 bytes of retained partition metadata, 4,792 bytes of partition result inputs, and 4,672 bytes of merged output. After `job.results.clear()` the handoff observation was 10,444 bytes (pipeline state plus merged output), so the merge peak no longer drops its still-live inputs.

All three cases had no main-thread task of 100 ms or longer and reached worker active count zero before the assertion returned.

## Verification status and risks

- Complete serial `e2e/performance.spec.ts`: 6/6 passed in 1.1 minutes. This included safe conversion, the 100,000-triangle bounded result, all three synthetic cancellation cases, and the final package-replacement case (29.3 seconds).
- Re-review-focused Node regression: 3 files, 66 tests passed in 156.95 seconds.
- Re-review-focused Chromium regression: 2 files, 46 tests passed in 81.28 seconds.
- The package-replacement case observed the real `pdf:create:before` checkpoint, one replacement trigger, at least two package requests and workers, and a complete second exact result with the same captured near-limit workload evidence.
- TypeScript project typecheck passed. Production build transformed 178 modules, emitted `geometry.worker-*.js`, and retained the tracked 38.16 kB WASM asset; production WASM remained off without the rollout query.
- `git diff --check` passed. The scoped privacy scan found no local path, account identifier, or credential pattern.
- One earlier isolated cold WebGL/ANGLE run reported a 290 ms startup task. It did not recur in two immediate focused repeats or either subsequent complete performance run; the `<100 ms` assertion remains unchanged. Cold-start variance therefore remains a re-review risk rather than a hidden or relaxed gate.
- Task 7 still owns warmed five-run Knight A/B timing, whole-pipeline release thresholds, and final release approval. This report does not approve release.
