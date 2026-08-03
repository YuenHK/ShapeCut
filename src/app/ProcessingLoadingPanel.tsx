import { useEffect, useRef, useState } from 'react';

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
}

function elapsedLabel(startedAt: number): string {
  const totalSeconds = elapsedSeconds(startedAt);
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
  const [announcement, setAnnouncement] = useState(
    () => `${title}，${elapsedLabel(startedAt)}`,
  );
  const titleRef = useRef(title);
  const announcedBucketRef = useRef(Math.floor(elapsedSeconds(startedAt) / 30));
  titleRef.current = title;

  useEffect(() => {
    announcedBucketRef.current = Math.floor(elapsedSeconds(startedAt) / 30);
    const updateElapsed = () => {
      const nextElapsed = elapsedLabel(startedAt);
      const nextBucket = Math.floor(elapsedSeconds(startedAt) / 30);
      setElapsed(nextElapsed);
      if (nextBucket !== announcedBucketRef.current) {
        announcedBucketRef.current = nextBucket;
        setAnnouncement(`${titleRef.current}，${nextElapsed}`);
      }
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    setAnnouncement(`${title}，${elapsedLabel(startedAt)}`);
  }, [startedAt, title]);

  return (
    <div className="processing-loading-panel">
      <div className="neutral-loading" aria-hidden="true"><span /><span /><span /></div>
      <div className="processing-message">
        <div className="processing-orbit" aria-hidden="true" />
        <h1 id={titleId}>{title}</h1>
        <p className="file-name">{fileName}</p>
        <p className="processing-elapsed">{elapsed}</p>
        <span className="visually-hidden processing-elapsed-announcement" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
        <button className="change-file-button processing-cancel-button" type="button" onClick={onCancel}>取消處理</button>
      </div>
    </div>
  );
}
