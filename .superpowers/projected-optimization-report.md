# Projected containment optimization report

Date: 2026-09-05

Scope: Task 1 only. The implementation is confined to `src/domain/outline-features/hole.ts`; there are no UI, polygon-module, global-cache, or WASM-default changes.

## Exact implementation decisions

- Prepare the exterior scale and its directed edges once per `isStrictlyContainedLoop` call.
- Preserve point-location tolerance exactly as `max(original exterior scale, abs(point.x), abs(point.y))`; the candidate-wide scale remains reserved for segment-intersection tolerances exactly as before.
- Store edge bounds using the same `Math.min`/`Math.max` expressions formerly evaluated inside each intersection/clearance comparison. Prepared intersection uses the same four tolerant AABB inequalities, cross products, and `onSegment` predicates in the same order.
- Preserve clearance's running minimum and dynamic conservative AABB rejection. Return `false` early only after an actually evaluated distance makes the existing predicate `distance + 1e-12 >= minimumClearance` false. Since every later running minimum is no greater (or becomes `NaN`, which is also rejected), this cannot turn a legacy `true` into `false` or vice versa.
- Retain deadline checks at entry, each candidate edge, every 64 exterior edges, before clearance, and in clearance loops. Exterior preparation also observes the deadline. The caller checkpoint remains on the same public containment checkpoints; there is no global mutable cache.
- Empty/malformed behavior is not normalized or newly validated: the public function keeps its existing return/throw behavior.

## TDD and oracle evidence

The test-local reference independently spells out ray casting, tolerant segment intersection, endpoint-to-segment distance, and the original running-minimum result. It covers concavity, touching/crossing, midpoint escape, both sides of the `1e-12` clearance allowance, translation, mixed scale, reversed winding, empty/degenerate inputs, malformed clearances, and checkpoint cancellation. A deterministic matrix adds 192 scale/translation/winding/position/clearance comparisons.

RED mechanism evidence (original source): the 256-edge coordinate-access test observed 49,706 exterior-coordinate reads, exceeding the final non-timing cap of 40,000. GREEN optimized source observes 31,374 reads. This assertion is deterministic and does not use wall time.

## Commands and results

```text
npm test -- src/domain/outline-features/hole.test.ts
Test Files  1 passed (1)
Tests       31 passed (31)

npm run typecheck
tsc -b --pretty false
exit 0

git diff --check
exit 0
```

The controller is running the private reference A/B outside this commit to avoid benchmark contention. Its canonical six-artifact and unpacked-ZIP comparison belongs to the controller's Task 2 evidence; no independent review or release acceptance is claimed here.
