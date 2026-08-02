import { useEffect, useState } from 'react';

function elapsedLabel(startedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `已處理 ${minutes}:${seconds}`;
}

export function ProcessingLoadingPanel({
  title,
  titleId,
  fileName,
  startedAt,
  onCancel,
}: {
  readonly title: string;
  readonly titleId?: string;
  readonly fileName: string;
  readonly startedAt: number;
  readonly onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(() => elapsedLabel(startedAt));

  useEffect(() => {
    const updateElapsed = () => setElapsed(elapsedLabel(startedAt));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="processing-loading-panel">
      <div className="neutral-loading" aria-hidden="true"><span /><span /><span /></div>
      <div className="processing-message">
        <div className="processing-orbit" aria-hidden="true" />
        <h1 id={titleId}>{title}</h1>
        <p className="file-name">{fileName}</p>
        <p className="processing-elapsed">{elapsed}</p>
        <button className="change-file-button processing-cancel-button" type="button" onClick={onCancel}>取消處理</button>
      </div>
    </div>
  );
}
