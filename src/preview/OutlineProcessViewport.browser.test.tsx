import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Line, type BufferGeometry, type LineBasicMaterial, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColoredOutlineLayer, OutlinePreviewPayload } from '../domain/outline-features/types';
import { OutlineProcessViewport } from './OutlineProcessViewport';
import {
  createOutlineProcessScene,
  disposeOutlineProcessRendererPool,
  shutdownOutlineProcessRendererPool,
  type OutlineProcessScene,
  warmOutlineProcessRenderer,
} from './outline-process-scene';
import '../styles.css';

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
  afterEach(() => disposeOutlineProcessRendererPool());

  it('reuses the warmed WebGL canvas across sequential processing and result viewports', async () => {
    warmOutlineProcessRenderer();
    const processing = render(<OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion />);
    const firstCanvas = await waitFor(() => {
      const canvas = screen.getByRole('img', { name: /模型分層預覽/ }).querySelector('canvas');
      expect(canvas).not.toBeNull();
      return canvas!;
    });
    processing.unmount();

    const result = render(<OutlineProcessViewport payload={browserPayload()} stage="result" reducedMotion />);
    await waitFor(() => expect(
      screen.getByRole('img', { name: /模型分層預覽/ }).querySelector('canvas'),
    ).toBe(firstCanvas));
    result.unmount();
  });

  it('clears the framebuffer before returning a renderer to the idle pool', async () => {
    const clear1 = vi.spyOn(WebGLRenderingContext.prototype, 'clear');
    const clear2 = vi.spyOn(WebGL2RenderingContext.prototype, 'clear');
    const view = render(<OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion />);
    await waitFor(() => expect(view.container.querySelector('canvas')).not.toBeNull());
    const before = clear1.mock.calls.length + clear2.mock.calls.length;

    view.unmount();

    expect(clear1.mock.calls.length + clear2.mock.calls.length).toBeGreaterThan(before);
    clear1.mockRestore();
    clear2.mockRestore();
  });

  it('drains an idle renderer context on pagehide', async () => {
    const view = render(<OutlineProcessViewport payload={browserPayload()} stage="result" reducedMotion />);
    const canvas = await waitFor(() => {
      const candidate = view.container.querySelector('canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    expect(context).not.toBeNull();
    view.unmount();

    window.dispatchEvent(new PageTransitionEvent('pagehide'));

    await waitFor(() => expect(context!.isContextLost()).toBe(true));
  });

  it('disposes a renderer released after parent-first application shutdown', async () => {
    const view = render(<OutlineProcessViewport payload={browserPayload()} stage="result" reducedMotion />);
    const canvas = await waitFor(() => {
      const candidate = view.container.querySelector('canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    expect(context).not.toBeNull();

    shutdownOutlineProcessRendererPool();
    view.unmount();

    await waitFor(() => expect(context!.isContextLost()).toBe(true));
  });

  it('constructs real WebGL geometry without manual controls and disposes on unmount', async () => {
    let scene: OutlineProcessScene | undefined;
    const createScene = vi.fn((host, payload, options) => {
      scene = createOutlineProcessScene(host, payload, options);
      return scene;
    });
    const view = render(
      <OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion createScene={createScene} />,
    );

    await waitFor(() => expect(scene).toBeDefined());
    const viewport = screen.getByRole('img', { name: /模型分層預覽/ });
    expect(viewport.querySelector('canvas')).not.toBeNull();
    expect(getComputedStyle(viewport).touchAction).toBe('pan-y');
    expect(scene!.meshGeometry.getAttribute('position').count).toBe(3);
    expect(scene!.layerGroups).toHaveLength(6);
    expect(scene!.layerGroups[0].position.y).not.toBe(scene!.layerGroups[5].position.y);

    expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /旋轉|縮小|放大|重設/ })).not.toBeInTheDocument();

    const dispose = vi.spyOn(scene!, 'dispose');
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('selects an ordered result layer with keyboard-accessible opacity highlighting', async () => {
    let scene: OutlineProcessScene | undefined;
    const view = render(
      <OutlineProcessViewport
        payload={browserPayload()}
        stage="result"
        reducedMotion
        createScene={(host, payload, options) => {
          scene = createOutlineProcessScene(host, payload, options);
          return scene;
        }}
      />,
    );

    await waitFor(() => expect(scene).toBeDefined());
    const selector = screen.getByRole('combobox', { name: '選擇預覽切片' });
    expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /旋轉|縮小|放大|重設/ })).not.toBeInTheDocument();
    expect(getComputedStyle(selector).minHeight).toBe('44px');
    await userEvent.selectOptions(selector, 'actual-layer-2');
    expect(scene!.layerGroups[2].userData.selected).toBe(true);
    expect(scene!.layerGroups[0].userData.selected).toBe(false);
    const dimmed = scene!.layerGroups[0].children[0] as Line<BufferGeometry, LineBasicMaterial>;
    const selected = scene!.layerGroups[2].children[0] as Line<BufferGeometry, LineBasicMaterial>;
    expect(dimmed.material.opacity).toBeLessThan(selected.material.opacity);
    view.unmount();
  });

  it('contains warmup failure and disposes the partially initialized renderer exactly once', () => {
    disposeOutlineProcessRendererPool();
    const canvas = document.createElement('canvas');
    const dispose = vi.fn(), forceContextLoss = vi.fn();
    const renderer = {
      domElement: canvas,
      setPixelRatio: vi.fn(),
      setSize: vi.fn((width: number, height: number) => { canvas.width = width; canvas.height = height; }),
      render: vi.fn(() => { throw new Error('synthetic warmup failure'); }),
      getContext: vi.fn(() => ({ finish: vi.fn(), isContextLost: () => false })),
      dispose,
      forceContextLoss,
    } as unknown as WebGLRenderer;

    expect(() => warmOutlineProcessRenderer(() => renderer)).not.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
    expect(forceContextLoss).toHaveBeenCalledOnce();
  });

  it('rejects a lost pooled context and creates a new canvas', async () => {
    const first = render(<OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion />);
    const firstCanvas = await waitFor(() => {
      const canvas = first.container.querySelector('canvas');
      expect(canvas).not.toBeNull();
      return canvas!;
    });
    first.unmount();
    const context = firstCanvas.getContext('webgl2') ?? firstCanvas.getContext('webgl');
    const lose = context?.getExtension('WEBGL_lose_context');
    expect(lose).not.toBeNull();
    lose!.loseContext();
    await new Promise((resolve) => firstCanvas.addEventListener('webglcontextlost', resolve, { once: true }));

    const second = render(<OutlineProcessViewport payload={browserPayload()} stage="result" reducedMotion />);
    await waitFor(() => expect(second.container.querySelector('canvas')).not.toBe(firstCanvas));
    second.unmount();
  });

  it('bounds retained DPR-aware backing storage after a large viewport', () => {
    disposeOutlineProcessRendererPool();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const host = document.createElement('div');
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 1_400 },
      clientHeight: { configurable: true, value: 800 },
    });
    document.body.append(host);
    try {
      const scene = createOutlineProcessScene(host, browserPayload(), { stage: 'slicing', reducedMotion: true });
      const canvas = host.querySelector('canvas')!;
      expect(canvas.width).toBe(2_800);
      expect(canvas.height).toBe(1_600);
      scene.dispose();
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_560 * 1_440);
    } finally {
      host.remove();
      if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
    }
  });

  it('keeps only one idle default renderer after concurrent viewports', async () => {
    disposeOutlineProcessRendererPool();
    const first = render(<OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion />);
    const second = render(<OutlineProcessViewport payload={browserPayload()} stage="slicing" reducedMotion />);
    const firstCanvas = await waitFor(() => first.container.querySelector('canvas')!);
    const secondCanvas = await waitFor(() => second.container.querySelector('canvas')!);
    expect(firstCanvas).not.toBe(secondCanvas);
    const secondContext = secondCanvas.getContext('webgl2') ?? secondCanvas.getContext('webgl');
    expect(secondContext).not.toBeNull();
    first.unmount();
    second.unmount();
    await waitFor(() => expect(secondContext!.isContextLost()).toBe(true));
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
    expect(getComputedStyle(fallback).touchAction).toBe('pan-y');
    expect(fallback.querySelectorAll('path')).toHaveLength(24 * 4);
    expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
  });
});
