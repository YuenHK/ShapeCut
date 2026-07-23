import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EffectLevel } from '../app/effect-level';
import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import type { FeatureContour, OutlinePreviewPayload } from '../domain/outline-features/types';
import {
  CANONICAL_ROLE_COLORS,
  EXPLODED_LAYER_GAP,
  createOutlineProcessScene,
  type OutlineProcessScene,
  type OutlineProcessSceneOptions,
  type OutlineWebGLFactory,
} from './outline-process-scene';

export type OutlineProcessSceneFactory = (
  host: HTMLElement,
  payload: OutlinePreviewPayload,
  options: OutlineProcessSceneOptions,
) => OutlineProcessScene;

export type OutlineProcessViewportProps = {
  readonly payload: OutlinePreviewPayload;
  readonly stage: OutlineProcessViewportStage;
  readonly effectLevel?: EffectLevel;
  readonly reducedMotion?: boolean;
  readonly createScene?: OutlineProcessSceneFactory;
  readonly webglFactory?: OutlineWebGLFactory;
};

export type OutlineProcessViewportStage = AutomaticOutlineProgressStage | 'result';

const STAGE_LABELS: Readonly<Record<OutlineProcessViewportStage, string>> = Object.freeze({
  reading: '正在讀取模型',
  analyzing: '正在分析幾何',
  simplifying: '正在簡化輪廓',
  slicing: '正在產生分層',
  packaging: '正在準備輸出',
  result: '轉換完成：模型分層預覽',
});

function sceneStage(stage: OutlineProcessViewportStage): AutomaticOutlineProgressStage {
  return stage === 'result' ? 'packaging' : stage;
}

function useReducedMotion(override: boolean | undefined): boolean {
  const [mediaReduced, setMediaReduced] = useState(() => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = (): void => setMediaReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  return override ?? mediaReduced;
}

function featurePath(contour: FeatureContour): string {
  return contour.outer
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`)
    .join(' ') + ' Z';
}

function explodedOffset(order: number, count: number, stage: OutlineProcessViewportStage): number {
  return stage === 'slicing' || stage === 'packaging' || stage === 'result'
    ? (order - (count - 1) / 2) * EXPLODED_LAYER_GAP
    : 0;
}

type FallbackPoint = readonly [number, number];

function projectedMeshPoints(payload: OutlinePreviewPayload): readonly FallbackPoint[] {
  const { origin, planeX, planeY } = payload.axis;
  const points: FallbackPoint[] = [];
  for (let index = 0; index < payload.mesh.positions.length; index += 3) {
    const dx = payload.mesh.positions[index] - origin[0];
    const dy = payload.mesh.positions[index + 1] - origin[1];
    const dz = payload.mesh.positions[index + 2] - origin[2];
    const x = dx * planeX[0] + dy * planeX[1] + dz * planeX[2];
    const y = dx * planeY[0] + dy * planeY[1] + dz * planeY[2];
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

function meshPath(payload: OutlinePreviewPayload, points: readonly FallbackPoint[]): string {
  const commands: string[] = [];
  for (let index = 0; index + 2 < payload.mesh.indices.length; index += 3) {
    const a = points[payload.mesh.indices[index]];
    const b = points[payload.mesh.indices[index + 1]];
    const c = points[payload.mesh.indices[index + 2]];
    if (a && b && c) commands.push(`M ${a[0]} ${a[1]} L ${b[0]} ${b[1]} L ${c[0]} ${c[1]} Z`);
  }
  return commands.join(' ');
}

function fallbackViewBox(points: readonly FallbackPoint[]): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return '0 0 1 1';
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const padding = Math.max(width, height) * 0.06;
  return `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`;
}

function SvgFallback({
  payload,
  stage,
  selectedLayerId,
}: {
  readonly payload: OutlinePreviewPayload;
  readonly stage: OutlineProcessViewportStage;
  readonly selectedLayerId: string | undefined;
}) {
  const meshPoints = useMemo(() => projectedMeshPoints(payload), [payload]);
  const meshD = useMemo(() => meshPath(payload, meshPoints), [payload, meshPoints]);
  const points = useMemo(() => payload.layers.length === 0
    ? meshPoints
    : payload.layers.flatMap((layer, order) => {
      const offset = explodedOffset(order, payload.layers.length, stage);
      return [
        layer.exterior,
        ...(layer.centralHole ? [layer.centralHole] : []),
        ...layer.launcherCuts,
        ...layer.fastenerHoles,
        ...layer.deepFeatures,
        ...layer.lightFeatures,
      ]
        .flatMap((contour) => contour.outer.map(([x, y]): FallbackPoint => [x, y + offset]));
    }), [meshPoints, payload.layers, stage]);
  return (
    <svg
      className="outline-process-fallback"
      role="img"
      aria-label="模型分層預覽 SVG fallback"
      data-layer-count={payload.layers.length}
      viewBox={fallbackViewBox(points)}
      preserveAspectRatio="xMidYMid meet"
    >
      {payload.layers.length === 0 && (
        <path data-preview-mesh d={meshD} fill="none" stroke="#22A77D" vectorEffect="non-scaling-stroke" />
      )}
      {payload.layers.map((layer, order) => (
        <g
          key={layer.id}
          data-layer-id={layer.id}
          data-selected={selectedLayerId === layer.id ? 'true' : 'false'}
          opacity={selectedLayerId === undefined || selectedLayerId === layer.id ? 1 : 0.18}
          transform={`translate(0 ${explodedOffset(order, payload.layers.length, stage)})`}
        >
          {[
            layer.exterior,
            ...(layer.centralHole ? [layer.centralHole] : []),
            ...layer.launcherCuts,
            ...layer.fastenerHoles,
            ...layer.deepFeatures,
            ...layer.lightFeatures,
          ]
            .map((contour) => (
              <path
                key={contour.id}
                data-feature-id={contour.id}
                data-role={contour.role}
                d={featurePath(contour)}
                fill="none"
                stroke={CANONICAL_ROLE_COLORS[contour.role]}
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </g>
      ))}
    </svg>
  );
}

function webGLIsAvailable(hasInjectedFactory: boolean): boolean {
  return hasInjectedFactory || typeof window.WebGLRenderingContext !== 'undefined';
}

export function OutlineProcessViewport({
  payload,
  stage,
  effectLevel,
  reducedMotion: reducedMotionOverride,
  createScene,
  webglFactory,
}: OutlineProcessViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OutlineProcessScene | undefined>(undefined);
  const appliedPayloadRef = useRef<OutlinePreviewPayload | undefined>(undefined);
  const mediaReduced = useReducedMotion(undefined);
  const reducedMotion = reducedMotionOverride ?? mediaReduced;
  const requestedLevel = reducedMotionOverride === true || mediaReduced
    ? 'static'
    : effectLevel ?? 'full';
  const hasInjectedFactory = createScene !== undefined || webglFactory !== undefined;
  const canUseWebGL = webGLIsAvailable(hasInjectedFactory);
  const [fallback, setFallback] = useState(!canUseWebGL);
  const [selectedLayerId, setSelectedLayerId] = useState<string | undefined>(() => payload.layers[0]?.id);
  const renderedSceneStage = sceneStage(stage);

  useEffect(() => {
    setSelectedLayerId((current) => payload.layers.some((layer) => layer.id === current)
      ? current
      : payload.layers[0]?.id);
  }, [payload]);

  useEffect(() => {
    if (!hostRef.current || !canUseWebGL) {
      setFallback(true);
      return;
    }
    let controller: OutlineProcessScene | undefined;
    try {
      controller = (createScene ?? createOutlineProcessScene)(hostRef.current, payload, {
        stage: renderedSceneStage,
        effectLevel: requestedLevel,
        reducedMotion,
        createRenderer: webglFactory,
      });
      sceneRef.current = controller;
      appliedPayloadRef.current = payload;
      setFallback(false);
    } catch (error) {
      const partialScene = (error as Error & { partialScene?: Pick<OutlineProcessScene, 'dispose'> }).partialScene;
      partialScene?.dispose();
      controller?.dispose();
      sceneRef.current = undefined;
      setFallback(true);
    }
    return () => {
      controller?.dispose();
      if (sceneRef.current === controller) {
        sceneRef.current = undefined;
        appliedPayloadRef.current = undefined;
      }
    };
    // Payload, stage, and motion are synchronized by the focused effects below.
  }, [canUseWebGL, createScene, webglFactory]);

  useEffect(() => {
    if (!sceneRef.current || appliedPayloadRef.current === payload) return;
    try {
      sceneRef.current.setPayload(payload);
      appliedPayloadRef.current = payload;
    } catch {
      sceneRef.current.dispose();
      sceneRef.current = undefined;
      appliedPayloadRef.current = undefined;
      setFallback(true);
    }
  }, [payload, canUseWebGL, createScene, webglFactory]);
  useEffect(() => { sceneRef.current?.setStage(renderedSceneStage); }, [renderedSceneStage, canUseWebGL, createScene, webglFactory]);
  useEffect(() => { sceneRef.current?.setEffectLevel(requestedLevel); }, [requestedLevel, canUseWebGL, createScene, webglFactory]);
  useEffect(() => { sceneRef.current?.setReducedMotion(reducedMotion); }, [reducedMotion, canUseWebGL, createScene, webglFactory]);
  useEffect(() => {
    sceneRef.current?.setHighlightedLayer(stage === 'result' ? selectedLayerId : undefined);
  }, [selectedLayerId, stage, canUseWebGL, createScene, webglFactory]);

  const descriptionId = useId();
  const showLayerSelector = stage === 'result' && payload.layers.length > 0;
  return (
    <figure
      className="outline-process-viewport"
      data-stage={stage}
      data-renderer={fallback ? 'fallback' : 'webgl'}
      data-effect-level={fallback ? 'static' : requestedLevel}
    >
      {fallback ? (
        <SvgFallback payload={payload} stage={stage} selectedLayerId={showLayerSelector ? selectedLayerId : undefined} />
      ) : (
        <div
          ref={hostRef}
          className="outline-process-webgl"
          role="img"
          aria-label="模型分層預覽：可水平旋轉的真實網格和爆炸圖"
          aria-describedby={descriptionId}
          data-layer-count={payload.layers.length}
        />
      )}
      <figcaption id={descriptionId} className="outline-process-caption" role="status" aria-live="polite">
        {fallback
          ? payload.layers.length === 0
            ? 'WebGL 不可用，現以實際模型線框 SVG 顯示。'
            : stage === 'result'
              ? '轉換完成：模型分層預覽現以實際輪廓 SVG 顯示。'
              : 'WebGL 不可用，現以實際分層輪廓 SVG 顯示。'
          : STAGE_LABELS[stage]}
      </figcaption>
      {showLayerSelector && (
        <label className="outline-process-layer-selector">
          <span>預覽切片</span>
          <select
            aria-label="選擇預覽切片"
            value={selectedLayerId ?? ''}
            onChange={(event) => setSelectedLayerId(event.currentTarget.value || undefined)}
          >
            {payload.layers.map((layer, index) => (
              <option key={layer.id} value={layer.id}>第 {index + 1} 層：{layer.id}</option>
            ))}
          </select>
        </label>
      )}
    </figure>
  );
}
