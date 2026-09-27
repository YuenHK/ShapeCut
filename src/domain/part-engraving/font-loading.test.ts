import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(()=>{ vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('local font loading',()=>{
  it.each(['headers','body'])('bounds stalled %s even if fetch ignores abort, then permits retry',async phase=>{
    vi.resetModules(); vi.useFakeTimers();
    const {loadEngravingFont}=await import('./font');
    const fetcher=vi.fn(async(_url: unknown, _init?: RequestInit)=>phase==='headers' ? new Promise<Response>(()=>{}) : {ok:true,arrayBuffer:()=>new Promise<ArrayBuffer>(()=>{})});
    vi.stubGlobal('fetch',fetcher);
    let failure: unknown;
    void loadEngravingFont().catch(error=>{failure=error;});
    await vi.advanceTimersByTimeAsync(16000);
    expect(failure).toMatchObject({name:'EngravingError'});
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    fetcher.mockImplementation(async()=>{throw new Error('retry');});
    await expect(loadEngravingFont()).rejects.toThrow(/字型/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('applies a caller deadline to a cached pending font without poisoning another caller',async()=>{
    vi.resetModules(); vi.useFakeTimers();
    const {loadEngravingFont}=await import('./font');
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(()=>{})));
    let longFailure: unknown,shortFailure:unknown;
    void loadEngravingFont().catch(error=>{longFailure=error;});
    void loadEngravingFont(20).catch(error=>{shortFailure=error;});
    await vi.advanceTimersByTimeAsync(21);
    expect(shortFailure).toMatchObject({name:'EngravingError'});
    expect(longFailure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(16000);
    expect(longFailure).toMatchObject({name:'EngravingError'});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports download failure without logging text and can retry',async()=>{
    vi.resetModules();
    const {loadEngravingFont}=await import('./font');
    const bytes=readFileSync('src/domain/part-engraving/assets/NotoSansCJKtc-Regular.otf');
    const fetcher=vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch',fetcher);
    await expect(loadEngravingFont()).rejects.toThrow(/字型/);
    await expect(loadEngravingFont()).resolves.toMatchObject({unitsPerEm:1000});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url])=>typeof url==='string' && !url.includes('?'))).toBe(true);
  });
  it('rejects a corrupted asset before parsing',async()=>{
    vi.resetModules();
    const {loadEngravingFont}=await import('./font');
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array(100))));
    await expect(loadEngravingFont()).rejects.toThrow(/字型/);
  });
});
