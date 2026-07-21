import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
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

function explodedOffset(order: number, count: number, stage: AutomaticOutlineProgressStage): number {
  return stage === 'slicing' || stage === 'packaging'
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

function SvgFallback({ payload, stage }: { readonly payload: OutlinePreviewPayload; readonly stage: AutomaticOutlineProgressStage }) {
  const meshPoints = useMemo(() => projectedMeshPoints(payload), [payload]);
  const meshD = useMemo(() => meshPath(payload, meshPoints), [payload, meshPoints]);
  const points = useMemo(() => payload.layers.length === 0
    ? meshPoints
    : payload.layers.flatMap((layer, order) => {
      const offset = explodedOffset(order, payload.layers.length, stage);
      return [layer.exterior, layer.centralHole, layer.deepFeature, layer.lightFeature]
        .filter((contour): contour is FeatureContour => contour !== undefined)
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
          transform={`translate(0 ${explodedOffset(order, payload.layers.length, stage)})`}
        >
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
  const appliedPayloadRef = useRef<OutlinePreviewPayload | undefined>(undefined);
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

  const descriptionId = useId();
  return (
    <figure className="outline-process-viewport" data-stage={stage}>
      {fallback ? (
        <SvgFallback payload={payload} stage={stage} />
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
      <figcaption id={descriptionId} className="outline-process-caption" role="status" aria-live="polite">
        {fallback ? 'WebGL 不可用，現以實際輪廓 SVG 顯示。' : STAGE_LABELS[stage]}
      </figcaption>
      {!fallback && (
        <div className="outline-process-controls" role="group" aria-label="模型預覽控制">
          <button type="button" onClick={() => rotate(-Math.PI / 12)} aria-label="向左旋轉">↶</button>
          <button type="button" onClick={() => rotate(Math.PI / 12)} aria-label="向右旋轉">↷</button>
          <button type="button" onClick={() => zoom(-0.2)} aria-label="縮小模型">−</button>
          <button type="button" onClick={() => zoom(0.2)} aria-label="放大模型">+</button>
          <button type="button" onClick={reset} aria-label="重設視角">重設</button>
        </div>
      )}
    </figure>
  );
}
