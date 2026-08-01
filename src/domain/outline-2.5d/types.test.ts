import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTLINE_BUDGETS } from './types';

describe('DEFAULT_OUTLINE_BUDGETS', () => {
  it('allows verified local conversion work for up to 120 seconds', () => {
    expect(DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs).toBe(120_000);
  });
});
