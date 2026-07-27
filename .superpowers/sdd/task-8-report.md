# Task 8 report

## Status

DONE_WITH_CONCERNS. The software release-verification changes are implemented and
the synthetic success/failure contracts are green. Final release acceptance is
blocked: both supplied Knight Fortress STL files correctly fail closed because
the fixed official launcher cannot preserve containment and minimum web on their
top two extracted layers. No template scaling or model-exterior expansion was
made.

## Implemented scope

- Added exact runtime checks for fixed template version, 32-hex fingerprint,
  zero fit offset, three cuts on only the top two layers, and identical
  top-two launcher geometry.
- Added a structurally impossible synthetic STL UI case that must report
  `LAUNCHER_INCOMPATIBLE` and expose zero downloads.
- Added one launcher-compatible closed synthetic cylinder for exact-mode success
  and one launcher-compatible open cylinder for real 2.5D Comlink coverage.
- Reconciled six direct downloads: ZIP, SVG, DXF, preview PDF, exploded PDF,
  and the standalone launcher coupon. The ZIP remains exactly five canonical
  non-directory members, each byte-identical to its direct artifact.
- Made the standalone coupon mandatory rather than allowing its ZIP member to
  be counted twice. Its parser consumes the complete SVG and requires 15 black
  cuts, five exact labels, template/fingerprint/material/kerf evidence, and no
  root-external content.
- Tightened canonical black-cut identity. Launcher entities must be exactly
  `${layerId}-launcher-clearance-{1,2,3}` on their owning layer; rename and
  cross-layer ownership mutations are rejected.
- Preserved exact SVG/DXF entity parity, complete PDF grammar/stream/EOF checks,
  raw ZIP headers/CRC/order/EOF checks, and runtime-to-sheet-space contour
  translation checks.
- Rehydrated `LAUNCHER_INCOMPATIBLE` across the Comlink client so the UI receives
  the typed failure instead of a generic packaging error.
- Corrected the test-only near-limit package fixture to use a radius 30 mm
  exterior. The previous radius 20 mm fixture was physically incompatible with
  the unchanged official template; the corrected 49,728-point workload reaches
  the PDF checkpoint and exercises termination/replacement.

The final colored release API intentionally contains exactly the six downloads
above. It does not expose project JSON or manifest downloads, and its public-text
privacy contract explicitly forbids JSON/manifest content. No new production API
was added in this verification-only task. Independent geometry is instead checked
against the bounded worker result and canonical sheet translation.

## TDD evidence

- RED: the first focused happy-path run failed because the helper still expected
  five direct downloads and the worker client lost `LAUNCHER_INCOMPATIBLE`.
- RED: the focused worker API test rejected the expected five-code public error
  allowlist because launcher incompatibility was missing.
- RED: canonical launcher rename/layer-ownership and missing standalone-coupon
  mutations produced two expected failures before the helper was tightened.
- GREEN: `src/test/e2e-helpers.test.ts` passed 61/61 after the canonical identity
  and standalone-coupon fixes.
- GREEN: the real Chromium 2.5D Comlink progress case passed 1/1 using the open
  radius 30 mm cylinder.

## Verification

- `npm test -- --maxWorkers=1`: all 63 test files and all assertions passed
  (1,461 passed, 1 intentional skip), but the command exited 1 because Vitest
  emitted one unhandled runner RPC error:
  `[vitest-worker]: Timeout calling "onTaskUpdate"`.
  The isolated 75.5-second `automatic-outline-pipeline.test.ts` reproduces the
  same error after its 32/32 assertions pass. Shard 2 exited 0 with 534 passed
  and 1 skipped; shard 1 completed 927/927 assertions before the same RPC error.
- `CI=1 npm run test:browser -- --maxWorkers=1`: 6/6 files and 82/82 Chromium
  tests passed before the final parser-only hardening. The affected 2.5D worker
  test was then rerun and passed 1/1.
- Full private-fixture Playwright:
  15/17 passed. The only failures are the two supplied Knight acceptance cases;
  both show `官方三爪孔會破壞外框或必要承托結構，已停止所有輸出。`.
  The synthetic impossible case blocks all downloads, and the near-limit PDF
  cancellation/replacement case passes in 23.2 seconds.
- Focused happy-path Playwright: 6/6 passed.
- Focused private validator: 12 passed and 1 failed at the private Knight runtime
  gate.
- `npm run build`: passed on the final working tree.
- `git diff --check`: passed.

## Independent review

The final re-review verdict is APPROVE with no blocking, important, or minor
findings. The reviewer confirmed canonical launcher ID/layer ownership,
mandatory standalone-coupon byte identity, restored real 2.5D Comlink coverage,
and that JSON/manifest are intentionally outside the colored-package API.

## Exact Knight blocker evidence

The official unrotated numeric template aggregate bounds are:

```text
x: [-22.615513599, 22.632443993]
y: [-23.113520756, 23.137282167]
```

Reference A uses unrepaired projected-original geometry, shortest-bounds Z axis,
and six layers:

```text
second exterior x: [-22.717000008, 22.810344512]
second exterior y: [-23.319998980, 23.351887721]
top exterior x:    [-21.699629180, 21.665802331]
top exterior y:    [-22.048285445, 22.080174187]
```

Reference B uses unrepaired projected-original geometry, candidate axis
`[-0.004495344, 0.016375734, 0.999855803]`, and six layers:

```text
second exterior x: [-22.567175377, 23.008941139]
second exterior y: [-23.173127833, 23.548756975]
top exterior x:    [-20.275638792, 21.863172846]
top exterior y:    [-21.900051953, 22.148373507]
```

The top-layer bounds are smaller than the raw template envelope before kerf and
minimum-web protection. The planner finds no safe placement across its bounded
rotation search and raises `LAUNCHER_INCOMPATIBLE`. Changing the fixed template
or enlarging the model exterior requires a new user design decision.

## UI and physical acceptance

The built UI was exercised in Chromium by the browser and Playwright suites,
including keyboard-operable selection, result/download controls, replacement,
and incompatible-model fail-closed behavior. A separate interactive in-app
browser backend was unavailable during final inspection.

No physical coupon was cut in this task. The required latch/release, rotational
play, repeated-release, and cracking/local-thinning checks therefore remain
external blockers. The UI copy
`依 Knight Fortress 樣本建立，待官方發射器實物校準` remains unchanged.
