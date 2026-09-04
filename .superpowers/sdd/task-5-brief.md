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
