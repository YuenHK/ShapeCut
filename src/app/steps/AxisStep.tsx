import { useState } from 'react';
import type { Axis } from '../../domain/types';
import { AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD, type AxisCandidate } from '../../domain/axis/find-axis';

const labels = ['X', 'Y', 'Z'] as const;
type ManualVector = readonly [string, string, string];

export type AxisStepProps = {
  readonly candidates: readonly AxisCandidate[];
  readonly confirmedAxis?: Axis;
  readonly onConfirm: (candidate: AxisCandidate) => void;
  readonly onAxisInvalidated?: () => void;
  readonly onManualRequest?: () => void;
  readonly onNext?: () => void;
};

export function AxisStep({
  candidates,
  confirmedAxis,
  onConfirm,
  onAxisInvalidated,
  onManualRequest,
  onNext,
}: AxisStepProps) {
  const candidate = candidates.reduce<AxisCandidate | undefined>(
    (best, current) => best === undefined || current.confidence > best.confidence ? current : best,
    undefined,
  );
  const manualRequired = candidate === undefined || candidate.confidence < AUTOMATIC_AXIS_CONFIDENCE_THRESHOLD;
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTouched, setManualTouched] = useState(false);
  const [origin, setOrigin] = useState<ManualVector>(['', '', '']);
  const [direction, setDirection] = useState<ManualVector>(['', '', '']);
  const manual = parseManualAxis(origin, direction);
  const showManual = manualRequired || manualOpen;

  const changeVector = (
    current: ManualVector,
    update: (value: ManualVector) => void,
    index: number,
    value: string,
  ): void => {
    const next = [...current] as [string, string, string];
    next[index] = value;
    update(next);
    setManualTouched(true);
    onAxisInvalidated?.();
  };

  return (
    <section aria-labelledby="axis-step-title">
      <h2 id="axis-step-title">軸心</h2>
      {candidate ? <p aria-label="最高候選信心">{Math.round(candidate.confidence * 100)}%</p> : <p>未找到候選軸心</p>}
      {manualRequired && <p role="status">需要手動設定</p>}
      <button
        type="button"
        disabled={!candidate || manualRequired}
        onClick={() => candidate && !manualRequired && onConfirm(candidate)}
      >確認軸心</button>
      {!manualRequired && (
        <button type="button" onClick={() => { setManualOpen(true); onManualRequest?.(); }}>手動設定軸心</button>
      )}
      {showManual && (
        <fieldset>
          <legend>手動軸心座標</legend>
          <div>
            {labels.map((label, index) => (
              <label key={`origin-${label}`}>手動原點 {label}
                <input
                  aria-label={`手動原點 ${label}`}
                  type="number"
                  step="any"
                  value={origin[index]}
                  onChange={(event) => changeVector(origin, setOrigin, index, event.currentTarget.value)}
                />
              </label>
            ))}
          </div>
          <div>
            {labels.map((label, index) => (
              <label key={`direction-${label}`}>手動方向 {label}
                <input
                  aria-label={`手動方向 ${label}`}
                  type="number"
                  step="any"
                  value={direction[index]}
                  onChange={(event) => changeVector(direction, setDirection, index, event.currentTarget.value)}
                />
              </label>
            ))}
          </div>
          {manualTouched && manual.error && <p role="alert">{manual.error}</p>}
          <button
            type="button"
            disabled={!manual.candidate}
            onClick={() => manual.candidate && onConfirm(manual.candidate)}
          >確認手動軸心</button>
        </fieldset>
      )}
      <button type="button" disabled={confirmedAxis?.confirmed !== true} onClick={onNext}>下一步</button>
    </section>
  );
}

function parseManualAxis(
  originValues: ManualVector,
  directionValues: ManualVector,
): { readonly candidate?: AxisCandidate; readonly error?: string } {
  const values = [...originValues, ...directionValues];
  if (values.some((value) => value.trim() === '')) return { error: '請填寫全部原點與方向座標。' };
  const parsed = values.map(Number);
  if (!parsed.every(Number.isFinite)) return { error: '原點與方向座標必須是有限數值。' };
  const origin = parsed.slice(0, 3) as [number, number, number];
  const direction = parsed.slice(3, 6) as [number, number, number];
  const length = Math.hypot(...direction);
  if (!(length > 0)) return { error: '手動方向必須是非零向量。' };
  return {
    candidate: {
      origin,
      direction: [direction[0] / length, direction[1] / length, direction[2] / length],
      confidence: 1,
      confirmed: false,
      radialRmsError: 0,
      centroidOffset: 0,
      source: 'manual',
    },
  };
}
