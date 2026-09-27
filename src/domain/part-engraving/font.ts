import { parse, type Font } from 'opentype.js';
import type { Point2 } from '../decomposition/types';
import { EngravingError } from './settings';
import fontUrl from './assets/NotoSansCJKtc-Regular.otf?url';
import licenseUrl from './assets/OFL.txt?url';

export const ENGRAVING_FONT_ID = 'NotoSansCJKtc-Regular-2.004';
export const ENGRAVING_FONT_SHA256 = 'dce08bd4fd91aa8aa76ed8fea4b694c2dfb8550f67871e326843212ddbeb88b4';
export const ENGRAVING_EM_MM = 3;
export const ENGRAVING_FONT_LICENSE_URL = licenseUrl;
export type EngravingGlyph = { readonly character: string; readonly advance: number; readonly loops: readonly (readonly Point2[])[] };
let cachedFont: Promise<Font> | undefined;
export function parseEngravingFont(bytes: ArrayBuffer): Font {
  try {
    const font = parse(bytes);
    if (font.unitsPerEm !== 1000 || font.numGlyphs < 60000) throw new Error();
    return font;
  } catch { throw new EngravingError('刻字字型無法載入或資料損壞；請重新載入後再試'); }
}
const FONT_LOAD_TIMEOUT_MS = 15_000;
function boundedFontWait(pending: Promise<Font>, timeoutMs: number, abort?: () => void): Promise<Font> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort?.();
      reject(new EngravingError('刻字字型載入逾時；請重新載入後再試'));
    }, timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
export function loadEngravingFont(remainingMs = FONT_LOAD_TIMEOUT_MS): Promise<Font> {
  if (!(remainingMs > 0)) return Promise.reject(new EngravingError('刻字字型載入逾時；請重新載入後再試'));
  if (!cachedFont) {
    const controller = new AbortController();
    // Static same-origin URL. Timeout covers headers, body, digest and parsing, not just fetch.
    const pending = (async () => {
      const response = await fetch(fontUrl, { signal: controller.signal });
      if (!response.ok || controller.signal.aborted) throw new Error();
      const bytes = await response.arrayBuffer();
      if (controller.signal.aborted) throw new Error();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== ENGRAVING_FONT_SHA256 || controller.signal.aborted) throw new Error();
      return parseEngravingFont(bytes);
    })();
    cachedFont = boundedFontWait(pending, FONT_LOAD_TIMEOUT_MS, () => controller.abort()).catch(error => {
      cachedFont = undefined;
      if (error instanceof EngravingError) throw error;
      throw new EngravingError('刻字字型無法載入或資料損壞；請重新載入後再試');
    });
  }
  // A shorter caller budget must also bound an already-pending cached request, but must not
  // cancel or clear a shared request still needed by another caller with a longer budget.
  return remainingMs < FONT_LOAD_TIMEOUT_MS ? boundedFontWait(cachedFont, remainingMs) : cachedFont;
}

/** Flatten curves at a fixed bounded resolution; these exact polylines are the exported geometry. */
export function glyphOutlines(font: Font, text: string): EngravingGlyph[] {
  if ([...text].length > 56) throw new EngravingError('刻字超出處理上限；請縮短文字');
  let totalPoints = 0;
  return [...text].map(character => {
    const glyph = font.charToGlyph(character);
    if (!glyph.index) throw new EngravingError('刻字字型缺字；請改用支援的中文、英文或數字');
    const loops: Point2[][] = [];
    let current: Point2[] = [], previous: Point2 = [0, 0];
    const append = (point: Point2) => {
      if (!point.every(Number.isFinite) || ++totalPoints > 40000) throw new EngravingError('刻字輪廓超出處理上限；請縮短文字');
      current.push(point); previous = point;
    };
    const close = () => {
      if (current.length > 1 && current[0][0] === current.at(-1)![0] && current[0][1] === current.at(-1)![1]) current.pop();
      if (current.length >= 3) loops.push(current);
      current = [];
    };
    // opentype's getPath uses screen y-down; reflect to canonical millimetre y-up.
    for (const command of glyph.getPath(0, 0, ENGRAVING_EM_MM).commands) {
      if (command.type === 'M') { close(); append([command.x, -command.y]); }
      else if (command.type === 'L') append([command.x, -command.y]);
      else if (command.type === 'Z') close();
      else if (command.type === 'Q' || command.type === 'C') {
        const start = previous;
        for (let step = 1; step <= 12; step++) {
          const t = step / 12, u = 1 - t;
          if (command.type === 'Q') append([
            u*u*start[0] + 2*u*t*command.x1 + t*t*command.x,
            u*u*start[1] - 2*u*t*command.y1 - t*t*command.y,
          ]);
          else append([
            u*u*u*start[0] + 3*u*u*t*command.x1 + 3*u*t*t*command.x2 + t*t*t*command.x,
            u*u*u*start[1] - 3*u*u*t*command.y1 - 3*u*t*t*command.y2 - t*t*t*command.y,
          ]);
        }
      }
    }
    close();
    if (character !== ' ' && !loops.length) throw new EngravingError('刻字字型缺字或沒有可用輪廓');
    return { character, advance: (glyph.advanceWidth ?? 1000) * ENGRAVING_EM_MM / font.unitsPerEm, loops };
  });
}
