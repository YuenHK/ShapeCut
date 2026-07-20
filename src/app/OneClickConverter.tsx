import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  AutomaticOutlineError,
  type AutomaticOutlineProgressStage,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import { SupersededError } from '../workers/geometry-client';
import { MAX_STL_BYTES } from '../domain/mesh/parse-stl';

export type DownloadFile = { readonly href: string; readonly fileName: string };
export type OutlineDownloads = {
  readonly zip: DownloadFile;
  readonly svg: DownloadFile;
  readonly dxf: DownloadFile;
  readonly pdf: DownloadFile;
  readonly json: DownloadFile;
};

export type OneClickViewState =
  | { readonly kind: 'upload' }
  | { readonly kind: 'processing'; readonly fileName: string; readonly stage: AutomaticOutlineProgressStage }
  | { readonly kind: 'result'; readonly fileName: string; readonly result: AutomaticOutlineResult; readonly downloads: OutlineDownloads }
  | { readonly kind: 'failure'; readonly fileName?: string; readonly message: string };

export type OneClickConverterServices = {
  readonly convert: (
    bytes: ArrayBuffer,
    onProgress?: (stage: AutomaticOutlineProgressStage) => void | Promise<void>,
  ) => Promise<AutomaticOutlineResult>;
  readonly package: (result: AutomaticOutlineResult, fileName?: string) => Promise<OutlineDownloads>;
  readonly cancel: () => void;
};

const STAGES: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
const STAGE_LABELS: Record<AutomaticOutlineProgressStage, string> = {
  reading: '模型已讀取',
  analyzing: '正在分析模型',
  simplifying: '正在簡化',
  slicing: '正在產生切片',
  packaging: '正在準備下載',
};

function failureMessage(error: unknown): string {
  if (error instanceof AutomaticOutlineError) {
    return {
      INVALID_STL: '這個檔案不是可讀取的 STL，請選擇另一個模型。',
      NO_OUTLINE: '找不到足夠的有效外形，請嘗試另一個模型。',
      RESOURCE_LIMIT: '模型太複雜，超出這次可處理的上限。請先簡化模型再試。',
      TIME_LIMIT: '處理時間過長，已安全停止。請先簡化模型再試。',
    }[error.code];
  }
  return '轉換未能完成，請選擇另一個 STL 再試。';
}

function revokeDownloads(downloads: OutlineDownloads | undefined): void {
  if (!downloads) return;
  if (typeof URL.revokeObjectURL !== 'function') return;
  for (const item of Object.values(downloads)) URL.revokeObjectURL(item.href);
}

function readFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

type OutlinePresentation = {
  readonly viewBox: string;
  readonly width: string;
  readonly height: string;
  readonly totalZ: string;
  readonly paths: readonly string[];
};

function finiteDisplay(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Number(value.toFixed(2)).toString();
}

function outlinePresentation(result: AutomaticOutlineResult): OutlinePresentation | undefined {
  if (result.layers.length === 0) return undefined;
  if (result.layers.some((layer) => !layer?.sourceBoundsMm || !Array.isArray(layer.contour?.outer))) return undefined;
  const values = result.layers.flatMap((layer) => [
    layer.sourceBoundsMm.minX, layer.sourceBoundsMm.minY,
    layer.sourceBoundsMm.maxX, layer.sourceBoundsMm.maxY,
    layer.zStart, layer.zEnd,
    ...layer.contour.outer.flat(),
  ]);
  if (!values.every(Number.isFinite)) return undefined;
  const minX = Math.min(...result.layers.map((layer) => layer.sourceBoundsMm.minX));
  const minY = Math.min(...result.layers.map((layer) => layer.sourceBoundsMm.minY));
  const maxX = Math.max(...result.layers.map((layer) => layer.sourceBoundsMm.maxX));
  const maxY = Math.max(...result.layers.map((layer) => layer.sourceBoundsMm.maxY));
  const minZ = Math.min(...result.layers.map((layer) => layer.zStart));
  const maxZ = Math.max(...result.layers.map((layer) => layer.zEnd));
  const width = finiteDisplay(maxX - minX);
  const height = finiteDisplay(maxY - minY);
  const totalZ = finiteDisplay(maxZ - minZ);
  if (!width || !height || !totalZ || Number(width) <= 0 || Number(height) <= 0) return undefined;
  const paths: string[] = [];
  for (const layer of result.layers) {
    const commands: string[] = [];
    for (const [index, [x, y]] of layer.contour.outer.entries()) {
      const previewX = finiteDisplay(x - minX), previewY = finiteDisplay(maxY - y);
      if (previewX === undefined || previewY === undefined) return undefined;
      commands.push(`${index === 0 ? 'M' : 'L'} ${previewX} ${previewY}`);
    }
    paths.push(`${commands.join(' ')} Z`);
  }
  return { viewBox: `0 0 ${width} ${height}`, width, height, totalZ, paths };
}

function ModelInput({ compact = false, onFile }: { readonly compact?: boolean; readonly onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const select = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    event.target.value = '';
  };
  if (compact) return (
    <label className="change-file-button">
      更換模型
      <input ref={input} className="visually-hidden" type="file" accept=".stl,model/stl" aria-label="選擇 STL 模型" onChange={select} />
    </label>
  );
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
      <span className="upload-icon" aria-hidden="true">↑</span>
      <strong>拖放 STL 到這裏</strong>
      <span>或</span>
      <span className="select-file-button">選擇模型</span>
      <input ref={input} className="visually-hidden" type="file" accept=".stl,model/stl" aria-label="選擇 STL 模型" onChange={select} />
      <small>檔案只在你的瀏覽器內處理，不會上載到伺服器。</small>
    </label>
  );
}

export function OneClickConverter({ services }: { readonly services: OneClickConverterServices }) {
  const [view, setView] = useState<OneClickViewState>({ kind: 'upload' });
  const requestId = useRef(0);
  const downloadsRef = useRef<OutlineDownloads | undefined>(undefined);

  const releaseCurrentDownloads = useCallback(() => {
    revokeDownloads(downloadsRef.current);
    downloadsRef.current = undefined;
  }, []);

  useEffect(() => () => {
    requestId.current += 1;
    services.cancel();
    releaseCurrentDownloads();
  }, [releaseCurrentDownloads, services]);

  const processFile = useCallback(async (file: File) => {
    const current = ++requestId.current;
    services.cancel();
    releaseCurrentDownloads();
    if (file.size > MAX_STL_BYTES) {
      setView({ kind: 'failure', fileName: file.name, message: failureMessage(new AutomaticOutlineError('RESOURCE_LIMIT', '模型超出安全處理資源上限')) });
      return;
    }
    setView({ kind: 'processing', fileName: file.name, stage: 'reading' });
    let lastProgressIndex = 0;
    try {
      const bytes = await readFile(file);
      if (current !== requestId.current) return;
      const result = await services.convert(bytes, (stage) => {
        const nextProgressIndex = STAGES.indexOf(stage);
        if (current !== requestId.current || nextProgressIndex < lastProgressIndex) return;
        lastProgressIndex = nextProgressIndex;
        setView({ kind: 'processing', fileName: file.name, stage });
      });
      if (current !== requestId.current) return;
      const downloads = await services.package(result, file.name);
      if (current !== requestId.current) {
        revokeDownloads(downloads);
        return;
      }
      downloadsRef.current = downloads;
      setView({ kind: 'result', fileName: file.name, result, downloads });
    } catch (error) {
      if (current !== requestId.current || error instanceof SupersededError) return;
      setView({ kind: 'failure', fileName: file.name, message: failureMessage(error) });
    }
  }, [releaseCurrentDownloads, services]);

  const reset = () => {
    requestId.current += 1;
    services.cancel();
    releaseCurrentDownloads();
    setView({ kind: 'upload' });
  };

  if (view.kind === 'upload') return (
    <section className="converter-card upload-card" aria-labelledby="converter-title">
      <div className="hero-copy">
        <p className="eyebrow">一鍵轉換工具</p>
        <h1 id="converter-title">把 3D 模型變成 Laser Cut 切片</h1>
        <p>放入 STL，ShapeCut 會自動分析、簡化和切片，然後準備好通用外形檔案。</p>
      </div>
      <ModelInput onFile={(file) => void processFile(file)} />
      <ul className="feature-list" aria-label="處理特點">
        <li>自動保留主要外形</li><li>適合多種材料堆疊</li><li>一次下載所有格式</li>
      </ul>
    </section>
  );

  if (view.kind === 'processing') {
    const active = STAGES.indexOf(view.stage);
    return (
      <section className="converter-card processing-card" aria-labelledby="processing-title">
        <div className="spinner" aria-hidden="true" />
        <h1 id="processing-title">正在處理你的模型</h1>
        <p className="file-name">{view.fileName}</p>
        <div role="status" aria-live="polite" className="progress-status">
          <strong>{STAGE_LABELS[view.stage]}</strong>
          <progress value={active + 1} max={STAGES.length} aria-label="轉換進度" />
          <ol className="stage-list">
            {STAGES.map((stage, index) => <li key={stage} className={index <= active ? 'complete' : ''}>{STAGE_LABELS[stage]}</li>)}
          </ol>
        </div>
        <ModelInput compact onFile={(file) => void processFile(file)} />
      </section>
    );
  }

  if (view.kind === 'failure') return (
    <section className="converter-card failure-card" aria-labelledby="failure-title">
      <div className="result-symbol failure" aria-hidden="true">!</div>
      <div role="alert">
        <p className="result-badge failure">失敗</p>
        <h1 id="failure-title">這次未能完成</h1>
        <p>{view.message}</p>
      </div>
      <button className="primary-button" type="button" onClick={reset}>選擇另一個模型</button>
    </section>
  );

  const { result, downloads } = view;
  const warning = result.status === 'warning';
  const simplified = result.mode === 'outline-2.5d';
  const presentation = outlinePresentation(result);
  return (
    <section className="converter-card result-card" aria-labelledby="result-title">
      <div className="result-heading">
        <div className={`result-symbol ${warning ? 'warning' : 'success'}`} aria-hidden="true">{warning ? '!' : '✓'}</div>
        <div role="status" aria-live="polite">
          <p className={`result-badge ${warning ? 'warning' : 'success'}`}>{warning ? '需注意' : '成功'}</p>
          <h1 id="result-title">轉換完成</h1>
          <p className="file-name">{view.fileName}</p>
        </div>
      </div>
      {warning && simplified && <div className="warning-panel"><strong>已簡化模型</strong><p>內部細節、孔洞及細小分離零件已被忽略。不同材料厚度會改變堆疊後高度；正式製作前請先試切。</p></div>}
      {warning && !simplified && <div className="warning-panel"><strong>處理提示</strong><ul>{result.warnings.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      <div className="result-grid">
        <div className="outline-preview">
          {presentation ? <svg role="img" aria-label="實際外形切片預覽" viewBox={presentation.viewBox} preserveAspectRatio="xMidYMid meet">
            <title>每層已驗證外形的疊加預覽</title>
            {presentation.paths.map((path, index) => <path key={result.layers[index].id} d={path} vectorEffect="non-scaling-stroke" />)}
          </svg> : <p>無法顯示有限尺寸預覽</p>}
        </div>
        <dl className="result-summary">
          <div><dt>處理方式</dt><dd>{result.mode === 'exact' ? '精確切片' : '2.5D 外形'}</dd></div>
          <div><dt>切片數量</dt><dd>{result.layers.length} 層</dd></div>
          <div><dt>平面尺寸 X × Y</dt><dd>{presentation ? `${presentation.width} × ${presentation.height} mm` : '不可用'}</dd></div>
          <div><dt>原始 Z 範圍</dt><dd>{presentation ? `總高度 ${presentation.totalZ} mm` : '不可用'}</dd></div>
          <div><dt>輸出內容</dt><dd>通用切割外形</dd></div>
        </dl>
      </div>
      <a className="primary-button download-primary" href={downloads.zip.href} download={downloads.zip.fileName}>下載 ZIP 製作套件</a>
      <nav className="secondary-downloads" aria-label="其他下載格式">
        {(['svg', 'dxf', 'pdf', 'json'] as const).map((kind) => <a key={kind} href={downloads[kind].href} download={downloads[kind].fileName}>下載 {kind.toUpperCase()}</a>)}
      </nav>
      <details className="technical-details">
        <summary onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          const details = event.currentTarget.parentElement as HTMLDetailsElement;
          details.open = !details.open;
        }}>技術資料</summary>
        <dl>
          <div><dt>模式</dt><dd>{result.mode}</dd></div>
          <div><dt>狀態</dt><dd>{result.status}</dd></div>
          <div><dt>來源 fingerprint</dt><dd><code>{result.sourceHash}</code></dd></div>
          <div><dt>切片數量</dt><dd>{result.layers.length}</dd></div>
          <div><dt>原始三角形</dt><dd>{result.diagnostics.topology.triangleCount}</dd></div>
          <div><dt>修復決定</dt><dd>{result.diagnostics.repairDecision === 'accepted' ? '已接受安全修復' : '使用原始模型投影'}</dd></div>
          <div><dt>Raster cell</dt><dd>{result.diagnostics.rasterCellSizeMm === null ? '精確模式不適用' : `${result.diagnostics.rasterCellSizeMm} mm`}</dd></div>
          <div><dt>最大外形偏差</dt><dd>{`${(Math.max(...result.diagnostics.layers.map((item) => Math.max(item.boundsDriftRatio, item.areaDriftRatio))) * 100).toFixed(2)}%`}</dd></div>
        </dl>
        <h2>處理提示</h2>
        {result.warnings.length > 0 ? <ul>{result.warnings.map((item) => <li key={item}>{item}</li>)}</ul> : <p>沒有額外提示。</p>}
        <p>完整診斷、層次和來源資料亦已收錄於 JSON manifest。</p>
      </details>
      <ModelInput compact onFile={(file) => void processFile(file)} />
    </section>
  );
}
