import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ColoredOutlineLayer, OutlinePreviewPayload } from '../domain/outline-features/types';
import { OutlineProcessViewport } from './OutlineProcessViewport';
import { createOutlineProcessScene, type OutlineProcessScene } from './outline-process-scene';

function browserPayload(): OutlinePreviewPayload {
  const exterior = {
    id: 'actual-exterior', role: 'CUT_BLACK' as const,
    outer: [[0, 0], [10, 0], [10, 10], [0, 10]] as const,
    boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, areaMm2: 100,
  };
  const layers: ColoredOutlineLayer[] = Array.from({ length: 6 }, (_, index) => ({
    id: `actual-layer-${index}`, index, zStart: index, zEnd: index + 1,
    exterior: { ...exterior, id: `actual-exterior-${index}` },
    deepFeature: index === 0 ? {
      id: 'actual-red', role: 'DEEP_RED', outer: [[1, 1], [4, 1], [4, 4], [1, 4]],
      boundsMm: { minX: 1, minY: 1, maxX: 4, maxY: 4 }, areaMm2: 9,
    } : undefined,
    lightFeature: index === 1 ? {
      id: 'actual-blue', role: 'LIGHT_BLUE', outer: [[6, 6], [9, 6], [9, 9], [6, 9]],
      boundsMm: { minX: 6, minY: 6, maxX: 9, maxY: 9 }, areaMm2: 9,
    } : undefined,
    removedComponentCount: 0,
    diagnostics: {
      hole: { status: 'omitted' },
      depth: { cellSizeMm: 0.25, contrastMm: 1, redThresholdMm: 0.8, blueThresholdMm: 0.4 },
    },
  }));
  return {
    mesh: {
      positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    },
    axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
    layers,
  };
}

describe('OutlineProcessViewport in Chromium', () => {
  it('constructs real WebGL geometry, responds to controls, and disposes on unmount', async () => {
    let scene: OutlineProcessScene | undefined;
    const createScene = vi.fn((host, payload, options) => {
      scene = createOutlineProcessScene(host, payload, options);
      return scene;
    });
    const view = render(
      <OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion createScene={createScene} />,
    );

    await waitFor(() => expect(scene).toBeDefined());
    expect(screen.getByRole('img', { name: /模型分層預覽/ }).querySelector('canvas')).not.toBeNull();
    expect(scene!.meshGeometry.getAttribute('position').count).toBe(3);
    expect(scene!.layerGroups).toHaveLength(6);
    expect(scene!.layerGroups[0].position.y).not.toBe(scene!.layerGroups[5].position.y);

    const previousRotation = scene!.rotatingGroup.rotation.y;
    await userEvent.click(screen.getByRole('button', { name: '向右旋轉' }));
    expect(scene!.rotatingGroup.rotation.y).toBeGreaterThan(previousRotation);

    const dispose = vi.spyOn(scene!, 'dispose');
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
