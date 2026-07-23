import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEffectLevel, useEffectLevel } from './effect-level';

class MutableMediaQuery {
  matches = false;
  readonly media: string;
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(media: string) {
    this.media = media;
  }

  addEventListener(_type: 'change', listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    const event = { matches, media: this.media } as MediaQueryListEvent;
    for (const listener of this.listeners) listener(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveEffectLevel', () => {
  it('makes reduced motion authoritative', () => {
    expect(resolveEffectLevel({ reducedMotion: true, coarsePointer: false, hardwareConcurrency: 16, webgl: true })).toBe('static');
  });

  it('uses energy-saving for constrained capability', () => {
    expect(resolveEffectLevel({ reducedMotion: false, coarsePointer: true, hardwareConcurrency: 4, webgl: true })).toBe('energy-saving');
  });

  it('uses full only for capable WebGL presentation', () => {
    expect(resolveEffectLevel({ reducedMotion: false, coarsePointer: false, hardwareConcurrency: 8, webgl: true })).toBe('full');
    expect(resolveEffectLevel({ reducedMotion: false, coarsePointer: false, hardwareConcurrency: 8, webgl: false })).toBe('static');
  });

  it('applies downgrades immediately but holds automatic upgrades during processing', () => {
    const motion = new MutableMediaQuery('(prefers-reduced-motion: reduce)');
    const pointer = new MutableMediaQuery('(pointer: coarse)');
    vi.stubGlobal('matchMedia', vi.fn((query: string) => query === motion.media ? motion : pointer));
    vi.stubGlobal('WebGLRenderingContext', class {});
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);

    const { result, rerender } = renderHook(
      ({ processing }) => useEffectLevel(processing),
      { initialProps: { processing: true } },
    );
    expect(result.current).toBe('full');

    act(() => motion.setMatches(true));
    expect(result.current).toBe('static');

    act(() => motion.setMatches(false));
    expect(result.current).toBe('static');

    rerender({ processing: false });
    expect(result.current).toBe('full');

    act(() => pointer.setMatches(true));
    expect(result.current).toBe('energy-saving');
    act(() => pointer.setMatches(false));
    expect(result.current).toBe('full');
  });
});
