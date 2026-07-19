import type { WizardSettings } from '../project-store';

export function DecompositionStep({ settings, busy, onChange, onAccept }: {
  readonly settings: WizardSettings;
  readonly busy: boolean;
  readonly onChange: (changes: Partial<WizardSettings>) => void;
  readonly onAccept: () => void;
}) {
  return (
    <section aria-labelledby="decomposition-title">
      <h2 id="decomposition-title">自動拆件</h2>
      <label>分件線位置 (%)<input type="number" min="10" max="90" value={settings.splitPositionPercent} onChange={(e) => onChange({ splitPositionPercent: Number(e.currentTarget.value) })} /></label>
      <label>骨架數量<input aria-label="骨架數量" type="number" min="4" max="12" step="2" value={settings.ribCount} onChange={(e) => onChange({ ribCount: Number(e.currentTarget.value) })} /></label>
      <label>外環層數<input type="number" min="1" max="24" value={settings.ringLayers} onChange={(e) => onChange({ ringLayers: Number(e.currentTarget.value) })} /></label>
      <label>金屬軸直徑 (mm)<input type="number" min="0.5" step="0.1" value={settings.shaftMm} onChange={(e) => onChange({ shaftMm: Number(e.currentTarget.value) })} /></label>
      <label>卡榫配合<select value={settings.fit} onChange={(e) => onChange({ fit: e.currentTarget.value as WizardSettings['fit'] })}><option value="loose">稍鬆</option><option value="slip">滑入</option><option value="snug">稍緊</option><option value="press">壓入</option></select></label>
      <button type="button" disabled={busy} onClick={onAccept}>{busy ? '計算中…' : '接受拆件建議'}</button>
    </section>
  );
}
