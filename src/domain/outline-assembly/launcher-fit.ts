export const LAUNCHER_FIT_OFFSET_MIN_MM = -0.20 as const;
export const LAUNCHER_FIT_OFFSET_MAX_MM = 0.20 as const;
export const LAUNCHER_FIT_OFFSET_STEP_MM = 0.01 as const;
export type LauncherFitOffsetMm = number;

export function validateLauncherFitOffsetMm(value: unknown): LauncherFitOffsetMm {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < LAUNCHER_FIT_OFFSET_MIN_MM - 1e-9
    || value > LAUNCHER_FIT_OFFSET_MAX_MM + 1e-9
    || Math.abs(value / LAUNCHER_FIT_OFFSET_STEP_MM
      - Math.round(value / LAUNCHER_FIT_OFFSET_STEP_MM)) > 1e-9) {
    throw new RangeError('Launcher fit offset must be -0.20 mm to +0.20 mm in 0.01 mm steps');
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}
