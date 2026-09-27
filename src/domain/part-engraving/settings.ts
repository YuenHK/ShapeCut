export type EngravingSettings = { readonly name: string; readonly workName: string };
export class EngravingError extends Error { constructor(message: string) { super(message); this.name = 'EngravingError'; } }
export function normalizeEngravingSettings(input?: unknown): EngravingSettings {
  if (input === undefined) return { name: '', workName: '' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EngravingError('刻字設定格式不正確');
  const value = input as Record<string, unknown>;
  const field = (key: string): string => {
    const text = value[key];
    if (typeof text !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)) throw new EngravingError('刻字欄位不可包含控制字元或無效文字');
    const normalized = text.trim().replace(/\s+/gu, ' ');
    if ([...normalized].length > 24) throw new EngravingError('每個刻字欄位最多 24 個字元；請縮短文字');
    return normalized;
  };
  return { name: field('name'), workName: field('workName') };
}
export function hasEngravingText(settings: EngravingSettings): boolean { return Boolean(settings.name || settings.workName); }
export function validateEngravingSettings(input?: unknown): string | undefined {
  try { normalizeEngravingSettings(input); return undefined; }
  catch (error) { return error instanceof EngravingError ? error.message : '刻字設定格式不正確'; }
}
