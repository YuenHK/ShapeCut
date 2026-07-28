# Task 4: Knight and Release Verification

## Status

Implementation verification is complete and final independent review is clean. The scoped geometry and release assertions pass. Physical compatibility remains explicitly unverified.

## Knight acceptance

Both private reference STLs completed within the 30-second conversion deadline:

| Reference | Conversion | Expansion | Rotation | Omitted layers | Black snapshot |
|---|---:|---:|---:|---|---:|
| A | 28,068.937 ms | 5.72 mm | 1.413716694115 rad | `outline-layer-4`, `outline-layer-5` | 150,324 bytes |
| B | 29,297.224 ms | 5.70 mm | 1.413716694115 rad | `outline-layer-4`, `outline-layer-5` | 148,074 bytes |

For both references, the top two layers retain all three official launcher cuts; the expansion is positive and at most 6.00 mm; every omission maps to a layer with no red or blue contours; preview/package generation preserves the snapshotted black geometry; and independent package verification passes.

## Release boundary and artifact verification

- Public worker transfers retain the canonical `assembly.decorationOmissions` decision while excluding `centralHoleSourceEvidence`, `decorationOmissionSourceEvidence`, and `internalValidationEvidence`.
- The worker reconstructs the three private evidence records only from its bounded internal cache when packaging.
- SVG, DXF, preview PDF, exploded PDF, project, manifest, standalone coupon, and the seven-member ZIP are parsed and reconciled. Project/manifest expansion and omission decisions must agree with the physical layers, and omitted layers must have no red or blue members.
- Mutation tests cover role, identity, ordering, geometry, PDF, JSON, manifest hash, ZIP record, and byte-identity drift.
- The earlier PDF review Minor was closed by positive visible-text anchors for `Scale 1:1 | BLACK CUT | RED DEEP | BLUE LIGHT` and `Central axis` before negative-label checks.
- Full Chromium exposed a stale synthetic cancellation result that failed new source-evidence validation before the PDF checkpoint. The fixture now reconstructs exact source exteriors, deterministic top-two expansion, and all 24 central-hole source records; the replacement/cancellation regression passes.

## Final-review fix wave

- Protected-cut topology is validated before work-budget classification, so a self-intersecting protected cut cannot be downgraded to a typed omission solely because the request is also over budget.
- The browser verifier now strictly parses and reconciles all canonical project/manifest material, launcher, fastener, top-feature, omission, privacy, member, and hash decisions. Mutation tests cover previously ignored synchronized metadata forgeries and private-note injection.
- JSON privacy scanning rejects every `.stl` token as well as POSIX, Windows, backslash-UNC, and forward-UNC paths; fresh-hash mutations cover both `private model (copy).stl` and a forward-UNC path.
- Omission order is checked against physical layer order rather than lexicographic layer IDs; the regression uses `layer-2` before `layer-10`.
- The UI and browser expectations now describe all seven ZIP members.
- The four trailing spaces in the two 2026-07-28 spec headers were removed; both working-tree and complete branch-range whitespace checks pass.

## Verification matrix

- Focused Knight test: 3/3 passed.
- Focused release matrix: 3 files / 20 tests passed.
- Real Chromium worker: 34/34 passed.
- Happy-path Chromium: 7/7 passed.
- Fixture/parser regressions: 4 files / 126 tests passed.
- Replacement/cancellation Chromium regression: 1/1 passed.
- Final-review core matrix: 3 files / 162 tests passed.
- Final-review covering matrix: 6/6 files and 774/774 assertions passed, followed by the known unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` RPC error; process exit was nonzero, so this command is not called passed.
- Repository serial Vitest: 65/65 files and 1,655/1,655 assertions passed, followed by one unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` RPC error; process exit was nonzero, so this command is not called passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Working-tree `git diff --check`: passed.
- Complete-range `git diff --check 3dc11a0`: passed.
- A supplemental sequential rerun passed the seven happy-path Chromium cases, then private model A timed out before release assertions because the material selector remained disabled; model B was interrupted when the extra rerun was stopped. The earlier focused Knight acceptance and real-worker browser evidence above remain the scoped release evidence.

## Outstanding physical gate

`physical coupon + official launcher latch/release/play/damage test: outstanding`

No physical compatibility or merge claim is made.
