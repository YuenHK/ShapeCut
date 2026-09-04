# Task 5 review findings

## Critical

1. Differential oracle must compare against the original production TypeScript projected mesh, not the Float32 WASM projection. Unify TS/Rust plane tolerance semantics. Any non-exact canonical equivalence routes to TypeScript before publication. Add non-Z-axis, near-plane, Float32-edge, and full artifact identity cases.

## Important

2. Float32-unsafe/mixed-scale inputs must preselect the original TypeScript source before starting workers, return origin `typescript`, and never map to resource error.
3. Restore performance gates without changing automatic 20s/browser 15s/production 120s acceptance boundaries. Remove unconditional non-production full oracle cost; use explicit differential mode/test sampling or improve routing until automatic and geometry-worker full suites pass.

## Minor

4. Production acceptance compares all six outputs. For nondeterministic ZIP metadata, unpack and compare canonical members.
5. Add actual-WASM singleton cancel/replacement integration: active workers zero within one second, no late publication, new generation unpolluted.

## Final-review findings

6. Production WASM eligibility must have no false-safe Float32 rounding. Require exact Float32 round-trip for every position used by the WASM kernel; binary STL values naturally satisfy this. Any non-exact coordinate preselects the original TypeScript source before workers start. Keep exact differential mode as verification, not an unconditional production cost. Add the known `0.1/1.1` false-safe regression and prove runner zero.
7. Restore the 15-second browser gate for the production six-output identity case. Use a representative fixture small enough for functional artifact identity under 15 seconds; private Knight performance remains Task 7. Do not retain a 120-second override for this browser gate.
8. Make full E2E truthful and green: external private A/B cases skip when inputs are absent and are separately proven conditionally; the synthetic 100k empty-topology case may accept deterministic genuine `NO_OUTLINE` as a bounded terminal classification instead of relabeling production output.
9. Correct the report: production runtime remains `Infinity`; 120 seconds is the 1M-model acceptance boundary. State that the evidence-based 30-second test-only timeout applies to the whole outline-package describe block, not a single test.

## Verification

- Strict TDD RED to GREEN for every item.
- Exact canonical differential and all artifact identities, automatic 20-second suite, geometry-worker 15-second suite, real WASM cancel/replacement, full Node/Chromium/E2E/public fixtures/build/bundle/Rust/raw/fresh gates.
- Append exact RED/GREEN evidence to `.superpowers/sdd/task-5-report.md`, commit, self-review, and require independent review with zero Critical, Important, and Minor findings.
