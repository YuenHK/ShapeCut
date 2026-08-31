# WASM geometry baseline

Date: 2026-08-31  
Branch: `codex/wasm-geometry`  
Runtime: Node.js `v24.18.1`, npm `11.16.0`, Vitest `4.1.10`

## Reproducibility repair

The linked-worktree baseline initially could not resolve the direct `vite-node`
executable. Five assertions failed with `ENOENT` or `MODULE_NOT_FOUND`. The
direct dependency is now pinned to `3.2.4` in both `package.json` and the lockfile.

The heavy `automatic outline pipeline` test block now has a test-only 20-second
timeout. This does not change the application's 120-second production deadline.

## Benchmark contract

Geometry benchmark samples use schema version 1 and contain only stage and total
durations, estimated live bytes, triangle count, and layer count. The schema is
strict and rejects identifying filenames, paths, hashes, non-finite values,
negative values, and inconsistent totals. Summaries report deterministic median
and nearest-rank p95 values.

## Verification evidence

- Focused contract suite:
  `npm test -- src/performance/geometry-benchmark-contract.test.ts --maxWorkers=1 --fileParallelism=false`
  — 1 file passed; 14 tests passed.
- Type checking: `npm run typecheck` — passed.
- Public fixture validation: `npm run validate:fixtures:public` — 10 fixtures;
  8 automatic successes; output comparison passed; all fixture results passed.
- Serial Node suite before repair: 68 files total; 65 passed and 3 failed;
  1665 tests passed, 4 skipped, and 12 failed. Five failures were caused by the
  missing `vite-node` executable/module and seven heavy automatic-pipeline tests
  exceeded Vitest's default 5-second timeout.
- Serial Node suite after repair:
  `npm test -- --maxWorkers=1 --fileParallelism=false` — 69 files total; 68 passed
  and 1 failed; 1690 tests passed, 4 skipped, and 1 failed. The remaining failure
  is the pre-existing genuine-package reconciliation test in
  `src/test/e2e-helpers.test.ts`, which exceeded the default timeout by about
  12 ms during the full run. A focused rerun of that exact test passed (1
  passed, 63 skipped). Task 1 deliberately does not broaden timeout changes
  beyond the specified automatic-pipeline describe block.

This record is a software baseline. It does not claim the physical launcher
interface has passed real-world fit testing.
