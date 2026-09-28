import type { ReactNode } from 'react';

/** Presentation only: callers retain all source validation and output gates. */
export function GuidedWorkbench({ title, titleId, fileName, preview, children, actions, processing = false }: {
  readonly title: string;
  readonly titleId: string;
  readonly fileName: string;
  readonly preview?: ReactNode;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly processing?: boolean;
}) {
  return <section className={`converter-card guided-workbench ${processing ? `processing-card ${preview ? 'has-preview' : ''}` : 'material-card'}`} aria-labelledby={titleId}>
    <div className="material-heading guided-heading">
      <p className="eyebrow">3D → LASER CUT</p>
      <h1 id={titleId}>{title}</h1>
      <p className="file-name">模型：{fileName}</p>
    </div>
    <div className={`guided-preview ${processing ? 'processing-viewport' : 'material-presentation-preview'}`}>
      {preview ?? <div className="guided-preview-placeholder"><strong>模型預覽</strong><p>模型幾何準備好後會在這裏顯示。</p></div>}
    </div>
    {children}
    <div className="guided-action-bar" aria-label="製作操作">{actions}</div>
  </section>;
}
