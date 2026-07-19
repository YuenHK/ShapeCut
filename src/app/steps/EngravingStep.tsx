import type { WizardSettings } from '../project-store';

export function EngravingStep({ settings, busy, onChange, onGenerate }: {
  readonly settings: WizardSettings;
  readonly busy: boolean;
  readonly onChange: (changes: Partial<WizardSettings>) => void;
  readonly onGenerate: () => void;
}) {
  return (
    <section aria-labelledby="engraving-title">
      <h2 id="engraving-title">紋理與材料</h2>
      <label>材料設定檔<select disabled={busy} aria-label="材料設定檔" value={settings.materialId} onChange={(e) => onChange({ materialId: e.currentTarget.value })}><option value="plywood-3">Plywood 3 mm</option><option value="acrylic-3">Cast acrylic 3 mm</option><option value="cardboard-2">Cardboard 2 mm</option><option value="cork-3">Cork 3 mm</option></select></label>
      <label>雕刻級數<select disabled={busy} aria-label="雕刻級數" value={settings.engravingLevels} onChange={(e) => onChange({ engravingLevels: Number(e.currentTarget.value) as 3 | 4 | 5 })}><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label>
      <label>紋理強度<input disabled={busy} type="range" min="0" max="1" step="0.1" value={settings.textureStrength} onChange={(e) => onChange({ textureStrength: Number(e.currentTarget.value) })} /></label>
      <label>板材闊度 (mm)<input disabled={busy} type="number" min="1" value={settings.sheetWidthMm} onChange={(e) => onChange({ sheetWidthMm: Number(e.currentTarget.value) })} /></label>
      <label>板材高度 (mm)<input disabled={busy} type="number" min="1" value={settings.sheetHeightMm} onChange={(e) => onChange({ sheetHeightMm: Number(e.currentTarget.value) })} /></label>
      <button type="button" disabled={busy} onClick={onGenerate}>{busy ? '產生中…' : '產生雕刻與材料設定'}</button>
    </section>
  );
}
