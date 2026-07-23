import { describe, expect, it } from 'vitest';
import { resolveEffectLevel } from './effect-level';

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
});
