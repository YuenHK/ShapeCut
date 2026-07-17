export type WorkflowStep =
  | 'import'
  | 'axis'
  | 'decomposition'
  | 'engraving'
  | 'export';

export type Vec3 = readonly [number, number, number];

export type Axis = {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly confidence: number;
  readonly confirmed: boolean;
};

export type Severity = 'blocking' | 'confirm' | 'info';

export type ProjectV1 = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly step: WorkflowStep;
  readonly axis?: Axis;
};
