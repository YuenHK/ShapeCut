# Task 5 Report: Calibration Coupon and Artifact Reconciliation

## Status

Implemented the deterministic official three-prong launcher fit coupon and reconciled it through the colored package, strict ZIP grammar, worker transfer, and E2E artifact helper.

## Implementation

- Added `launcher-fit-coupon.ts` with the five canonical offsets `[-0.10, -0.05, 0, 0.05, 0.10]`.
- Each opening applies `0.2 mm + fitOffsetMm - kerfMm / 2` once to every official template loop.
- The canonical SVG contains 15 black `CUT_BLACK` contours and five red `DEEP_RED` labels in deterministic left-to-right layout.
- The SVG root carries the fixed template version/fingerprint, selected material ID, kerf, and offset list.
- Added exact canonical revalidation for coupon metadata, geometry, roles, labels, full SVG token consumption, and EOF.
- Added `launcherCouponSvg` to the colored package and `OutlinePackageTransfer`.
- Added `launcher-fit-coupon.svg` as the fifth canonical ZIP member.
- Extended raw ZIP local/central record validation, CRC verification, UTF-8 validation, exact member order, and download/member byte identity to the coupon.
- Extended `e2e/helpers.ts` with five-member ZIP validation and an independent complete coupon grammar parser.
- Kept internal provisional launcher evidence out of the coupon, worker transfer, and all other public artifacts.

The colored package has no `project.json` or `manifest.json` member. Coupon metadata is therefore canonicalized and reconciled in the coupon SVG root; the separate legacy package manifest remains unchanged.

## TDD Evidence

RED:

```text
npx vitest run src/export/launcher-fit-coupon.test.ts src/export/outline-package.test.ts
2 test files failed: missing coupon module/payload and nine coupon/package failures.
```

GREEN:

```text
npx vitest run src/export/launcher-fit-coupon.test.ts src/export/outline-package.test.ts src/workers/geometry-api.test.ts
3 files passed; 463 tests passed.
```

The mutation matrix rejects coupon path, label, fit offset, template fingerprint, material ID, kerf, root-external content, and ZIP-only byte mutations. Existing strict raw ZIP mutation tests also remain green.

## Verification

- Focused coupon/package/worker: 463/463 passed.
- Adjacent template/document/PDF/worker partition: 121/121 passed.
- Genuine converted-package helper reconciliation: 1 passed, 52 skipped by focus.
- Build: `npm run build` passed (`tsc -b` and Vite production build).
- Full serial unit partition: 62/63 files passed; 1,426 passed, 4 failed, 1 skipped. The four failures are the explicitly deferred Task 8 fixtures that still assert a four-member ZIP. Vitest also reported one `onTaskUpdate` RPC timeout after test execution.
- Focused Chromium worker partition: 24 passed, 9 failed. Eight failures use old launcher-incompatible browser meshes assigned to Task 8; one asserts the old five-key worker payload and shows the new `launcherCouponSvg` sixth key.

No fail-closed package or ZIP checks were weakened to accommodate the deferred fixtures.

## Concerns / Follow-up

- Task 6 must expose `launcherCouponSvg` as the separate UI download and manage its Object URL.
- Task 8 must update the old four-member ZIP and launcher-incompatible browser fixtures. Those files were intentionally not rewritten in this task.
- Coupon generation currently retains the existing bounded artifact-error enum. A coupon-generation failure is reported through the prior generic colored-document/PDF stage until Task 6 adds the coupon-specific UI label.

## Independent Review Remediation

The first independent review found no Critical issue and one Important E2E-helper gap: its grammar parser accepted a format-valid forged fingerprint/kerf and did not reconstruct the official geometry or reconcile selected material evidence.

RED:

```text
npx vitest run src/test/e2e-helpers.test.ts -t 'launcher coupon|coupon material'
4 failed: forged fingerprint, kerf, geometry, and worker-material parity were accepted.
```

GREEN:

- The helper now requires the exact official template version/fingerprint.
- It independently offsets the official loops from each declared fit offset and kerf, reconstructs all five left-to-right translations, and compares every point.
- It verifies exact coupon dimensions and label positions.
- `expectReleaseAssemblyGeometry()` now reconciles coupon material ID and kerf with the bounded worker result.
- Mutation coverage includes fingerprint, kerf, path geometry, dimensions, label position, and root-external geometry.

Fresh remediation verification:

```text
E2E coupon/parity focus: 8 passed, 52 skipped by focus.
Coupon/package/worker focus: 463/463 passed.
Build: passed.
```
