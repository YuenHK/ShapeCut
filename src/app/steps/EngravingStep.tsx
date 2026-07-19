import type { MaterialCatalogEntry } from '../material-catalog';
import type { WizardSettings } from '../project-store';

export function EngravingStep({
  settings,
  busy,
  materials,
  materialJson,
  materialStatus,
  onMaterialJson,
  onLoadMaterialJson,
  onSaveMaterialJson,
  onChange,
  onGenerate,
}: {
  readonly settings: WizardSettings;
  readonly busy: boolean;
  readonly materials: readonly MaterialCatalogEntry[];
  readonly materialJson: string;
  readonly materialStatus?: string;
  readonly onMaterialJson: (value: string) => void;
  readonly onLoadMaterialJson: () => void;
  readonly onSaveMaterialJson: () => void;
  readonly onChange: (changes: Partial<WizardSettings>) => void;
  readonly onGenerate: () => void;
}) {
  const selected = materials.find(({ profile }) => profile.id === settings.materialId);
  return (
    <section aria-labelledby="engraving-title">
      <h2 id="engraving-title">紋理與材料</h2>
      <label>材料設定檔<select disabled={busy} aria-label="材料設定檔" value={settings.materialId} onChange={(e) => onChange({ materialId: e.currentTarget.value })}>
        {materials.map(({ profile, readiness, source }) => <option key={`${source}:${profile.id}`} value={profile.id}>
          {profile.materialName} — {readinessLabel(readiness.status)}{source === 'builtin' ? '（內置唯讀）' : ''}
        </option>)}
      </select></label>
      {selected && <div aria-label="材料準備狀態">
        <p>材料狀態：{readinessLabel(selected.readiness.status)}</p>
        {selected.readiness.reasons.length > 0 && <ul>{selected.readiness.reasons.map(({ code, message }) => <li key={code}>{message}</li>)}</ul>}
      </div>}
      <label>材料設定檔 JSON<textarea disabled={busy} aria-label="材料設定檔 JSON" rows={12} spellCheck={false} value={materialJson} onChange={(event) => onMaterialJson(event.currentTarget.value)} /></label>
      <button type="button" disabled={busy || !selected} onClick={onLoadMaterialJson}>載入所選設定檔 JSON</button>
      <button type="button" disabled={busy || materialJson.trim().length === 0} onClick={onSaveMaterialJson}>驗證並儲存材料設定檔</button>
      {materialStatus && <p role="status">{materialStatus}</p>}
      <label>雕刻級數<select disabled={busy} aria-label="雕刻級數" value={settings.engravingLevels} onChange={(e) => onChange({ engravingLevels: Number(e.currentTarget.value) as 3 | 4 | 5 })}><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></label>
      <label>紋理強度<input disabled={busy} type="range" min="0" max="1" step="0.1" value={settings.textureStrength} onChange={(e) => onChange({ textureStrength: Number(e.currentTarget.value) })} /></label>
      <label>板材闊度 (mm)<input disabled={busy} type="number" min="1" value={settings.sheetWidthMm} onChange={(e) => onChange({ sheetWidthMm: Number(e.currentTarget.value) })} /></label>
      <label>板材高度 (mm)<input disabled={busy} type="number" min="1" value={settings.sheetHeightMm} onChange={(e) => onChange({ sheetHeightMm: Number(e.currentTarget.value) })} /></label>
      <button type="button" disabled={busy} onClick={onGenerate}>{busy ? '產生中…' : '產生雕刻與材料設定'}</button>
    </section>
  );
}

function readinessLabel(status: MaterialCatalogEntry['readiness']['status']): string {
  if (status === 'ready') return '已就緒';
  if (status === 'confirm') return '待確認';
  return '已阻擋';
}
