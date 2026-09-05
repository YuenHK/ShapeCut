import { Children, Fragment, cloneElement, isValidElement, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

function rowsOf(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) => (
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? rowsOf(child.props.children) : [child]
  ));
}

export function DetailPages({ children, label, pageSize = 4 }: {
  label: string; children: ReactElement<{ children?: ReactNode }>; pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const rows = rowsOf(children.props.children);
  const count = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, count - 1);
  return <div className="detail-pages">
    <div className="detail-page-content">{cloneElement(children, {}, rows.slice(current * pageSize, (current + 1) * pageSize))}</div>
    <nav className="detail-pagination" aria-label={`${label}分頁`}>
      <button className="change-file-button" type="button" disabled={current === 0} aria-label={`${label}上一頁`} onClick={() => setPage(current - 1)}>上一頁</button>
      <span role="status">{current + 1} / {count}</span>
      <button className="change-file-button" type="button" disabled={current === count - 1} aria-label={`${label}下一頁`} onClick={() => setPage(current + 1)}>下一頁</button>
    </nav>
  </div>;
}

export function WorkbenchDetails({ settings, warnings, technical }: { settings: ReactNode; warnings: ReactNode; technical: ReactNode }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = ['製作設定', '處理提示', '技術資料'];
  return <section className="workbench-details" aria-label="結果詳細資料">
    <div role="tablist" aria-label="結果資料分類" className="workbench-tabs">
      {labels.map((label, index) => <button key={label} ref={(element) => { buttons.current[index] = element; }}
        className="change-file-button" type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
        aria-selected={active === index} tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)}
        onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : undefined;
          if (next === undefined) return;
          event.preventDefault(); setActive(next); buttons.current[next]?.focus();
        }}>{label}</button>)}
    </div>
    {[settings, warnings, technical].map((content, index) => <div key={labels[index]} role="tabpanel" id={`${id}-panel-${index}`}
      aria-labelledby={`${id}-tab-${index}`} hidden={active !== index} tabIndex={0}>{content}</div>)}
  </section>;
}
