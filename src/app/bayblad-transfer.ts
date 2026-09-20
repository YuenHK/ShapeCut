import { parseSTL } from '../domain/mesh/parse-stl';

export type BaybladTransfer = { readonly token: string; readonly opener: Window };
const MAX_BYTES = 20 * 1024 * 1024;
const FILE_NAME = 'bayblad-3layers-6mm-mm.stl';
export const TRANSFER_FALLBACK = '模型傳送失敗或已過期。請返回陀螺模擬器重新傳送，或下載 STL 後在此手動上載。';

export function getBaybladTransfer(hash: string, opener: Window | null): BaybladTransfer | undefined {
  const match = /^#bayblad-transfer=([\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})$/iu.exec(hash);
  return match && opener ? { token: match[1], opener } : undefined;
}

export function startBaybladReceiver(
  transfer: BaybladTransfer,
  onFile: (file: File) => Promise<boolean>,
  onError: (message: string) => void,
): () => void {
  const origin = window.location.origin;
  let active = true;
  let consumed = false;
  const send = (type: 'ready' | 'accepted' | 'error') => {
    try {
      transfer.opener.postMessage({ protocol: 'bayblad-shapecut', version: 1, token: transfer.token, type }, origin);
    } catch { /* The local fallback remains usable if the opener has gone away. */ }
  };
  const stop = () => {
    active = false;
    window.clearInterval(retry);
    window.clearTimeout(timeout);
    window.removeEventListener('message', receive);
  };
  const fail = () => {
    if (!active) return;
    send('error');
    stop();
    onError(TRANSFER_FALLBACK);
  };
  const receive = (event: MessageEvent) => {
    if (!active || consumed || event.origin !== origin || event.source !== transfer.opener) return;
    const data: unknown = event.data;
    if (!data || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.protocol !== 'bayblad-shapecut' || message.version !== 1 || message.token !== transfer.token) return;
    if (message.type === 'error') { fail(); return; }
    if (message.type !== 'stl') return;
    consumed = true;
    window.clearInterval(retry);
    try {
      const bytes = message.bytes;
      if (message.fileName !== FILE_NAME || !(bytes instanceof ArrayBuffer)
        || bytes.byteLength < 84 || bytes.byteLength > MAX_BYTES) throw new Error('Invalid payload');
      const count = new DataView(bytes).getUint32(80, true);
      if (!count || bytes.byteLength !== 84 + count * 50) throw new Error('Invalid STL length');
      parseSTL(bytes, { maxBytes: MAX_BYTES, maxTriangles: 500_000, maxUniqueVertices: 300_000 });
      void onFile(new File([bytes], FILE_NAME, { type: 'model/stl' })).then((accepted) => {
        if (!active) return;
        if (!accepted) { fail(); return; }
        send('accepted');
        stop();
      }).catch(fail);
    } catch { fail(); }
  };
  const retry = window.setInterval(() => send('ready'), 500);
  const timeout = window.setTimeout(fail, 90_000);
  window.addEventListener('message', receive);
  send('ready');
  return stop;
}
