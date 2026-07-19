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
    return stepOrder[project.step] >= stepOrder.decomposition;
  }

  if (target === 'export') {
    return stepOrder[project.step] >= stepOrder.engraving;
  }

  return true;
}

export type ProjectStoreState = ProjectV1 & {
  settings: WizardSettings;
  persistenceError?: string;
  setAxis: (axis: Axis) => void;
  updateSettings: (changes: Partial<WizardSettings>) => void;
  setPersistenceError: (message?: string) => void;
  loadProject: (project: ProjectV1 & { readonly settings: WizardSettings }) => void;
  goToStep: (target: WorkflowStep) => boolean;
};

export type WizardSettings = {
  readonly splitPositionPercent: number;
  readonly ribCount: number;
  readonly ringLayers: number;
  readonly shaftMm: number;
  readonly fit: 'loose' | 'slip' | 'snug' | 'press';
  readonly materialId: string;
  readonly engravingLevels: 3 | 4 | 5;
  readonly textureStrength: number;
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
};

export function createProjectStore() {
  return createStore<ProjectStoreState>()((set, get) => ({
    schemaVersion: 1,
    id: 'untitled-project',
    name: 'Untitled project',
    step: 'import',
    settings: {
      splitPositionPercent: 50,
      ribCount: 6,
      ringLayers: 2,
      shaftMm: 3,
      fit: 'snug',
      materialId: 'plywood-3',
      engravingLevels: 3,
      textureStrength: 0.6,
      sheetWidthMm: 300,
      sheetHeightMm: 200,
    },
    setAxis: (axis) =>
      set({
        axis: {
          origin: [...axis.origin],
          direction: [...axis.direction],
          confidence: axis.confidence,
          confirmed: axis.confirmed,
        },
      }),
    updateSettings: (changes) => set((state) => ({ settings: { ...state.settings, ...changes } })),
    setPersistenceError: (message) => set({ persistenceError: message }),
    loadProject: (project) => set({
      schemaVersion: project.schemaVersion, id: project.id, name: project.name, step: project.step,
      axis: project.axis ? { ...project.axis, origin: [...project.axis.origin], direction: [...project.axis.direction] } : undefined,
      settings: structuredClone(project.settings), persistenceError: undefined,
    }),
    goToStep: (target) => {
      if (!canEnterStep(get(), target)) {
        return false;
      }

      set({ step: target });
      return true;
    },
  }));
}
