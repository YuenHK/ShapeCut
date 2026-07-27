import { describe, expect, it } from 'vitest';

import type { Axis, ProjectV1, WorkflowStep } from '../domain/types';
import { OFFICIAL_THREE_PRONG_TEMPLATE_VERSION } from '../domain/outline-assembly/launcher-template';
import { canEnterStep, createProjectStore } from './project-store';

const confirmedAxis: Axis = Object.freeze({
  origin: Object.freeze([0, 0, 0] as const),
  direction: Object.freeze([0, 1, 0] as const),
  confidence: 1,
  confirmed: true,
});

const unconfirmedAxis: Axis = Object.freeze({
  ...confirmedAxis,
  confirmed: false,
});

if (false) {
  const axis: Axis = confirmedAxis;
  // @ts-expect-error Axis fields are immutable project data.
  axis.confirmed = false;
  // @ts-expect-error Vec3 entries are immutable project data.
  axis.origin[0] = 1;
}

describe('canEnterStep', () => {
  const cases: ReadonlyArray<{
    name: string;
    current: WorkflowStep;
    target: WorkflowStep;
    axis?: Axis;
    expected: boolean;
  }> = [
    {
      name: 'blocks decomposition without a confirmed axis',
      current: 'axis',
      target: 'decomposition',
      axis: unconfirmedAxis,
      expected: false,
    },
    {
      name: 'allows decomposition with a confirmed axis',
      current: 'axis',
      target: 'decomposition',
      axis: confirmedAxis,
      expected: true,
    },
    {
      name: 'allows engraving after decomposition without rechecking the axis',
      current: 'decomposition',
      target: 'engraving',
      axis: unconfirmedAxis,
      expected: true,
    },
    {
      name: 'blocks engraving before decomposition',
      current: 'axis',
      target: 'engraving',
      axis: confirmedAxis,
      expected: false,
    },
    {
      name: 'allows export after engraving without rechecking the axis',
      current: 'engraving',
      target: 'export',
      axis: unconfirmedAxis,
      expected: true,
    },
    {
      name: 'blocks export before engraving',
      current: 'decomposition',
      target: 'export',
      axis: confirmedAxis,
      expected: false,
    },
    {
      name: 'allows returning to an earlier step',
      current: 'export',
      target: 'import',
      axis: unconfirmedAxis,
      expected: true,
    },
  ];

  it.each(cases)('$name', ({ current, target, axis, expected }) => {
    const project: ProjectV1 = Object.freeze({
      schemaVersion: 1,
      id: 'frozen-project',
      name: 'Frozen project',
      step: current,
      axis,
    });
    const before = structuredClone(project);

    expect(canEnterStep(project, target)).toBe(expected);
    expect(project).toEqual(before);
    expect(Object.isFrozen(project)).toBe(true);
    if (project.axis) {
      expect(Object.isFrozen(project.axis)).toBe(true);
    }
  });
});

describe('project workflow store', () => {
  it('defaults launcher settings and preserves them through immutable load', () => {
    const store = createProjectStore();

    expect(store.getState().settings).toMatchObject({
      launcherFitOffsetMm: 0,
      launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    });

    const saved = {
      schemaVersion: 1 as const,
      id: 'launcher-settings-project',
      name: 'Launcher settings project',
      step: 'axis' as const,
      settings: { ...store.getState().settings, launcherFitOffsetMm: 0.05 },
    };
    store.getState().loadProject(saved);
    (saved.settings as { launcherFitOffsetMm: number }).launcherFitOffsetMm = -0.05;

    expect(store.getState().settings).toMatchObject({
      launcherFitOffsetMm: 0.05,
      launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    });
  });

  it('loads persisted downstream state into a locked import checkpoint', () => {
    const store = createProjectStore();

    store.getState().loadProject({
      schemaVersion: 1,
      id: 'saved-project',
      name: 'Saved project',
      step: 'export',
      axis: confirmedAxis,
      settings: store.getState().settings,
    });

    expect(store.getState()).toMatchObject({
      id: 'saved-project',
      name: 'Saved project',
      step: 'import',
      axis: undefined,
    });
    expect(store.getState().goToStep('decomposition')).toBe(false);
  });

  it('resumes a verified later project no later than decomposition so artifacts must be regenerated', () => {
    const store = createProjectStore();
    const saved = {
      schemaVersion: 1 as const,
      id: 'verified-project',
      name: 'Verified project',
      step: 'export' as const,
      axis: confirmedAxis,
      settings: { ...store.getState().settings, ribCount: 10 as const },
    };

    store.getState().loadProject(saved);
    (store.getState() as unknown as { resumeVerifiedProject(project: typeof saved): void }).resumeVerifiedProject(saved);

    expect(store.getState()).toMatchObject({
      id: 'verified-project',
      step: 'decomposition',
      axis: confirmedAxis,
      settings: { ribCount: 10 },
    });
  });

  it('copies an axis so later input mutations cannot change project state', () => {
    const store = createProjectStore();
    const input = {
      origin: [0, 0, 0] as [number, number, number],
      direction: [0, 1, 0] as [number, number, number],
      confidence: 1,
      confirmed: true,
    };

    store.getState().setAxis(input);
    input.confirmed = false;
    input.origin[0] = 42;

    expect(store.getState().axis).toEqual({
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      confidence: 1,
      confirmed: true,
    });
  });

  it('stores only the persisted Axis contract when confirming an axis candidate', () => {
    const store = createProjectStore();
    store.getState().setAxis({ ...confirmedAxis, radialRmsError: 0.1, centroidOffset: 0, source: 'inertia' } as Axis & Record<string, unknown>);
    expect(store.getState().axis).toEqual(confirmedAxis);
  });

  it('starts at import and blocks decomposition until the axis is confirmed', () => {
    const store = createProjectStore();

    expect(store.getState().goToStep('decomposition')).toBe(false);
    expect(store.getState().step).toBe('import');
  });

  it('enters decomposition after confirming the axis', () => {
    const store = createProjectStore();

    store.getState().setAxis(confirmedAxis);

    expect(store.getState().goToStep('decomposition')).toBe(true);
    expect(store.getState().step).toBe('decomposition');
  });

  it('requires decomposition before engraving and engraving before export', () => {
    const store = createProjectStore();
    store.getState().setAxis(confirmedAxis);

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
    store.getState().setAxis(confirmedAxis);
    store.getState().goToStep('decomposition');
    store.getState().goToStep('engraving');

    expect(store.getState().goToStep('axis')).toBe(true);
    expect(store.getState().step).toBe('axis');
  });

  it('enters engraving after decomposition even if the axis is later unconfirmed', () => {
    const store = createProjectStore();
    store.getState().setAxis(confirmedAxis);
    store.getState().goToStep('decomposition');
    store.getState().setAxis(unconfirmedAxis);

    expect(store.getState().goToStep('engraving')).toBe(true);
    expect(store.getState().step).toBe('engraving');
  });

  it('enters export after engraving even if the axis is later unconfirmed', () => {
    const store = createProjectStore();
    store.getState().setAxis(confirmedAxis);
    store.getState().goToStep('decomposition');
    store.getState().goToStep('engraving');
    store.getState().setAxis(unconfirmedAxis);

    expect(store.getState().goToStep('export')).toBe(true);
    expect(store.getState().step).toBe('export');
  });
});
