# Task 6 report

## Status

Implemented the material-and-fit UI, canonical launcher status, reset behavior, separate launcher coupon download, and fail-closed URL ownership.

## Scope

- Added the controlled `三爪配合微調` number input before material selection.
- Validates `-0.20` to `+0.20` mm in exact `0.01` mm steps with immediate inline feedback.
- Blocks material-triggered conversion for invalid, non-finite, non-step, empty, and pasted-text input.
- Passes the validated offset as the third `OneClickConverterServices.convert` argument and through the production geometry client request.
- Resets fit input and the controlled material picker for replacement models and workflow reset.
- Renders launcher template, signed fit offset, top-two-layer status, and red/blue clipped/removed counts only from `result.assembly`.
- Shows the Knight Fortress physical-calibration caveat.
- Creates and exposes a separate `launcher-fit-coupon.svg` Object URL and `下載三爪尺寸測試片` link.
- Includes the coupon URL in replacement, service-swap, late-package, unmount, and partial-creation cleanup.
- Preserves fail-closed behavior for `LAUNCHER_INCOMPATIBLE` and coupon artifact preparation failures.
- Keeps the fit control inside the existing material card, without new animation or input locking; preserves existing reduced-motion, transparency, and contrast behavior.

## TDD evidence

- RED component: 10 expected failures from the missing fit input, four-argument service contract, canonical status rows, and coupon link.
- RED Chromium workbench: the new mobile/accessibility test failed because `三爪配合微調` did not exist.
- RED download URL: two App tests failed because no standalone coupon URL was created and coupon URL failure was not attributable.
- RED ZIP copy: the technical-details test rejected the obsolete four-file ZIP description.
- GREEN focused component/App: 64/64 passed.
- GREEN exact Chromium workbench: 9/9 passed.

## Verification

- `npx vitest run src/app/OneClickConverter.test.tsx src/app/App.test.tsx`: 64/64 passed.
- `npx vitest --config vitest.browser.config.ts run src/app/apple-workbench.browser.test.tsx`: 9/9 passed.
- Compatible browser regressions: App and OutlineProcessViewport 25/25 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed, 163 modules transformed.
- `git diff --check`: passed.

## Wider-suite observation

The full unit run reached 1,435 passed and 1 skipped, with eight failures:

- Four pre-existing `src/test/e2e-helpers.test.ts` assertions still require the old four-record ZIP. Task 5 now produces the canonical fifth `launcher-fit-coupon.svg`; the Task 6 brief assigns these incompatible acceptance fixtures to Task 8.
- Four launcher/pipeline/package tests exceeded the shared 5-second timeout under parallel CPU load. Each exact failed test passed when rerun alone with `--maxWorkers=1 --fileParallelism=false`.

No production code or old acceptance fixtures were changed to hide those out-of-scope failures.

## Review

Independent Task 6 review found no Critical, Important, or Minor issues. It confirmed that the App/viewport test changes are necessary service-contract updates and that URL cleanup, error attribution, fail-closed behavior, fit validation/reset, assembly-only status, and mobile accessibility match the brief.

## Remaining concerns

- The wider unit matrix cannot be fully green until Task 8 updates the old exact-four ZIP acceptance fixtures.
- Physical fit remains subject to the displayed Knight Fortress caveat and official-launcher calibration.

## Reviewer follow-up: raw decimal validation

The reviewer identified an Important coercion gap: `Number()` converted raw strings before validation, so `1e-9999` underflowed to `0` and `0.1000000000000000001` rounded to `0.1`.

- Added a full-string decimal grammar check before number conversion.
- The accepted syntax has an optional sign, a zero integer part or omitted zero, and at most two fractional digits; the existing domain validator remains authoritative for the `-0.20` to `+0.20` range and `0.01` step.
- Exponents, whitespace, leading-zero coercions, non-finite text, empty input, and over-precision decimals now fail without rounding or underflow.
- Added component coverage for the reported coercion cases, the retained `0.205` step case, and valid zero/boundary/decimal forms.
- Added a real Chromium flow that uses the browser clipboard and paste action for `1e-9999`, keyboard typing for `0.1000000000000000001`, and verifies the accessible error plus no conversion call.
- Limited clipboard read/write permission to the headless Playwright test context so the paste test uses the native browser path.
- Removed only failure screenshots generated during RED/debug runs; no visual baseline or other asset is included.

Follow-up verification:

- `npx vitest run src/app/OneClickConverter.test.tsx`: 61/61 passed.
- `npx vitest --config vitest.browser.config.ts run src/app/apple-workbench.browser.test.tsx`: 10/10 passed.
- `npm run build`: passed, including TypeScript project build and 163 transformed modules.
- `git diff --check`: passed.
