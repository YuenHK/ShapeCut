import { useEffect, useRef, useState } from 'react';

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

const EFFECT_LEVEL_PRIORITY: Readonly<Record<EffectLevel, number>> = Object.freeze({
  static: 0,
  'energy-saving': 1,
  full: 2,
});

function mayApplyLevel(current: EffectLevel, next: EffectLevel, holdAutomaticUpgrades: boolean): boolean {
  return !holdAutomaticUpgrades || EFFECT_LEVEL_PRIORITY[next] <= EFFECT_LEVEL_PRIORITY[current];
}

export function useEffectLevel(holdAutomaticUpgrades = false): EffectLevel {
  const initialLevel = typeof window === 'undefined' ? 'static' : resolveEffectLevel(browserSignals());
  const [level, setLevel] = useState<EffectLevel>(initialLevel);
  const heldRef = useRef(holdAutomaticUpgrades);
  heldRef.current = holdAutomaticUpgrades;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      setLevel('static');
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = window.matchMedia('(pointer: coarse)');
    const update = () => {
      const next = resolveEffectLevel(browserSignals());
      setLevel((current) => mayApplyLevel(current, next, heldRef.current) ? next : current);
    };

    motion.addEventListener?.('change', update);
    pointer.addEventListener?.('change', update);
    update();

    return () => {
      motion.removeEventListener?.('change', update);
      pointer.removeEventListener?.('change', update);
    };
  }, []);

  useEffect(() => {
    if (holdAutomaticUpgrades) return;
    const next = typeof window === 'undefined' ? 'static' : resolveEffectLevel(browserSignals());
    setLevel(next);
  }, [holdAutomaticUpgrades]);

  return level;
}
