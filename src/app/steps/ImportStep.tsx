import type { MeshProblemReport, MeshRepairResult } from '../../domain/mesh/types';

export type ImportRepairStage = 'original' | 'safe' | 'advanced';
export type ImportBusyAction = 'analyze' | 'advanced' | 'download' | 'workflow';

export type ImportStepProps = {
  readonly file?: File;
  readonly busyAction?: ImportBusyAction;
  readonly stage: ImportRepairStage;
  readonly originalReport?: MeshProblemReport;
  readonly safeRepair?: MeshRepairResult;
  readonly advancedRepair?: MeshRepairResult;
  readonly advancedConsent: boolean;
  readonly onFile: (file: File | undefined) => void;
  readonly onAnalyze: () => void;
  readonly onAdvancedConsent: (consent: boolean) => void;
  readonly onAdvancedRepair: () => void;
  readonly onRestore: () => void;
  readonly onPreview: (stage: Exclude<ImportRepairStage, 'original'>) => void;
  readonly onUseRepair: () => void;
  readonly onDownload: () => void;
};

export function ImportStep({
  file,
  busyAction,
  stage,
  originalReport,
  safeRepair,
  advancedRepair,
  advancedConsent,
  onFile,
  onAnalyze,
  onAdvancedConsent,
  onAdvancedRepair,
  onRestore,
  onPreview,
  onUseRepair,
  onDownload,
}: ImportStepProps) {
  const busy = busyAction !== undefined;
  const currentRepair = stage === 'safe' ? safeRepair : stage === 'advanced' ? advancedRepair : undefined;
  return (
    <section aria-labelledby="import-title">
      <h2 id="import-title">匯入與修復</h2>
      <label>STL 模型檔案<input aria-label="STL 模型檔案" type="file" accept=".stl,model/stl" onChange={(event) => onFile(event.currentTarget.files?.[0])} /></label>
      {file && <p>{file.name}</p>}
      <button type="button" disabled={!file || busy} onClick={onAnalyze}>{busyAction === 'analyze' ? '分析中…' : '分析模型'}</button>

      {originalReport && <RepairSummary stage={stage} originalReport={originalReport} repair={currentRepair} />}

      {originalReport && stage !== 'original' && <button type="button" disabled={busy} onClick={onRestore}>復原原始模型</button>}
      {originalReport && stage === 'original' && safeRepair && <button type="button" disabled={busy} onClick={() => onPreview('safe')}>預覽安全修復</button>}
      {originalReport && stage !== 'advanced' && advancedRepair && <button type="button" disabled={busy} onClick={() => onPreview('advanced')}>預覽進階修復</button>}

      {safeRepair && !safeRepair.accepted && (
        <fieldset>
          <legend>進階修復</legend>
          <label>
            <input
              type="checkbox"
              checked={advancedConsent}
              disabled={busy}
              onChange={(event) => onAdvancedConsent(event.currentTarget.checked)}
            />
            我明白進階修復可能改變模型細節
          </label>
          <button type="button" disabled={!advancedConsent || busy} onClick={onAdvancedRepair}>
            {busyAction === 'advanced' ? '進階修復中…' : '進階修復'}
          </button>
        </fieldset>
      )}

      {currentRepair && (
        <>
          <button type="button" disabled={!currentRepair.accepted || busy} onClick={onUseRepair}>使用{currentRepair.mode === 'safe' ? '安全' : '進階'}修復</button>
          {currentRepair.accepted && <button type="button" disabled={busy} onClick={onDownload}>{busyAction === 'download' ? '準備下載中…' : '下載已修復 STL'}</button>}
        </>
      )}
    </section>
  );
}

export function RepairSummary({
  stage,
  originalReport,
  repair,
}: {
  readonly stage: ImportRepairStage;
  readonly originalReport: MeshProblemReport;
  readonly repair?: MeshRepairResult;
}) {
  const stageLabel = stage === 'original' ? '原始模型' : stage === 'safe' ? '安全修復' : '進階修復';
  const before = repair?.before ?? originalReport;
  const after = repair?.after;
  const count = (label: string, beforeValue: number, afterValue?: number) => (
    <li key={label}>{label}：{beforeValue}{afterValue === undefined ? '' : ` → ${afterValue}`}</li>
  );
  return (
    <section aria-label="修復結果">
      <h3>網格診斷</h3>
      <p>目前預覽：{stageLabel}</p>
      <ul>
        {count('開放邊界', before.inspection.boundaryEdgeCount, after?.inspection.boundaryEdgeCount)}
        {count('非流形邊', before.inspection.nonManifoldEdgeCount, after?.inspection.nonManifoldEdgeCount)}
        {count('退化三角形', before.inspection.degenerateTriangleCount, after?.inspection.degenerateTriangleCount)}
        {count('重複三角形', before.duplicateTriangleCount, after?.duplicateTriangleCount)}
      </ul>
      {repair && (
        <>
          <h4>原始模型問題</h4>
          <ul aria-label="原始模型問題">
            {count('開放邊界', originalReport.inspection.boundaryEdgeCount)}
            {count('非流形邊', originalReport.inspection.nonManifoldEdgeCount)}
            {count('退化三角形', originalReport.inspection.degenerateTriangleCount)}
            {count('重複三角形', originalReport.duplicateTriangleCount)}
          </ul>
          <p>{repair.accepted ? '修復結果已通過安全檢查' : '修復結果未通過安全檢查'}</p>
          <ul aria-label="修復變更">
            <li>移除退化三角形：{repair.changes.removedDegenerate}</li>
            <li>移除重複三角形：{repair.changes.removedDuplicate}</li>
            <li>焊合頂點：{repair.changes.weldedVertices}</li>
            <li>拆分頂點：{repair.changes.splitVertices}</li>
            <li>補合缺口：{repair.changes.filledHoles}</li>
          </ul>
          <ul aria-label="形狀比較">
            <li>X 軸尺寸變化：{formatPercent(repair.comparison.axisChangePercent[0])}%</li>
            <li>Y 軸尺寸變化：{formatPercent(repair.comparison.axisChangePercent[1])}%</li>
            <li>Z 軸尺寸變化：{formatPercent(repair.comparison.axisChangePercent[2])}%</li>
            <li>體積變化：{formatPercent(repair.comparison.volumeChangePercent)}%</li>
          </ul>
          {repair.blockingReasons.length > 0 && <ul aria-label="修復阻擋原因">{repair.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        </>
      )}
    </section>
  );
}

function formatPercent(value: number): string {
  return Number(value.toFixed(3)).toString();
}
