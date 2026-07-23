import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { OneClickViewState } from './OneClickConverter';
import type { EffectLevel } from './effect-level';

export type WorkbenchState = OneClickViewState['kind'];

export type AppleWorkbenchProps = Readonly<{
  state: WorkbenchState;
  stage?: AutomaticOutlineProgressStage;
  fileName?: string;
  level: EffectLevel;
  chromeTarget?: Element | null;
  children: ReactNode;
}>;

const PROCESSING_STEP_LABELS: Readonly<Record<AutomaticOutlineProgressStage, string>> = Object.freeze({
  reading: '讀取模型幾何',
  analyzing: '分析模型',
  simplifying: '簡化模型',
  slicing: '產生切片',
  packaging: '準備下載',
});

function currentStepLabel(
  state: WorkbenchState,
  stage: AutomaticOutlineProgressStage | undefined,
): string {
  switch (state) {
    case 'upload': return '上載 STL 模型';
    case 'reading': return '讀取 STL 檔案';
    case 'material': return '選擇製作材料';
    case 'processing': return stage ? PROCESSING_STEP_LABELS[stage] : '處理模型';
    case 'result': return '下載切片檔案';
    case 'failure': return '處理失敗';
  }
}

function CurrentStepWayfinding({
  state,
  stage,
  fileName,
}: Pick<AppleWorkbenchProps, 'state' | 'stage' | 'fileName'>) {
  return (
    <nav className="current-step" aria-label="目前步驟" aria-live="polite" aria-atomic="true">
      <span className="current-step-kicker">目前步驟</span>
      <strong aria-current="step">{currentStepLabel(state, stage)}</strong>
      {fileName && <span className="current-step-file">模型：{fileName}</span>}
    </nav>
  );
}

export function AppleWorkbench({
  state,
  stage,
  fileName,
  level,
  chromeTarget,
  children,
}: AppleWorkbenchProps) {
  const wayfinding = <CurrentStepWayfinding state={state} stage={stage} fileName={fileName} />;
  return (
    <section className="apple-workbench" data-testid="apple-workbench" data-state={state} data-effect-level={level}>
      {chromeTarget ? createPortal(wayfinding, chromeTarget) : wayfinding}
      <div className="workbench-environment" aria-hidden="true">
        <span className="workbench-grid" />
        <span className="workbench-orbit workbench-orbit-one" />
        <span className="workbench-orbit workbench-orbit-two" />
      </div>
      <div className="workbench-stage">{children}</div>
    </section>
  );
}
