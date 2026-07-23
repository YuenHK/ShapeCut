import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
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
import { DEFAULT_PENDING_MATERIAL_PROFILES } from '../domain/materials/default-profiles';
import {
  manufacturingGeometryProfile,
  type ManufacturingGeometryProfile,
} from '../domain/materials/manufacturing-profile';
import { classifyMaterialReadiness, type MaterialProfileV1 } from '../domain/materials/schema';
import {
  OutlineProcessViewport,
} from '../preview/OutlineProcessViewport';
import { shutdownOutlineProcessRendererPool, warmOutlineProcessRenderer } from '../preview/outline-process-scene';
import { createStlPresentationPayload } from '../preview/stl-presentation';
import {
  createProcessingTimeline,
  type ProcessingTimeline,
  type ProcessingTimelineClock,
} from './processing-timeline';
import { AppleWorkbench } from './AppleWorkbench';
import { MotionSurface } from './MotionSurface';
import { useEffectLevel, type EffectLevel } from './effect-level';

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
  | { readonly kind: 'reading'; readonly fileName: string }
  | { readonly kind: 'material'; readonly fileName: string; readonly bytes: ArrayBuffer }
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
    material: ManufacturingGeometryProfile,
    onProgress?: (event: AutomaticOutlineProgressEvent) => void | Promise<void>,
  ) => Promise<AutomaticOutlineResult>;
  readonly package: (result: AutomaticOutlineResult, fileName?: string) => Promise<OutlineDownloads>;
  readonly cancel: () => void;
  /** Test seam; production uses the cancellable wall-clock presentation timeline. */
  readonly createTimeline?: (clock: ProcessingTimelineClock<number>) => ProcessingTimeline;
  /** Saved profiles supplied by the app's material store. Invalid profiles are never displayed. */
  readonly materialProfiles?: readonly MaterialProfileV1[];
};

const STAGES: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
const STAGE_LABELS: Record<AutomaticOutlineProgressStage, string> = {
  reading: '模型已讀取',
  analyzing: '正在分析模型',
  simplifying: '正在簡化',
  slicing: '正在產生切片',
  packaging: '正在準備下載',
};

function selectableMaterials(savedProfiles: readonly MaterialProfileV1[] = []): readonly ManufacturingGeometryProfile[] {
  const seen = new Set<string>();
  return [...DEFAULT_PENDING_MATERIAL_PROFILES, ...savedProfiles].flatMap((profile) => {
    if (seen.has(profile.id)) return [];
    seen.add(profile.id);
    if (classifyMaterialReadiness(profile).status !== 'ready') return [];
    return [manufacturingGeometryProfile(profile)];
  });
}

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
  const missingDeep = result.coloredLayers.filter((layer) => layer.deepFeatures.length === 0).length;
  const missingLight = result.coloredLayers.filter((layer) => layer.lightFeatures.length === 0).length;
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

function launcherSummary(status: AutomaticOutlineResult['assembly']['launcher']['status']): string {
  if (status === 'detected') return '已偵測原機幾何';
  if (status === 'fallback') return '後備樣板';
  return '已安全省略';
}

type ModelInputProps = Readonly<{
  compact?: boolean;
  dragActive?: boolean;
  level: EffectLevel;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
  onFile: (file: File) => void;
}>;

function ModelInput({
  compact = false,
  dragActive = false,
  level,
  onDragEnter,
  onDragLeave,
  onDrop,
  onFile,
}: ModelInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLLabelElement>(null);
  const clearDragAttraction = useCallback(() => {
    zone.current?.style.removeProperty('--drag-attract-x');
    zone.current?.style.removeProperty('--drag-attract-y');
  }, []);
  const updateDragAttraction = useCallback((event: DragEvent<HTMLLabelElement>) => {
    if (level === 'static') {
      clearDragAttraction();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(-12, Math.min(12, (event.clientX - (bounds.left + bounds.width / 2)) * 0.08));
    const y = Math.max(-12, Math.min(12, (event.clientY - (bounds.top + bounds.height / 2)) * 0.08));
    event.currentTarget.style.setProperty('--drag-attract-x', `${Number(x.toFixed(2))}px`);
    event.currentTarget.style.setProperty('--drag-attract-y', `${Number(y.toFixed(2))}px`);
  }, [clearDragAttraction, level]);
  useEffect(() => {
    if (!dragActive || level === 'static') clearDragAttraction();
  }, [clearDragAttraction, dragActive, level]);
  useEffect(() => {
    const element = zone.current;
    return () => {
      element?.style.removeProperty('--drag-attract-x');
      element?.style.removeProperty('--drag-attract-y');
    };
  }, []);
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
    clearDragAttraction();
    onDrop?.();
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <label
      ref={zone}
      className="upload-zone"
      data-drag-active={String(dragActive)}
      onDragEnter={(event) => {
        event.preventDefault();
        updateDragAttraction(event);
        onDragEnter?.();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        onDragLeave?.();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        updateDragAttraction(event);
      }}
      onDrop={drop}
    >
      <span className="upload-icon" aria-hidden="true">↑</span>
      <strong>拖放 STL 到這裏</strong>
      <span>或</span>
      <span className="select-file-button">選擇模型</span>
      <input ref={input} className="visually-hidden" type="file" accept=".stl,model/stl" aria-label="選擇 STL 模型" onChange={select} />
      <small>檔案只在你的瀏覽器內處理，不會上載到伺服器。</small>
    </label>
  );
}

export function OneClickConverter({
  services,
  chromeTarget,
}: {
  readonly services: OneClickConverterServices;
  readonly chromeTarget?: Element | null;
}) {
  const [view, setView] = useState<OneClickViewState>({ kind: 'upload' });
  const [dragActive, setDragActive] = useState(false);
  const [presentationPreview, setPresentationPreview] = useState<OutlinePreviewPayload | undefined>(undefined);
  const effectLevel = useEffectLevel(view.kind === 'processing');
  const materials = selectableMaterials(services.materialProfiles);
  const requestId = useRef(0);
  const downloadsRef = useRef<OutlineDownloads | undefined>(undefined);
  const timelineRef = useRef<ProcessingTimeline | undefined>(undefined);
  const dragDepthRef = useRef(0);
  const runtimeServices = useMemo(() => ({
    convert: services.convert,
    package: services.package,
    cancel: services.cancel,
    createTimeline: services.createTimeline,
  }), [services.cancel, services.convert, services.createTimeline, services.package]);

  const clearDrag = useCallback(() => {
    dragDepthRef.current = 0;
    setDragActive(false);
  }, []);

  const enterDrag = useCallback(() => {
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  const leaveDrag = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  const clearPresentationPreview = useCallback(() => {
    setPresentationPreview(undefined);
  }, []);

  const schedulePresentationPreview = useCallback((bytes: ArrayBuffer, current: number) => {
    queueMicrotask(() => {
      if (current !== requestId.current) return;
      try {
        const preview = createStlPresentationPayload(bytes);
        if (current === requestId.current) setPresentationPreview(preview);
      } catch {
        if (current === requestId.current) setPresentationPreview(undefined);
      }
    });
  }, []);

  useEffect(() => {
    warmOutlineProcessRenderer();
    return shutdownOutlineProcessRendererPool;
  }, []);

  const releaseCurrentDownloads = useCallback(() => {
    revokeDownloads(downloadsRef.current);
    downloadsRef.current = undefined;
  }, []);

  useEffect(() => () => {
    dragDepthRef.current = 0;
    requestId.current += 1;
    timelineRef.current?.cancel();
    timelineRef.current = undefined;
    runtimeServices.cancel();
    releaseCurrentDownloads();
  }, [releaseCurrentDownloads, runtimeServices]);

  useEffect(() => {
    if (!presentationPreview) return;
    if ((view.kind === 'processing' && view.preview)
      || view.kind === 'result'
      || (view.kind === 'failure' && view.preview)) {
      clearPresentationPreview();
    }
  }, [clearPresentationPreview, presentationPreview, view]);

  const processFile = useCallback(async (fileName: string, bytes: ArrayBuffer, material: ManufacturingGeometryProfile) => {
    const current = ++requestId.current;
    timelineRef.current?.cancel();
    releaseCurrentDownloads();
    let latestPreview: OutlinePreviewPayload | undefined;
    let completedResult: AutomaticOutlineResult | undefined;
    let ownedDownloads: OutlineDownloads | undefined;
    let workerFinished = false;
    const timeline = (runtimeServices.createTimeline ?? createProcessingTimeline)({
      now: () => Date.now(),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
      onStage: (stage, preview) => {
        if (current !== requestId.current) return;
        setView({ kind: 'processing', fileName, stage, ...(preview ? { preview } : {}) });
      },
    });
    timelineRef.current = timeline;
    timeline.advance('reading');
    try {
      const result = await runtimeServices.convert(bytes, material, (event) => {
        if (current !== requestId.current || workerFinished) return;
        if ('preview' in event) latestPreview = event.preview;
        timeline.advance(event.stage, latestPreview);
      });
      if (current !== requestId.current) return;
      workerFinished = true;
      completedResult = result;
      const packaged = runtimeServices.package(result, fileName).then((downloads) => {
        if (current !== requestId.current) {
          revokeDownloads(downloads);
          throw new SupersededError(current);
        }
        ownedDownloads = downloads;
        downloadsRef.current = downloads;
        return downloads;
      });
      const [, downloads] = await Promise.all([timeline.finish(), packaged]);
      if (current !== requestId.current) {
        if (downloadsRef.current === downloads) releaseCurrentDownloads();
        else revokeDownloads(downloads);
        return;
      }
      if (timelineRef.current === timeline) timelineRef.current = undefined;
      setView({ kind: 'result', fileName, result, downloads });
    } catch (error) {
      if (current !== requestId.current || error instanceof SupersededError) return;
      if (timelineRef.current === timeline) {
        timeline.cancel();
        timelineRef.current = undefined;
      }
      if (downloadsRef.current === ownedDownloads) releaseCurrentDownloads();
      const artifact = completedResult && error instanceof OutlineArtifactError
        ? error.artifact
        : undefined;
      setView({
        kind: 'failure',
        fileName,
        message: failureMessage(error),
        ...(artifact ? { artifact } : {}),
        ...(completedResult ? {
          result: completedResult,
          preview: completedResult.preview,
        } : {}),
      });
    }
  }, [releaseCurrentDownloads, runtimeServices]);

  const selectFile = useCallback(async (file: File) => {
    const current = ++requestId.current;
    clearPresentationPreview();
    timelineRef.current?.cancel();
    timelineRef.current = undefined;
    runtimeServices.cancel();
    releaseCurrentDownloads();
    if (!/\.stl$/iu.test(file.name)) {
      setView({ kind: 'failure', message: '只支援 STL 檔案，請選擇副檔名為 .stl 的模型。' });
      return;
    }
    if (file.size > MAX_STL_BYTES) {
      setView({ kind: 'failure', fileName: file.name, message: failureMessage(new AutomaticOutlineError('RESOURCE_LIMIT', '模型超出安全處理資源上限')) });
      return;
    }
    setView({ kind: 'reading', fileName: file.name });
    try {
      const bytes = await readFile(file);
      if (current !== requestId.current) return;
      setView({ kind: 'material', fileName: file.name, bytes });
      schedulePresentationPreview(bytes, current);
    } catch (error) {
      if (current !== requestId.current) return;
      setView({ kind: 'failure', fileName: file.name, message: failureMessage(error) });
    }
  }, [clearPresentationPreview, releaseCurrentDownloads, runtimeServices, schedulePresentationPreview]);

  const selectMaterial = useCallback((id: string) => {
    if (view.kind !== 'material') return;
    const material = materials.find((profile) => profile.id === id);
    if (material) void processFile(view.fileName, view.bytes, material);
  }, [materials, processFile, view]);

  const reset = () => {
    clearDrag();
    clearPresentationPreview();
    requestId.current += 1;
    timelineRef.current?.cancel();
    timelineRef.current = undefined;
    runtimeServices.cancel();
    releaseCurrentDownloads();
    setView({ kind: 'upload' });
  };

  const frame = (content: ReactNode, stage?: AutomaticOutlineProgressStage) => (
    <AppleWorkbench
      state={view.kind}
      stage={stage}
      fileName={'fileName' in view ? view.fileName : undefined}
      level={effectLevel}
      chromeTarget={chromeTarget}
    >
      {content}
    </AppleWorkbench>
  );

  if (view.kind === 'upload') return frame(
    <section className="converter-card upload-card" aria-labelledby="converter-title">
      <div className="hero-copy">
        <p className="eyebrow">一鍵轉換工具</p>
        <h1 id="converter-title">把 3D 模型變成 Laser Cut 切片</h1>
        <p>放入 STL，ShapeCut 會自動分析、簡化和切片，然後準備好通用外形檔案。</p>
      </div>
      <ModelInput
        level={effectLevel}
        dragActive={dragActive}
        onDragEnter={enterDrag}
        onDragLeave={leaveDrag}
        onDrop={clearDrag}
        onFile={(file) => void selectFile(file)}
      />
      <ul className="feature-list" aria-label="處理特點">
        <li>自動保留主要外形</li><li>適合多種材料堆疊</li><li>一次下載所有格式</li>
      </ul>
    </section>
  );

  if (view.kind === 'material') return frame(
    <section className="converter-card material-card" aria-labelledby="material-title">
      <p className="eyebrow">選擇製作材料</p>
      <h1 id="material-title">{view.fileName}</h1>
      <p>請選擇本次製作的材料，系統只會把所需的幾何資料傳送到處理程序。</p>
      {presentationPreview && (
        <div className="material-presentation-preview">
          <OutlineProcessViewport payload={presentationPreview} stage="reading" effectLevel={effectLevel} />
        </div>
      )}
      <label className="material-picker">製作材料
        <select aria-label="選擇製作材料" defaultValue="" onChange={(event) => selectMaterial(event.target.value)}>
          <option value="" disabled>選擇製作材料</option>
          {materials.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name} ({profile.thicknessMm} mm)</option>
          ))}
        </select>
      </label>
      <ModelInput compact level={effectLevel} onFile={(file) => void selectFile(file)} />
    </section>
  );

  if (view.kind === 'reading') return frame(
    <section className="converter-card processing-card" aria-labelledby="reading-title">
      <div className="processing-loading-panel" role="status" aria-live="polite">
        <div className="neutral-loading" aria-hidden="true"><span /><span /><span /></div>
        <h1 id="reading-title">正在讀取模型</h1>
        <p className="file-name">{view.fileName}</p>
      </div>
      <ModelInput compact level={effectLevel} onFile={(file) => void selectFile(file)} />
    </section>
  );

  if (view.kind === 'processing') {
    const active = STAGES.indexOf(view.stage);
    const visiblePreview = view.preview ?? presentationPreview;
    return frame(
      <section className={`converter-card processing-card ${visiblePreview ? 'has-preview' : ''}`} aria-labelledby="processing-title">
        {visiblePreview ? (
          <>
            <div className="processing-viewport">
              <OutlineProcessViewport
                payload={visiblePreview}
                stage={view.preview ? view.stage : 'reading'}
                effectLevel={effectLevel}
              />
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
        <ModelInput compact level={effectLevel} onFile={(file) => void selectFile(file)} />
      </section>,
      view.stage,
    );
  }

  if (view.kind === 'failure') {
    const retainedPreview = view.preview ?? presentationPreview;
    return frame(
      <section className="converter-card failure-card" aria-labelledby="failure-title">
        <div className="result-symbol failure" aria-hidden="true">!</div>
        <div role="alert">
          <p className="result-badge failure">失敗</p>
          <h1 id="failure-title">這次未能完成</h1>
          <p>{view.message}</p>
          {view.artifact && <p>受影響輸出：<strong>{ARTIFACT_LABELS[view.artifact]}</strong></p>}
        </div>
        {retainedPreview && (
          <div className="result-viewport failure-retained-preview">
            <OutlineProcessViewport
              payload={retainedPreview}
              stage={view.preview ? 'packaging' : 'reading'}
              effectLevel={effectLevel}
            />
          </div>
        )}
        {view.result && presentationWarnings(view.result).length > 0 && (
          <section className="warning-panel" aria-label="模型處理提示">
            <strong>已保留的處理提示</strong>
            <ul>{presentationWarnings(view.result).map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        )}
        <MotionSurface as="button" level={effectLevel} className="primary-button" type="button" onClick={reset}>
          選擇另一個模型
        </MotionSurface>
      </section>,
    );
  }

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
    layer.deepFeatures.length > 0 ? [layer.diagnostics.depth.redThresholdMm] : []
  )));
  const blueThreshold = measurementRange(result.coloredLayers.flatMap((layer) => (
    layer.lightFeatures.length > 0 ? [layer.diagnostics.depth.blueThresholdMm] : []
  )));
  const assembly = result.assembly;
  return frame(
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
          <OutlineProcessViewport payload={result.preview} stage="result" effectLevel={effectLevel} />
        </div>
        <dl className="result-summary">
          <div><dt>處理方式</dt><dd>{result.mode === 'exact' ? '精確切片' : '2.5D 外形'}</dd></div>
          <div><dt>切片數量</dt><dd>{result.layers.length} 層</dd></div>
          <div><dt>平面尺寸 X × Y</dt><dd>{presentation ? `${presentation.width} × ${presentation.height} mm` : '不可用'}</dd></div>
          <div><dt>原始 Z 範圍</dt><dd>{presentation ? `總高度 ${presentation.totalZ} mm` : '不可用'}</dd></div>
          <div><dt>輸出內容</dt><dd>切割外形與相對深淺層級</dd></div>
          {assembly && <>
            <div><dt>製作材料</dt><dd>{assembly.material.name} ({assembly.material.thicknessMm} mm，kerf {assembly.material.kerfMm} mm)</dd></div>
            <div><dt>發射器相容性</dt><dd>{launcherSummary(assembly.launcher.status)}</dd></div>
            <div><dt>固定螺絲孔</dt><dd>{assembly.fastener.count === 0 ? '已安全省略' : `${assembly.fastener.count} 個`}</dd></div>
            <div><dt>頂層紅色特徵</dt><dd>保留 {assembly.topFeatures.retained.red}，省略 {assembly.topFeatures.omitted.red}</dd></div>
            <div><dt>頂層藍色特徵</dt><dd>保留 {assembly.topFeatures.retained.blue}，省略 {assembly.topFeatures.omitted.blue}</dd></div>
          </>}
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
      <MotionSurface
        as="a"
        level={effectLevel}
        className="primary-button download-primary"
        href={downloads.zip.href}
        download={downloads.zip.fileName}
      >
        下載 ZIP 製作套件
      </MotionSurface>
      <nav className="secondary-downloads" aria-label="其他下載格式">
        {([
          ['svg', 'SVG'], ['dxf', 'DXF'], ['previewPdf', '平面預覽 PDF'], ['explodedPdf', '爆炸圖 PDF'],
        ] as const).map(([kind, label]) => (
          <MotionSurface
            as="a"
            level={effectLevel}
            key={kind}
            href={downloads[kind].href}
            download={downloads[kind].fileName}
          >
            下載 {label}
          </MotionSurface>
        ))}
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
      <ModelInput compact level={effectLevel} onFile={(file) => void selectFile(file)} />
    </section>
  );
}
