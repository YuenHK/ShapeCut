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
