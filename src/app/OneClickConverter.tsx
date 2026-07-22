import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  AutomaticOutlineError,
  type AutomaticOutlineProgressEvent,
  type AutomaticOutlineProgressStage,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import type { OutlinePreviewPayload } from '../domain/outline-features/types';
import { SupersededError } from '../workers/geometry-client';
import { OutlineArtifactError, type OutlineArtifactId } from '../workers/geometry-api';
import { MAX_STL_BYTES } from '../domain/mesh/parse-stl';
import { OutlineProcessViewport } from '../preview/OutlineProcessViewport';
import { shutdownOutlineProcessRendererPool, warmOutlineProcessRenderer } from '../preview/outline-process-scene';

export type DownloadFile = { readonly href: string; readonly fileName: string };
export type OutlineDownloads = {
  readonly zip: DownloadFile;
  readonly svg: DownloadFile;
  readonly dxf: DownloadFile;
  readonly previewPdf: DownloadFile;
  readonly explodedPdf: DownloadFile;
};

export type OneClickViewState =
  | { readonly kind: 'upload' }
  | { readonly kind: 'processing'; readonly fileName: string; readonly stage: AutomaticOutlineProgressStage; readonly preview?: OutlinePreviewPayload }
  | { readonly kind: 'result'; readonly fileName: string; readonly result: AutomaticOutlineResult; readonly downloads: OutlineDownloads }
  | {
    readonly kind: 'failure';
    readonly fileName?: string;
    readonly message: string;
    readonly artifact?: OutlineArtifactId;
    readonly result?: AutomaticOutlineResult;
    readonly preview?: OutlinePreviewPayload;
  };

export type OneClickConverterServices = {
  readonly convert: (
    bytes: ArrayBuffer,
    onProgress?: (event: AutomaticOutlineProgressEvent) => void | Promise<void>,
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
  if (error instanceof OutlineArtifactError) {
    return '輸出檔案未能完成；模型分析及安全提示已保留。';
  }
  return '轉換未能完成，請選擇另一個 STL 再試。';
}

const ARTIFACT_LABELS: Readonly<Record<OutlineArtifactId, string>> = Object.freeze({
  'colored-outline-document': '所有輸出檔案',
  'cut-and-engrave.svg': 'cut-and-engrave.svg',
  'cut-and-engrave.dxf': 'cut-and-engrave.dxf',
  'preview.pdf': 'preview.pdf',
  'exploded-view.pdf': 'exploded-view.pdf',
  'shapecut-files.zip': 'shapecut-files.zip',
  'package-verification': '輸出套件驗證',
});

function revokeDownloads(downloads: OutlineDownloads | undefined): void {
  if (!downloads) return;
  if (typeof URL.revokeObjectURL !== 'function') return;
  for (const item of Object.values(downloads)) {
    try { URL.revokeObjectURL(item.href); } catch { /* Continue revoking the remaining owned URLs. */ }
  }
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
  readonly width: string;
  readonly height: string;
  readonly totalZ: string;
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
  return { width, height, totalZ };
}

const PROJECTED_WARNING_SUMMARIES = new Set([
  '已簡化模型',
  '原始內部細節、孔洞及細小分離零件已被忽略',
  '不同材料厚度會改變堆疊後高度',
  '輸出不包含雷射功率或速度',
]);

function omittedFeatureMessage(label: string, omitted: number, total: number): string | undefined {
  if (omitted === 0 || total === 0) return undefined;
  return `${omitted === total ? '所有' : '部分'}切片未${label}。`;
}

function presentationWarnings(result: AutomaticOutlineResult): readonly string[] {
  const total = result.coloredLayers.length;
  const warnings: string[] = [];
  if (result.mode === 'outline-2.5d') {
    warnings.push('模型已使用 2.5D 外形簡化；內部結構及細小分離零件不會成為切割線。');
  }
  const missingHole = result.coloredLayers.filter((layer) => !layer.centralHole || layer.diagnostics.hole.status !== 'retained').length;
  const missingDeep = result.coloredLayers.filter((layer) => !layer.deepFeature).length;
  const missingLight = result.coloredLayers.filter((layer) => !layer.lightFeature).length;
  const hole = omittedFeatureMessage('偵測到可靠中央孔；輸出已省略該孔線', missingHole, total);
  const deep = omittedFeatureMessage('保留較深層紅色特徵', missingDeep, total);
  const light = omittedFeatureMessage('保留較淺層藍色特徵', missingLight, total);
  if (hole) warnings.push(hole);
  if (deep) warnings.push(deep);
  if (light) warnings.push(light);
  warnings.push(...result.warnings.filter((item) => !PROJECTED_WARNING_SUMMARIES.has(item)));
  warnings.push(...result.featureWarnings.filter((item) => (
    !/reliable central axle hole/i.test(item)
    && !/省略雕刻特徵/.test(item)
  )));
  return [...new Set(warnings)];
}

function measurementRange(values: readonly number[]): string | undefined {
  const finite = [...new Set(values.filter((value) => Number.isFinite(value) && value >= 0).map((value) => Number(value.toFixed(2))))]
    .sort((left, right) => left - right);
  if (finite.length === 0) return undefined;
  if (finite.length === 1) return `${finite[0]} mm`;
  return `${finite[0]}–${finite[finite.length - 1]} mm`;
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

  useEffect(() => {
    warmOutlineProcessRenderer();
    return shutdownOutlineProcessRendererPool;
  }, []);

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
    let latestPreview: OutlinePreviewPayload | undefined;
    let completedResult: AutomaticOutlineResult | undefined;
    try {
      const bytes = await readFile(file);
      if (current !== requestId.current) return;
      const result = await services.convert(bytes, (event) => {
        const nextProgressIndex = STAGES.indexOf(event.stage);
        if (current !== requestId.current || nextProgressIndex < lastProgressIndex) return;
        lastProgressIndex = nextProgressIndex;
        if ('preview' in event) latestPreview = event.preview;
        setView({ kind: 'processing', fileName: file.name, stage: event.stage, preview: latestPreview });
      });
      if (current !== requestId.current) return;
      completedResult = result;
      const downloads = await services.package(result, file.name);
      if (current !== requestId.current) {
        revokeDownloads(downloads);
        return;
      }
      downloadsRef.current = downloads;
      setView({ kind: 'result', fileName: file.name, result, downloads });
    } catch (error) {
      if (current !== requestId.current || error instanceof SupersededError) return;
      const artifact = completedResult
        ? error instanceof OutlineArtifactError ? error.artifact : 'package-verification'
        : undefined;
      setView({
        kind: 'failure',
        fileName: file.name,
        message: failureMessage(error),
        ...(artifact ? { artifact } : {}),
        ...(completedResult ? {
          result: completedResult,
          preview: completedResult.preview,
        } : {}),
      });
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
      <section className={`converter-card processing-card ${view.preview ? 'has-preview' : ''}`} aria-labelledby="processing-title">
        {view.preview ? (
          <>
            <div className="processing-viewport">
              <OutlineProcessViewport payload={view.preview} stage={view.stage} />
            </div>
            <div className="processing-status-overlay" role="status" aria-live="polite">
              <strong id="processing-title">{STAGE_LABELS[view.stage]}</strong>
              <span className="file-name">{view.fileName}</span>
              <progress value={active + 1} max={STAGES.length} aria-label="轉換進度" />
            </div>
          </>
        ) : (
          <div className="processing-loading-panel" role="status" aria-live="polite">
            <div className="neutral-loading" aria-hidden="true"><span /><span /><span /></div>
            <h1 id="processing-title">正在讀取模型</h1>
            <p className="file-name">{view.fileName}</p>
          </div>
        )}
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
        {view.artifact && <p>受影響輸出：<strong>{ARTIFACT_LABELS[view.artifact]}</strong></p>}
      </div>
      {view.preview && (
        <div className="result-viewport failure-retained-preview">
          <OutlineProcessViewport payload={view.preview} stage="packaging" />
        </div>
      )}
      {view.result && presentationWarnings(view.result).length > 0 && (
        <section className="warning-panel" aria-label="模型處理提示">
          <strong>已保留的處理提示</strong>
          <ul>{presentationWarnings(view.result).map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
      <button className="primary-button" type="button" onClick={reset}>選擇另一個模型</button>
    </section>
  );

  const { result, downloads } = view;
  const warnings = presentationWarnings(result);
  const warning = result.status === 'warning' || warnings.length > 0;
  const presentation = outlinePresentation(result);
  const holeDiameter = measurementRange(result.coloredLayers.flatMap((layer) => (
    layer.centralHole && layer.diagnostics.hole.status === 'retained'
      ? [layer.diagnostics.hole.equivalentDiameterMm]
      : []
  )));
  const redThreshold = measurementRange(result.coloredLayers.flatMap((layer) => (
    layer.deepFeature ? [layer.diagnostics.depth.redThresholdMm] : []
  )));
  const blueThreshold = measurementRange(result.coloredLayers.flatMap((layer) => (
    layer.lightFeature ? [layer.diagnostics.depth.blueThresholdMm] : []
  )));
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
      {warnings.length > 0 && (
        <section className="warning-panel" aria-label="模型處理提示">
          <strong>處理提示</strong>
          <ul>{warnings.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      )}
      <div className="result-grid">
        <div className="result-viewport">
          <OutlineProcessViewport payload={result.preview} stage="result" />
        </div>
        <dl className="result-summary">
          <div><dt>處理方式</dt><dd>{result.mode === 'exact' ? '精確切片' : '2.5D 外形'}</dd></div>
          <div><dt>切片數量</dt><dd>{result.layers.length} 層</dd></div>
          <div><dt>平面尺寸 X × Y</dt><dd>{presentation ? `${presentation.width} × ${presentation.height} mm` : '不可用'}</dd></div>
          <div><dt>原始 Z 範圍</dt><dd>{presentation ? `總高度 ${presentation.totalZ} mm` : '不可用'}</dd></div>
          <div><dt>輸出內容</dt><dd>切割外形與相對深淺層級</dd></div>
        </dl>
      </div>
      <div className="color-legend" aria-label="相對顏色圖例">
        <strong>顏色圖例</strong>
        <ul>
          <li><span className="legend-swatch black" aria-hidden="true" />黑色：切割外框及中央孔</li>
          <li><span className="legend-swatch red" aria-hidden="true" />紅色：相對較深層特徵</li>
          <li><span className="legend-swatch blue" aria-hidden="true" />藍色：相對較淺層特徵</li>
        </ul>
        <p>顏色只表示相對深淺層級，不代表實際雷射功率、速度或走刀次數。</p>
      </div>
      <a className="primary-button download-primary" href={downloads.zip.href} download={downloads.zip.fileName}>下載 ZIP 製作套件</a>
      <nav className="secondary-downloads" aria-label="其他下載格式">
        {([
          ['svg', 'SVG'], ['dxf', 'DXF'], ['previewPdf', '平面預覽 PDF'], ['explodedPdf', '爆炸圖 PDF'],
        ] as const).map(([kind, label]) => <a key={kind} href={downloads[kind].href} download={downloads[kind].fileName}>下載 {label}</a>)}
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
          {holeDiameter && <div><dt>偵測中央孔直徑</dt><dd>{holeDiameter}</dd></div>}
          {redThreshold && <div><dt>紅色深層門檻</dt><dd>{redThreshold}</dd></div>}
          {blueThreshold && <div><dt>藍色淺層門檻</dt><dd>{blueThreshold}</dd></div>}
        </dl>
        <h2>處理提示</h2>
        {warnings.length > 0 ? <ul>{warnings.map((item) => <li key={item}>{item}</li>)}</ul> : <p>沒有額外提示。</p>}
        <p>ZIP 只內含 cut-and-engrave.svg、cut-and-engrave.dxf、preview.pdf 及 exploded-view.pdf 四項檔案。</p>
      </details>
      <ModelInput compact onFile={(file) => void processFile(file)} />
    </section>
  );
}
