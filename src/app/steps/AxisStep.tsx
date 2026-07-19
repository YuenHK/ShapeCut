import type { Axis } from '../../domain/types';
import type { AxisCandidate } from '../../domain/axis/find-axis';

export type AxisStepProps = {
  readonly candidates: readonly AxisCandidate[];
  readonly confirmedAxis?: Axis;
  readonly onConfirm: (candidate: AxisCandidate) => void;
  readonly onManualRequest?: () => void;
  readonly onNext?: () => void;
};

export function AxisStep({ candidates, confirmedAxis, onConfirm, onManualRequest, onNext }: AxisStepProps) {
  const candidate = candidates.reduce<AxisCandidate | undefined>(
    (best, current) => best === undefined || current.confidence > best.confidence ? current : best,
    undefined,
  );
  const needsConfirmation = candidate !== undefined && candidate.confidence < 0.8;
  return (
    <section aria-labelledby="axis-step-title">
      <h2 id="axis-step-title">軸心</h2>
      {candidate ? <p aria-label="最高候選信心">{Math.round(candidate.confidence * 100)}%</p> : <p>未找到候選軸心</p>}
      {needsConfirmation && <p role="status">需要確認</p>}
      <button type="button" disabled={!candidate} onClick={() => candidate && onConfirm(candidate)}>確認軸心</button>
      {onManualRequest && <button type="button" onClick={onManualRequest}>手動設定軸心</button>}
      <button type="button" disabled={!confirmedAxis?.confirmed && (needsConfirmation || !candidate)} onClick={onNext}>下一步</button>
    </section>
  );
}
