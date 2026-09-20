import { afterEach, describe, expect, it, vi } from 'vitest';
import * as transfer from './bayblad-transfer';

const token = '12345678-1234-4234-8234-123456789abc';
const hash = `#bayblad-transfer=${token}`;
function bytes() {
  const result = new ArrayBuffer(134);
  new DataView(result).setUint32(80, 1, true);
  return result;
}
afterEach(() => vi.useRealTimers());
describe('Bayblad receiver', () => {
  it('only recognizes a UUID handoff with an opener', () => {
    expect(transfer.getBaybladTransfer(hash, window)).toEqual({ token, opener: window });
    expect(transfer.getBaybladTransfer('', window)).toBeUndefined();
    expect(transfer.getBaybladTransfer(hash, null)).toBeUndefined();
    expect(transfer.getBaybladTransfer('#bayblad-transfer=bad', window)).toBeUndefined();
  });
  it('retries ready, ignores spoofed messages and accepts only after import succeeds', async () => {
    vi.useFakeTimers();
    const opener = { postMessage: vi.fn() } as unknown as Window;
    let resolve!: (result: boolean) => void;
    const onFile = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const onError = vi.fn();
    const dispose = transfer.startBaybladReceiver({ token, opener }, onFile, onError);
    const payload = { protocol: 'bayblad-shapecut', version: 1, token, type: 'stl', fileName: 'bayblad-3layers-6mm-mm.stl', bytes: bytes() };
    const send = (data = payload, origin = location.origin, source = opener) => window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    vi.advanceTimersByTime(500);
    expect(opener.postMessage).toHaveBeenCalledTimes(2);
    send(payload, 'https://evil.example');
    send(payload, location.origin, window);
    send({ ...payload, token: 'wrong' });
    send({ ...payload, version: 2 });
    expect(onFile).not.toHaveBeenCalled();
    send(); send();
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(opener.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'accepted' }), location.origin);
    resolve(true);
    await vi.runAllTimersAsync();
    expect(opener.postMessage).toHaveBeenLastCalledWith({ protocol: 'bayblad-shapecut', version: 1, token, type: 'accepted' }, location.origin);
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });
  it.each(['filename', 'short', 'oversize', 'count', 'zero', 'nonfinite'])('rejects invalid %s payload', async (kind) => {
    const opener = { postMessage: vi.fn() } as unknown as Window;
    const onFile = vi.fn();
    const onError = vi.fn();
    const dispose = transfer.startBaybladReceiver({ token, opener }, onFile, onError);
    const buffer = kind === 'short' ? new ArrayBuffer(83) : kind === 'oversize' ? new ArrayBuffer(20 * 1024 * 1024 + 1) : bytes();
    if (kind === 'count') new DataView(buffer).setUint32(80, 2, true);
    if (kind === 'zero') new DataView(buffer).setUint32(80, 0, true);
    if (kind === 'nonfinite') new DataView(buffer).setFloat32(96, NaN, true);
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: opener, data: {
      protocol: 'bayblad-shapecut', version: 1, token, type: 'stl', bytes: buffer,
      fileName: kind === 'filename' ? 'evil.stl' : 'bayblad-3layers-6mm-mm.stl',
    } }));
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(opener.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }), location.origin);
    dispose();
  });
  it('times out and cleans up on unmount including a pending import', async () => {
    vi.useFakeTimers();
    const opener = { postMessage: vi.fn() } as unknown as Window;
    const onError = vi.fn();
    const dispose = transfer.startBaybladReceiver({ token, opener }, vi.fn(), onError);
    vi.advanceTimersByTime(90_000);
    expect(onError).toHaveBeenCalledOnce();
    const calls = vi.mocked(opener.postMessage).mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(opener.postMessage).toHaveBeenCalledTimes(calls);
    dispose();
    const onFile = vi.fn().mockResolvedValue(true);
    const cleanup = transfer.startBaybladReceiver({ token, opener }, onFile, onError);
    cleanup();
    window.dispatchEvent(new MessageEvent('message', { source: opener, origin: location.origin, data: { protocol: 'bayblad-shapecut', version: 1, token, type: 'stl', bytes: bytes(), fileName: 'bayblad-3layers-6mm-mm.stl' } }));
    expect(onFile).not.toHaveBeenCalled();
  });
  it.each(['false', 'reject', 'unmount'])('does not acknowledge a failed or cancelled import: %s', async (mode) => {
    const opener = { postMessage: vi.fn() } as unknown as Window;
    let resolve!: (accepted: boolean) => void;
    let reject!: (reason: Error) => void;
    const onError = vi.fn();
    const dispose = transfer.startBaybladReceiver({ token, opener }, () => new Promise<boolean>((ok, fail) => { resolve = ok; reject = fail; }), onError);
    window.dispatchEvent(new MessageEvent('message', { source: opener, origin: location.origin, data: { protocol: 'bayblad-shapecut', version: 1, token, type: 'stl', bytes: bytes(), fileName: 'bayblad-3layers-6mm-mm.stl' } }));
    if (mode === 'unmount') dispose();
    if (mode === 'reject') reject(new Error('read failed')); else resolve(mode === 'unmount');
    await Promise.resolve(); await Promise.resolve();
    expect(opener.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'accepted' }), location.origin);
    expect(onError).toHaveBeenCalledTimes(mode === 'unmount' ? 0 : 1);
    dispose();
  });
});
