import { afterEach, expect, it, vi } from 'vitest';
import { createOutlinePackage, verifyOutlinePackage, type ColoredOutlinePackage } from './outline-package';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';

afterEach(()=>vi.unstubAllGlobals());
it('rejects expired creation and verification before requesting a font',async()=>{
  const fetcher=vi.fn(async()=>new Response(new Uint8Array(0)));
  vi.stubGlobal('fetch',fetcher);
  const result={} as AutomaticOutlineResult,options={engraving:{name:'A',workName:''}};
  await expect(createOutlinePackage(result,0,options)).rejects.toThrow(/deadline|budget/i);
  await expect(verifyOutlinePackage({} as ColoredOutlinePackage,result,0,options)).rejects.toThrow(/deadline|budget/i);
  expect(fetcher).not.toHaveBeenCalled();
});
