# Task 4: Carry Fit Evidence Across the Worker Boundary

## Implementation

- Made `AutomaticOutlineRequest.launcherFitOffsetMm` required.
- Client validates and normalizes the fit value before transfer/remote dispatch; `-0` becomes `0` only in the cloned request.
- Worker explicitly reconstructs and validates the request before pipeline work, preserving the existing internal-result cache and public-evidence stripping behavior.
- Pipeline also validates the field for direct callers. The app supplies the existing zero-offset default.
- Updated typed test fixtures to satisfy the now-required request contract.

## TDD evidence

- RED: `npx vitest run src/workers/geometry-api.test.ts --maxWorkers=1 --fileParallelism=false` failed 6 assertions: five invalid values were dispatched and `-0` was not normalized.
- GREEN: the same command passed `27/27` after boundary validation was added.

## Verification

- `npm run build` passed (`tsc -b && vite build`).
- Focused geometry API test passed: `27/27`.
- Full serial attempt: `npm test -- --maxWorkers=1 --fileParallelism=false` exited `0` but emitted only `src/export/outline-package.test.ts` (`423`) and `src/domain/outline-assembly/launcher.test.ts` (`41`), with no suite summary.
- Partitioned follow-up: explicit list of the remaining `66` non-browser test files with the same serial options exited `0` but emitted only four files: `extract` (`41`), `launcher-runtime-validation` (`7`), `types` (`71`), and `validate-fixtures-release` (`5`, `1 skipped`), also without a suite summary. This is the known post-completion Vitest RPC issue, so these commands are recorded as partial coverage rather than a full-suite pass.

## Concern

Browser-only worker tests are excluded by the default Vitest configuration; build type-checks their updated request fixture, but no browser run was included in this Task 4 verification.
