import { useEffect, useState } from 'react';

export type EffectLevel = 'full' | 'energy-saving' | 'static';
export type EffectSignals = Readonly<{
  reducedMotion: boolean;
  coarsePointer: boolean;
  hardwareConcurrency: number;
  webgl: boolean;
}>;

export function resolveEffectLevel(signals: EffectSignals): EffectLevel {
  if (signals.reducedMotion || !signals.webgl) return 'static';
  if (signals.coarsePointer || signals.hardwareConcurrency < 6) return 'energy-saving';
  return 'full';
}

function browserSignals(): EffectSignals {
  return {
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    hardwareConcurrency: navigator.hardwareConcurrency || 4,
    webgl: typeof window.WebGLRenderingContext !== 'undefined',
  };
}

export function useEffectLevel(): EffectLevel {
  const [level, setLevel] = useState<EffectLevel>(() =>
    typeof window === 'undefined' ? 'static' : resolveEffectLevel(browserSignals()),
  );

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = window.matchMedia('(pointer: coarse)');
    const update = () => setLevel(resolveEffectLevel(browserSignals()));

    motion.addEventListener?.('change', update);
    pointer.addEventListener?.('change', update);
    update();

    return () => {
      motion.removeEventListener?.('change', update);
      pointer.removeEventListener?.('change', update);
    };
  }, []);

  return level;
}
