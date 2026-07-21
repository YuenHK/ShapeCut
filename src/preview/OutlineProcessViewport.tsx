import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import type { FeatureContour, OutlinePreviewPayload } from '../domain/outline-features/types';
import {
  CANONICAL_ROLE_COLORS,
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
  readonly stage: AutomaticOutlineProgressStage;
  readonly reducedMotion?: boolean;
  readonly createScene?: OutlineProcessSceneFactory;
  readonly webglFactory?: OutlineWebGLFactory;
};

const STAGE_LABELS: Readonly<Record<AutomaticOutlineProgressStage, string>> = Object.freeze({
  reading: '正在讀取模型',
  analyzing: '正在分析幾何',
  simplifying: '正在簡化輪廓',
  slicing: '正在產生分層',
  packaging: '正在準備輸出',
});

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

function fallbackContours(payload: OutlinePreviewPayload): readonly FeatureContour[] {
  return payload.layers.flatMap((layer) => [
    layer.exterior,
    layer.centralHole,
    layer.deepFeature,
    layer.lightFeature,
  ].filter((contour): contour is FeatureContour => contour !== undefined));
}

function fallbackViewBox(contours: readonly FeatureContour[]): string {
  if (contours.length === 0) return '0 0 1 1';
  const points = contours.flatMap((contour) => contour.outer);
  const minX = Math.min(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const maxX = Math.max(...points.map(([x]) => x));
  const maxY = Math.max(...points.map(([, y]) => y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const padding = Math.max(width, height) * 0.06;
  return `${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`;
}

function SvgFallback({ payload }: { readonly payload: OutlinePreviewPayload }) {
  const contours = useMemo(() => fallbackContours(payload), [payload]);
  return (
    <svg
      className="outline-process-fallback"
      role="img"
      aria-label="模型分層預覽 SVG fallback"
      data-layer-count={payload.layers.length}
      viewBox={fallbackViewBox(contours)}
      preserveAspectRatio="xMidYMid meet"
    >
      {payload.layers.map((layer) => (
        <g key={layer.id} data-layer-id={layer.id}>
          {[layer.exterior, layer.centralHole, layer.deepFeature, layer.lightFeature]
            .filter((contour): contour is FeatureContour => contour !== undefined)
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
  reducedMotion: reducedMotionOverride,
  createScene,
  webglFactory,
}: OutlineProcessViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OutlineProcessScene | undefined>(undefined);
  const dragRef = useRef<{ readonly pointerId: number; x: number } | undefined>(undefined);
  const reducedMotion = useReducedMotion(reducedMotionOverride);
  const hasInjectedFactory = createScene !== undefined || webglFactory !== undefined;
  const canUseWebGL = webGLIsAvailable(hasInjectedFactory);
  const [fallback, setFallback] = useState(!canUseWebGL);

  useEffect(() => {
    if (!hostRef.current || !canUseWebGL) {
      setFallback(true);
      return;
    }
    let controller: OutlineProcessScene | undefined;
    try {
      controller = (createScene ?? createOutlineProcessScene)(hostRef.current, payload, {
        stage,
        reducedMotion,
        createRenderer: webglFactory,
      });
      sceneRef.current = controller;
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
      if (sceneRef.current === controller) sceneRef.current = undefined;
    };
    // Payload, stage, and motion are synchronized by the focused effects below.
  }, [canUseWebGL, createScene, webglFactory]);

  useEffect(() => {
    if (!sceneRef.current) return;
    try {
      sceneRef.current.setPayload(payload);
    } catch {
      sceneRef.current.dispose();
      sceneRef.current = undefined;
      setFallback(true);
    }
  }, [payload, canUseWebGL, createScene, webglFactory]);
  useEffect(() => { sceneRef.current?.setStage(stage); }, [stage, canUseWebGL, createScene, webglFactory]);
  useEffect(() => { sceneRef.current?.setReducedMotion(reducedMotion); }, [reducedMotion, canUseWebGL, createScene, webglFactory]);

  const rotate = (amount: number): void => sceneRef.current?.rotateBy(amount);
  const zoom = (amount: number): void => sceneRef.current?.zoomBy(amount);
  const reset = (): void => sceneRef.current?.resetView();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowLeft': rotate(-Math.PI / 24); break;
      case 'ArrowRight': rotate(Math.PI / 24); break;
      case '+':
      case '=': zoom(0.1); break;
      case '-':
      case '_': zoom(-0.1); break;
      case 'Home':
      case 'r':
      case 'R': reset(); break;
      default: return;
    }
    event.preventDefault();
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    dragRef.current = { pointerId: event.pointerId, x: event.clientX };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Browser may reject synthetic capture. */ }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.x;
    drag.x = event.clientX;
    rotate(delta * 0.01);
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* Browser may reject synthetic capture. */ }
  };

  const descriptionId = 'outline-process-viewport-description';
  return (
    <figure className="outline-process-viewport" data-stage={stage}>
      {fallback ? (
        <SvgFallback payload={payload} />
      ) : (
        <div
          ref={hostRef}
          className="outline-process-webgl"
          role="img"
          aria-label="模型分層預覽：可水平旋轉的真實網格和爆炸圖"
          aria-describedby={descriptionId}
          data-layer-count={payload.layers.length}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        />
      )}
      <figcaption id={descriptionId} className="outline-process-caption">
        {fallback ? 'WebGL 不可用，現以實際輪廓 SVG 顯示。' : STAGE_LABELS[stage]}
      </figcaption>
      <div className="outline-process-controls" role="group" aria-label="模型預覽控制">
        <button type="button" onClick={() => rotate(-Math.PI / 12)} aria-label="向左旋轉">↶</button>
        <button type="button" onClick={() => rotate(Math.PI / 12)} aria-label="向右旋轉">↷</button>
        <button type="button" onClick={() => zoom(-0.2)} aria-label="縮小模型">−</button>
        <button type="button" onClick={() => zoom(0.2)} aria-label="放大模型">+</button>
        <button type="button" onClick={reset} aria-label="重設視角">重設</button>
      </div>
    </figure>
  );
}
