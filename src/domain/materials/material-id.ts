export const SAFE_PUBLIC_MATERIAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export function isSafePublicMaterialId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_PUBLIC_MATERIAL_ID.test(value);
}
