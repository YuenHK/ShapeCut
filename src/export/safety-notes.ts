import { FASTENER_OMISSION_WARNING } from '../domain/outline-assembly/fasteners';
import { LAUNCHER_OMISSION_WARNING } from '../domain/outline-assembly/launcher';
import { CENTRAL_HOLE_OMISSION_WARNING } from '../domain/outline-features/hole';

export const PUBLIC_LAUNCHER_OMISSION_NOTE =
  'Launcher clearance omitted because compatibility could not be preserved safely.';
export const PUBLIC_FASTENER_OMISSION_NOTE =
  '3 mm fastener holes omitted because no all-layer pattern was safe.';

export type SafetyOmissions = {
  readonly centralHole: boolean;
  readonly launcher: boolean;
  readonly fastener: boolean;
};

/** Canonical public order shared by PDF generation and the independent artifact oracle. */
export function publicSafetyNotes(omissions: SafetyOmissions): readonly string[] {
  return [
    ...(omissions.centralHole ? [CENTRAL_HOLE_OMISSION_WARNING] : []),
    ...(omissions.launcher ? [PUBLIC_LAUNCHER_OMISSION_NOTE] : []),
    ...(omissions.fastener ? [PUBLIC_FASTENER_OMISSION_NOTE] : []),
  ];
}

export function publicSafetyNotesFromWarnings(warnings: readonly string[]): readonly string[] {
  return publicSafetyNotes({
    centralHole: warnings.includes(CENTRAL_HOLE_OMISSION_WARNING),
    launcher: warnings.includes(LAUNCHER_OMISSION_WARNING),
    fastener: warnings.includes(FASTENER_OMISSION_WARNING),
  });
}
