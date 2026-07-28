import type { Point2 } from '../decomposition/types';
import { validatePolygon } from '../engraving/geometry';
import { simpleMiterPolygonKernel } from '../layout/polygon-kernel';
import type { FeatureContour } from '../outline-features/types';
import { contourBounds, signedArea } from '../outline-2.5d/simplify';

export const LAUNCHER_EXTERIOR_EXPANSION_MODE = 'shared-uniform' as const;
export const LAUNCHER_EXTERIOR_EXPANSION_STEP_MM = 0.01 as const;
export const LAUNCHER_EXTERIOR_EXPANSION_MAX_MM = 6 as const;

export type LauncherExteriorExpansion = {
  readonly mode: 'shared-uniform';
  readonly offsetMm: number;
  readonly maxOffsetMm: 6;
  readonly affectedLayerIds: readonly [string, string];
};

export class LauncherExteriorExpansionExceededError extends RangeError {
  readonly name = 'LauncherExteriorExpansionExceededError';
  readonly code = 'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED';

  constructor(readonly requiredOffsetMm: number) {
    super(
      `Launcher exterior expansion requires ${requiredOffsetMm.toFixed(2)} mm, exceeding 6.00 mm`,
    );
  }
}

export function normalizeLauncherExteriorExpansionMm(requiredMm: number): number {
  if (!Number.isFinite(requiredMm) || requiredMm < 0) {
    throw new RangeError('Launcher exterior expansion must be finite and non-negative');
  }
  const hundredths = Math.ceil((requiredMm - 1e-12) * 100);
  if (hundredths > LAUNCHER_EXTERIOR_EXPANSION_MAX_MM * 100) {
    throw new LauncherExteriorExpansionExceededError(hundredths / 100);
  }
  return hundredths === 0 ? 0 : hundredths / 100;
}

function checkExpansionRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) {
    throw new RangeError('Launcher exterior expansion exceeded the runtime budget');
  }
}

function clockwiseCopy(
  points: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): readonly Point2[] {
  const reverse = signedArea(points, deadline, checkpoint) > 0;
  const copied: Point2[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 63) === 0) checkExpansionRuntime(deadline, checkpoint);
    const source = points[reverse ? points.length - 1 - index : index];
    copied.push([source[0], source[1]]);
  }
  return copied;
}

export function expandLauncherExterior(
  exterior: FeatureContour,
  offsetMm: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): FeatureContour {
  const normalizedOffsetMm = normalizeLauncherExteriorExpansionMm(offsetMm);
  const kernelCheckpoint = (): void => checkExpansionRuntime(deadline, checkpoint);
  checkExpansionRuntime(deadline, checkpoint);
  if (!validatePolygon({ points: exterior.outer }, kernelCheckpoint)) {
    throw new RangeError('Launcher exterior expansion requires one valid simple polygon');
  }
  const expanded = simpleMiterPolygonKernel.offset(
    { points: exterior.outer },
    normalizedOffsetMm,
    kernelCheckpoint,
  );
  if (expanded.length !== 1 || !validatePolygon(expanded[0], kernelCheckpoint)) {
    throw new RangeError('Launcher exterior expansion must remain one valid simple polygon');
  }
  const outer = clockwiseCopy(expanded[0].points, deadline, checkpoint);
  return {
    id: exterior.id,
    role: exterior.role,
    outer,
    boundsMm: contourBounds(outer, deadline, checkpoint),
    areaMm2: Math.abs(signedArea(outer, deadline, checkpoint)),
  };
}
