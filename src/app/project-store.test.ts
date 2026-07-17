import { describe, expect, it } from 'vitest';

import { createProjectStore } from './project-store';

describe('project workflow store', () => {
  it('starts at import and blocks decomposition until the axis is confirmed', () => {
    const store = createProjectStore();

    expect(store.getState().goToStep('decomposition')).toBe(false);
    expect(store.getState().step).toBe('import');
  });

  it('enters decomposition after confirming the axis', () => {
    const store = createProjectStore();

    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 0.9,
      confirmed: true,
    });

    expect(store.getState().goToStep('decomposition')).toBe(true);
    expect(store.getState().step).toBe('decomposition');
  });

  it('requires decomposition before engraving and engraving before export', () => {
    const store = createProjectStore();
    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: true,
    });

    expect(store.getState().goToStep('engraving')).toBe(false);
    expect(store.getState().goToStep('export')).toBe(false);
    expect(store.getState().step).toBe('import');

    expect(store.getState().goToStep('decomposition')).toBe(true);
    expect(store.getState().goToStep('export')).toBe(false);
    expect(store.getState().step).toBe('decomposition');

    expect(store.getState().goToStep('engraving')).toBe(true);
    expect(store.getState().goToStep('export')).toBe(true);
    expect(store.getState().step).toBe('export');
  });

  it('allows returning from a later step to an earlier step', () => {
    const store = createProjectStore();
    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: true,
    });
    store.getState().goToStep('decomposition');
    store.getState().goToStep('engraving');

    expect(store.getState().goToStep('axis')).toBe(true);
    expect(store.getState().step).toBe('axis');
  });

  it('enters engraving after decomposition even if the axis is later unconfirmed', () => {
    const store = createProjectStore();
    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: true,
    });
    store.getState().goToStep('decomposition');
    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: false,
    });

    expect(store.getState().goToStep('engraving')).toBe(true);
    expect(store.getState().step).toBe('engraving');
  });

  it('enters export after engraving even if the axis is later unconfirmed', () => {
    const store = createProjectStore();
    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: true,
    });
    store.getState().goToStep('decomposition');
    store.getState().goToStep('engraving');
    store.getState().setAxis({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: false,
    });

    expect(store.getState().goToStep('export')).toBe(true);
    expect(store.getState().step).toBe('export');
  });
});
