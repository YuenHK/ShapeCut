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
    axis: {
      origin: [0, 0, 0], direction: [0, 0, 1],
      planeX: [0, 1, 0], planeY: [-1, 0, 0],
    },
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

  it('runs real RAF only while a non-reduced viewport is visible', async () => {
    let scene: OutlineProcessScene | undefined;
    const view = render(
      <OutlineProcessViewport
        payload={browserPayload()}
        stage="slicing"
        reducedMotion={false}
        createScene={(host, payload, options) => {
          scene = createOutlineProcessScene(host, payload, options);
          return scene;
        }}
      />,
    );

    await waitFor(() => expect(scene).toBeDefined());
    const initial = scene!.rotatingGroup.rotation.y;
    await waitFor(() => expect(scene!.rotatingGroup.rotation.y).not.toBe(initial));
    scene!.setVisible(false);
    const paused = scene!.rotatingGroup.rotation.y;
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    expect(scene!.rotatingGroup.rotation.y).toBe(paused);
    scene!.setVisible(true);
    await waitFor(() => expect(scene!.rotatingGroup.rotation.y).not.toBe(paused));
    view.unmount();
  });

  it('falls back for a maximum legal contour set without exposing inert controls', async () => {
    const outer = Array.from({ length: 4_096 }, (_, index) => {
      const angle = index / 4_096 * Math.PI * 2;
      return [50 * Math.cos(angle), 50 * Math.sin(angle)] as const;
    });
    const source = browserPayload();
    const payload: OutlinePreviewPayload = {
      ...source,
      layers: Array.from({ length: 24 }, (_, index) => {
        const base = source.layers[index % source.layers.length];
        const feature = (id: string, role: 'CUT_BLACK' | 'DEEP_RED' | 'LIGHT_BLUE') => ({
          id, role, outer,
          boundsMm: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
          areaMm2: Math.PI * 2_500,
        });
        return {
          ...base,
          id: `maximum-layer-${index}`, index, zStart: index, zEnd: index + 1,
          exterior: feature(`maximum-exterior-${index}`, 'CUT_BLACK'),
          centralHole: feature(`maximum-hole-${index}`, 'CUT_BLACK'),
          deepFeature: feature(`maximum-red-${index}`, 'DEEP_RED'),
          lightFeature: feature(`maximum-blue-${index}`, 'LIGHT_BLUE'),
        };
      }),
    };
    render(
      <OutlineProcessViewport
        payload={payload}
        stage="slicing"
        reducedMotion
        createScene={() => { throw new Error('force SVG fallback'); }}
      />,
    );

    const fallback = await screen.findByRole('img', { name: /SVG/ });
    expect(fallback.querySelectorAll('path')).toHaveLength(24 * 4);
    expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
  });
});
