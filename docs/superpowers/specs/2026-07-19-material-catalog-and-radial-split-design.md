# Material Catalog and Radial Split Final-Fix Design

Date: 2026-07-19

## Scope

This design closes final re-review findings R1 and R2 without weakening the existing material or package safety gates.

## R1: repository-backed material workflow

The production `App` owns one `MaterialDatabase` shared by `ProjectRepository` and `MaterialRepository`. `createAppServices` uses the material repository to list, validate, persist, and reload stored `MaterialProfileV1` records. The four built-in profiles remain read-only pending examples; they are never promoted to ready by the UI.

`WizardServices` exposes material catalog operations rather than passing IndexedDB objects into presentation components. The engraving step displays both pending built-ins and stored profiles with their computed readiness. A JSON editor supports two paths:

- paste a complete V1 JSON document, validate it with `MaterialProfileSchema`, and save it;
- load a selected stored profile into the editor, change its calibration/evidence fields, revalidate the complete document, and overwrite that same stored ID.

Built-in IDs are reserved so a stored record cannot shadow a pending default. JSON parse failures, schema failures, forbidden or incomplete identity, missing physical coupon evidence, and missing qualified-operator approval remain visible and cannot enable production export. Saving a structurally valid but non-ready profile is allowed so calibration can be completed later; readiness remains `confirm` or `block` until all evidence is present.

Artifact creation reloads the selected material by ID from the repository immediately before running the manufacturing pipeline. Package construction continues to revalidate the embedded material profile and readiness at its own boundary.

## R2: radial split-position meaning

`splitPositionPercent` is the radial boundary between the central hub and the rib/outer-ring region:

```text
hubRadius = maximumProfileRadius * splitPositionPercent / 100
```

The domain and pipeline accept only finite values from 10 through 90 inclusive. The value is passed through the worker decomposition request and directly changes hub, rib, joint, and downstream CUT geometry. Existing geometry safety checks remain authoritative: a requested boundary that cannot preserve the shaft, notch, web, annulus, or collision margins fails closed with a typed decomposition error.

## Data flow

1. The App opens one database and constructs both repositories.
2. The Wizard lists read-only pending defaults plus validated stored profiles.
3. JSON input is parsed, schema-validated, stored, reloaded, and selected.
4. The selected material ID and split percentage are captured in the versioned artifact request.
5. Artifact creation reloads the selected profile, calculates the radial hub boundary, and runs the real worker pipeline.
6. Package creation independently revalidates readiness and document provenance before returning ZIP bytes.

## Error handling and safety

- Invalid JSON produces a controlled parse error and no database write.
- Invalid V1 records produce path-aware schema errors and no database write.
- Pending profiles remain selectable for planning but fail preflight and cannot export.
- Stored profiles are never trusted from UI state alone; repository reads decode and validate them.
- A material ID missing from both stored and built-in catalogs fails artifact creation.
- Split values outside 10–90 or unsafe derived geometry fail before manufacturing output.

## Verification

- Unit tests prove catalog validation, reserved built-in IDs, stored-profile reload, and missing-evidence readiness.
- Wizard/component tests prove catalog listing, JSON error messages, edit/save/select behavior, and pending blocking.
- A real Chromium App test imports and saves a signed `TEST ONLY` ready profile, selects it, runs a real STL through workers, downloads the ZIP, and reopens the ZIP to validate its settings, material/preflight evidence, and manufacturing payloads.
- Domain tests compare actual hub and rib coordinates at materially different split percentages.
- Pipeline integration tests compare downstream CUT polygons and extents, not only hashes or provenance.
- Final verification runs typecheck, build, unit/integration, Chromium browser, E2E, and fixture validation suites.
