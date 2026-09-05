# Final polygon hot-path report

## Scope

- Optimized only `src/domain/engraving/geometry.ts` `pointOnSegment`.
- Added a conservative expanded edge-AABB rejection before `Math.hypot` and the cross-product calculation.
- Retained the original final bounds predicate so `NaN`, infinity, overflow, and tolerance behavior remains identical.
- Did not modify hole containment, UI, canonicalization, launcher behavior, cancellation checkpoints, or the default-off WASM route.

## TDD evidence

- RED: `geometry.point-on-segment.test.ts` reported 1 failure because an obviously separated point still invoked `Math.hypot` three times.
- The independent pre-change public-predicate oracle and cancellation tests passed before implementation.
- A first minimal implementation exposed a `NaN` semantic mismatch (`0` instead of `-1`); retaining the original terminal bounds checks restored exact oracle behavior.
- GREEN: the focused geometry pair passed 48/48 tests.

## Work avoided

For a point outside every edge's tolerance-expanded AABB, the focused contract records zero `Math.hypot` calls instead of one per edge. This is a work-avoidance assertion, not an end-to-end speedup claim. No private model benchmark was run.

## Verification

Commands run from the repository root:

```text
npx vitest run src/domain/engraving/geometry.point-on-segment.test.ts src/domain/engraving/engraving.test.ts src/domain/materials/geometry-estimates.test.ts src/domain/materials/materials.test.ts src/domain/outline-assembly/launcher-exterior-expansion.test.ts src/workers/geometry-api.test.ts --maxWorkers=1 --no-file-parallelism
```

Result: 6 files passed, 170 tests passed.

```text
npm run typecheck
```

Result: exit 0.

## Remaining concern

This conservative change proves avoided primitive work and numerical equivalence over the targeted oracle corpus. It does not independently establish a material end-to-end conversion speedup; release-level A/B measurement remains the parent task's responsibility.
