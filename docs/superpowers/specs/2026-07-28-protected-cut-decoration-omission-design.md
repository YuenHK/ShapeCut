# Protected-Cut Decoration Omission Design

**Date:** 2026-07-28
**Status:** Approved in conversation; awaiting written-spec review
**Extends:**

- `2026-07-27-official-three-prong-launcher-cut-design.md`
- `2026-07-28-launcher-exterior-expansion-design.md`

## Goal

Allow a structurally safe launcher-compatible model to continue when red and blue decoration extraction alone exceeds the protected-cut work budget. The affected layer loses only its decorative engraving; all canonical black cut geometry remains mandatory and unchanged.

## Priority

The fabrication priority remains:

1. layer exterior and required structure;
2. central hole and required black cuts;
3. fixed three-prong launcher cut;
4. fastener holes;
5. red and blue decorative engraving.

This design never relaxes or omits a higher-priority item to preserve decoration.

## Exact Downgrade Trigger

Decoration omission is permitted only when one layer's depth-feature extraction throws the exact bounded resource condition:

`Depth feature extraction exceeds the protected cut work budget`

That condition means the validated protected cut loops multiplied by the bounded raster workspace exceed the existing protected-cut work limit. It does not mean the exterior, central hole, launcher cuts, or fastener holes are invalid.

The depth-field boundary represents this condition with a dedicated
`ProtectedCutWorkBudgetError` whose stable code is
`PROTECTED_CUT_WORK_BUDGET`. The approved English text remains its internal
diagnostic message.

The following conditions remain fatal and stop every artifact:

- deadline or time-limit exhaustion;
- caller or worker cancellation;
- invalid, non-finite, collapsed, or self-intersecting geometry;
- raster dimension, surface-hit, component-memory, triangle, or other resource limits;
- invalid protected-cut topology;
- launcher incompatibility or exterior expansion above `6.00 mm`; and
- any unclassified exception.

The implementation must match `ProtectedCutWorkBudgetError` at the layer
extraction boundary. It must not use a broad `RangeError`, message equality,
message substring, or catch-all fallback.

## Per-Layer Omission

Each physical layer is processed independently.

When the exact downgrade trigger occurs for one layer, that layer receives:

- no `DEEP_RED` contours;
- no `LIGHT_BLUE` contours;
- omission code `PROTECTED_CUT_WORK_BUDGET`;
- warning `三爪孔保護運算量超出上限，已省略此層紅藍裝飾`; and
- zero retained red and blue counts.

Other layers continue normal depth-feature extraction. Their valid red and blue contours remain available.

The omission must not change:

- any layer exterior;
- any central hole;
- any launcher cut;
- any fastener hole;
- any black cut role, coordinate, ID, bounds, or area;
- the launcher template, rotation, fit offset, or exterior expansion; or
- the material profile.

## Canonical Evidence

`AutomaticOutlineAssembly` gains an ordered `decorationOmissions` array. Each member has the exact shape:

```ts
type DecorationOmission = {
  readonly layerId: string;
  readonly reason: 'protected-cut-work-budget';
  readonly roles: readonly ['DEEP_RED', 'LIGHT_BLUE'];
};
```

The array:

- contains at most one member per physical layer;
- follows physical layer order;
- contains only layer IDs present in the canonical document;
- is empty when no protected-cut work-budget omission occurred; and
- participates in the feature-evidence fingerprint.

The corresponding colored layer diagnostics use omission code `PROTECTED_CUT_WORK_BUDGET`. `featureWarnings` contains the approved Chinese warning whenever the array is non-empty. The overall automatic result status is `warning`, never `success`, when any decoration omission is present.

Strict validation independently reconciles:

- every omission record with one colored physical layer;
- an omission record with zero `DEEP_RED` and zero `LIGHT_BLUE` contours on that layer;
- the layer diagnostic omission code;
- the sanitized feature warning;
- ordering, uniqueness, reason, and roles; and
- the absence of omission evidence on unaffected layers.

## UI

The result view reports the warning and lists each affected layer ID. It also states that the official three-prong holes and black cut geometry were retained.

The UI must not describe the result as fully successful. Existing launcher-template, expansion, material, and physical-calibration information remains visible.

## Artifacts

`project.json` and `manifest.json` store the same ordered `decorationOmissions` decision.

Package verification reconciles:

- canonical assembly evidence;
- `project.json`;
- `manifest.json`;
- each affected layer's absence of red and blue contours; and
- every unaffected layer's canonical role membership.

Mutating a layer ID, reason, role, order, warning, diagnostic code, project member, manifest decision, or artifact contour causes verification failure.

SVG, DXF, preview PDF, and exploded-view PDF contain only the resulting geometry. They do not receive a human-readable omission label. The ZIP contains the canonical artifacts and metadata already required by the launcher release contract.

## Persistence and Regeneration

Raw source bytes, filenames, preview payloads, provisional decoration evidence, and central-hole source evidence remain excluded from persistence.

A stored project continues to persist its canonical launcher/template/fit/expansion decisions. After source reattachment, canonical regeneration must reproduce the same ordered `decorationOmissions` decision before downloads are enabled.

If the regenerated omission decision differs from the stored decision, the existing regeneration-required gate remains closed until the user explicitly accepts and saves the replacement canonical result.

## Concave Exterior Offset Prerequisite

The approved shared exterior expansion must support real concave Knight Fortress exteriors without using a convex hull, raster approximation, resized launcher template, or increased `6.00 mm` limit.

The launcher-only offset adapter must:

- construct an exact deterministic miter arrangement;
- resolve collapsed concave-notch loops through bounded planar face tracing;
- return exactly one validated clockwise outer contour containing the source exterior;
- discard only non-containing collapsed loops;
- preserve the `4,096`-point, deadline, cancellation, and deterministic-output limits; and
- leave the general polygon kernel behavior used by launcher cuts and physical envelopes unchanged.

The launcher planner may reject exact-exterior-unsafe candidates before computing their structural ranking score. It must preserve the selected result because sorting all candidates and then finding the first safe result is equivalent to sorting only the exact-safe subset. The sequential `0.01 mm` search, comparator order, final independent physical-safety validation, and 30-second product deadline remain unchanged.

## Verification

### Domain tests

- The exact protected-cut work-budget condition becomes `PROTECTED_CUT_WORK_BUDGET`.
- All other resource, topology, deadline, cancellation, and unknown errors propagate.
- One affected layer loses both decorative roles while unaffected layers retain them.
- Black cut geometry remains byte-equivalent before and after the decoration downgrade.
- The warning, diagnostic code, retained counts, and ordered omission evidence agree.
- Strict validation rejects every omission-evidence mutation.

### Offset and planner tests

- A collapsed V-notch resolves to one exact outer contour.
- A multi-notch arrangement with a near-zero connector resolves deterministically.
- The source exterior remains contained and unmodified.
- Exact exterior containment happens before structural scoring of unsafe candidates.
- Existing zero, asymmetric, exact `6.00 mm`, over-limit, ranking, 4,096-point, deadline, and cancellation tests remain green.

### Real-fixture tests

Both Knight Fortress STL references must:

- complete within the existing 30-second automatic-conversion deadline;
- select a shared expansion in the inclusive range `0.00 mm` through `6.00 mm`;
- contain exactly three launcher cuts on each of the top two physical layers;
- preserve all black cut geometry through any decoration omission;
- identify only the layers whose decorations were omitted; and
- produce mutually consistent preview, SVG, DXF, PDFs, ZIP, project, and manifest artifacts.

### Release checks

- Focused domain, pipeline, artifact, persistence, UI, worker, and real-fixture tests pass.
- Chromium E2E verifies the visible warning, affected layers, downloads, and artifact decisions.
- Typecheck and production build pass.
- Full-suite assertion results are reported separately from any reproducible Vitest RPC post-assertion timeout.
- `git diff --check` passes.

## Physical Acceptance

Decoration omission does not establish launcher compatibility. The calibration coupon and an official launcher must still pass insertion, repeated latch/release, rotational-play, cracking, and permanent-damage checks.

Until physical acceptance succeeds, the UI retains:

`依 Knight Fortress 樣本建立，待官方發射器實物校準`

## Acceptance Criteria

The software feature is ready for integration when:

1. only the exact protected-cut work-budget condition can omit decoration;
2. only affected layers lose red and blue contours;
3. all black cut geometry remains canonical and safe;
4. both Knight references succeed within the existing limits;
5. every public artifact and persisted decision agrees with the canonical omission evidence;
6. strict mutation tests reject missing, forged, reordered, or inconsistent evidence; and
7. no physical-compatibility claim is made before official-launcher testing.
