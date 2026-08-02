import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTLINE_BUDGETS } from './types';

describe('DEFAULT_OUTLINE_BUDGETS', () => {
  it('does not impose an automatic runtime limit', () => {
    expect(DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs).toBe(Infinity);
  });
});
