import { useEffect, useRef, useState } from 'react';
import type { SpinnerKit } from '../domain/decomposition/types';
import type { EngravingMap } from '../domain/engraving/height-field';
import type { TriangleMesh } from '../domain/mesh/types';
import type { Severity } from '../domain/types';
import { createSceneController, type SceneController } from './scene-controller';

export type GeometryIssue = {
  readonly id: string;
  readonly regionId: string;
  readonly severity: Severity;
  readonly label: string;
  readonly description: string;
};

export type SpinnerViewportProps = {
  readonly mesh?: TriangleMesh;
  readonly parts?: SpinnerKit;
  readonly engraving?: EngravingMap;
  readonly issues: readonly GeometryIssue[];
  readonly createController?: (host: HTMLElement) => SceneController;
};

export function SpinnerViewport({
  mesh,
  parts,
  engraving,
  issues,
  createController = createSceneController,
}: SpinnerViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SceneController | undefined>(undefined);
  const [exploded, setExploded] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const controller = createController(hostRef.current);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = undefined;
    };
  }, [createController]);

  useEffect(() => { controllerRef.current?.setMesh(mesh); }, [mesh]);
  useEffect(() => { controllerRef.current?.setParts(parts); }, [parts]);
  useEffect(() => { controllerRef.current?.setEngraving(engraving); }, [engraving]);
  useEffect(() => { controllerRef.current?.setExploded(exploded); }, [exploded]);

  return (
    <section aria-label="陀螺 3D 預覽">
      <div ref={hostRef} data-spinner-viewport role="img" aria-label="可旋轉陀螺模型" style={{ width: '100%', minHeight: 320 }} />
      <label>
        爆炸圖距離
        <input
          aria-label="爆炸圖距離"
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={exploded}
          onChange={(event) => setExploded(Number(event.currentTarget.value))}
        />
      </label>
      {issues.length > 0 && (
        <ul aria-label="幾何問題">
          {issues.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                aria-describedby={`${issue.id}-description`}
                onClick={() => controllerRef.current?.focusRegion(issue.regionId)}
              >
                {issue.label}（{issue.severity}）
              </button>
              <span id={`${issue.id}-description`}>{issue.description}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
