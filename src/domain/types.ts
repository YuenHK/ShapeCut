export type WorkflowStep =
  | 'import'
  | 'axis'
  | 'decomposition'
  | 'engraving'
  | 'export';

export type Vec3 = readonly [number, number, number];

export type Axis = {
  origin: Vec3;
  direction: Vec3;
  confidence: number;
  confirmed: boolean;
};

export type Severity = 'blocking' | 'confirm' | 'info';

export type ProjectV1 = {
  schemaVersion: 1;
  id: string;
  name: string;
  step: WorkflowStep;
  axis?: Axis;
};
