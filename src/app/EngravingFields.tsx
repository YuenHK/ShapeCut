import type { EngravingSettings } from '../domain/part-engraving/settings';
import fontLicenseUrl from '../domain/part-engraving/assets/OFL.txt?url';

export function EngravingFields({ value, onChange, error }: {
  readonly value: EngravingSettings;
  readonly onChange: (value: EngravingSettings) => void;
  readonly error?: string;
}) {
  return <fieldset className="engraving-fields">
    <legend>切片刻字（選填）</legend>
    <label className="material-picker">名稱／學號
      <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })}
        aria-describedby="engraving-help" autoComplete="off" />
    </label>
    <label className="material-picker">作品名
      <input value={value.workName} onChange={(event) => onChange({ ...value, workName: event.target.value })}
        aria-describedby="engraving-help" autoComplete="off" />
    </label>
    <p className="material-field-help" id="engraving-help">每欄最多 24 字；兩欄留空則不刻字。自動加上 PartA（上）、PartB（中）、PartC（下）。只在本機處理及儲存，下載檔案會包含識別文字。</p>
    <p className="material-field-help">ENGRAVE_TEXT 圖層須設定為雕刻，不可切割；請先試刻。</p>
    <a href={fontLicenseUrl} target="_blank" rel="noopener noreferrer">刻字字型授權</a>
    {error && <p className="material-field-error" role="alert">{error}</p>}
  </fieldset>;
}
