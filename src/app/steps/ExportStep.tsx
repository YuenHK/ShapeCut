import type { GeometryIssue } from '../../preview/SpinnerViewport';

export function ExportStep({ issues, busy, onExport }: { readonly issues: readonly GeometryIssue[]; readonly busy: boolean; readonly onExport: () => void }) {
  const blocked = issues.some(({ severity }) => severity === 'blocking');
  const confirmations = issues.some(({ severity }) => severity === 'confirm');
  return (
    <section aria-labelledby="export-title">
      <h2 id="export-title">排版與輸出</h2>
      {issues.length === 0 ? <p role="status">加工前檢查通過</p> : <ul>{issues.map((issue) => <li key={issue.id}><button type="button" aria-describedby={`${issue.id}-description`}>{issue.label}（{issue.severity}）</button><span id={`${issue.id}-description`}>{issue.description}</span></li>)}</ul>}
      <button type="button" disabled={blocked || confirmations || busy} onClick={onExport}>{busy ? '建立中…' : '匯出製作套件'}</button>
    </section>
  );
}
