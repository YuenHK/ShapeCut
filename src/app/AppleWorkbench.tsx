import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import type { ReactNode } from 'react';
import type { OneClickViewState } from './OneClickConverter';
import type { EffectLevel } from './effect-level';

export type WorkbenchState = OneClickViewState['kind'];

export type AppleWorkbenchProps = Readonly<{
  state: WorkbenchState;
  stage?: AutomaticOutlineProgressStage;
  fileName?: string;
  level: EffectLevel;
  children: ReactNode;
}>;

export function AppleWorkbench({ state, level, children }: AppleWorkbenchProps) {
  return (
    <section className="apple-workbench" data-testid="apple-workbench" data-state={state} data-effect-level={level}>
      <div className="workbench-environment" aria-hidden="true">
        <span className="workbench-grid" />
        <span className="workbench-orbit workbench-orbit-one" />
        <span className="workbench-orbit workbench-orbit-two" />
      </div>
      <div className="workbench-stage">{children}</div>
    </section>
  );
}
