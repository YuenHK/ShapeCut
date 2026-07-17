import { createStore } from 'zustand/vanilla';

import type { Axis, ProjectV1, WorkflowStep } from '../domain/types';

const stepOrder: Record<WorkflowStep, number> = {
  import: 0,
  axis: 1,
  decomposition: 2,
  engraving: 3,
  export: 4,
};

export function canEnterStep(
  project: ProjectV1,
  target: WorkflowStep,
): boolean {
  if (stepOrder[target] <= stepOrder[project.step]) {
    return true;
  }

  if (target === 'decomposition') {
    return project.axis?.confirmed === true;
  }

  if (target === 'engraving') {
    return (
      project.axis?.confirmed === true &&
      stepOrder[project.step] >= stepOrder.decomposition
    );
  }

  if (target === 'export') {
    return (
      project.axis?.confirmed === true &&
      stepOrder[project.step] >= stepOrder.engraving
    );
  }

  return true;
}

export type ProjectStoreState = ProjectV1 & {
  setAxis: (axis: Axis) => void;
  goToStep: (target: WorkflowStep) => boolean;
};

export function createProjectStore() {
  return createStore<ProjectStoreState>()((set, get) => ({
    schemaVersion: 1,
    id: 'untitled-project',
    name: 'Untitled project',
    step: 'import',
    setAxis: (axis) => set({ axis }),
    goToStep: (target) => {
      if (!canEnterStep(get(), target)) {
        return false;
      }

      set({ step: target });
      return true;
    },
  }));
}
