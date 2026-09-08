import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cdp } from 'vitest/browser';
import { BufferGeometry, Line, Material, type LineBasicMaterial, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineProgressEvent } from '../domain/pipeline/automatic-outline-pipeline';
import type { ColoredOutlineLayer, OutlinePreviewPayload } from '../domain/outline-features/types';
import { coloredResult } from '../export/colored-outline-test-fixture';
import { READY_TEST_MATERIAL } from '../test/ready-material';
import { OutlineArtifactError } from '../workers/geometry-api';
import { OneClickConverter, type OneClickConverterServices } from '../app/OneClickConverter';
import { OutlineProcessViewport } from './OutlineProcessViewport';
import { createStlPresentationPayload } from './stl-presentation';
import {
  createOutlineProcessScene,
  disposeOutlineProcessRendererPool,
  shutdownOutlineProcessRendererPool,
  type OutlineProcessRenderer,
  type OutlineProcessScene,
  warmOutlineProcessRenderer,
} from './outline-process-scene';
import '../styles.css';

const PRESENTATION_STL = `solid preview
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 6 2
  endloop
endfacet
endsolid preview`;

function browserPayload(): OutlinePreviewPayload {
  const exterior = {
    id: 'actual-exterior', role: 'CUT_BLACK' as const,
    outer: [[0, 0], [10, 0], [10, 10], [0, 10]] as const,
    boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, areaMm2: 100,
  };
  const layers: ColoredOutlineLayer[] = Array.from({ length: 6 }, (_, index) => ({
    id: `actual-layer-${index}`, index, zStart: index, zEnd: index + 1,
    exterior: { ...exterior, id: `actual-exterior-${index}` },
    launcherCuts: [], fastenerHoles: [],
    deepFeatures: index === 0 ? [{
      id: 'actual-red', role: 'DEEP_RED', outer: [[1, 1], [4, 1], [4, 4], [1, 4]],
      boundsMm: { minX: 1, minY: 1, maxX: 4, maxY: 4 }, areaMm2: 9,
    }] : [],
    lightFeatures: index === 1 ? [{
      id: 'actual-blue', role: 'LIGHT_BLUE', outer: [[6, 6], [9, 6], [9, 9], [6, 9]],
      boundsMm: { minX: 6, minY: 6, maxX: 9, maxY: 9 }, areaMm2: 9,
    }] : [],
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

function activeConversionServices() {
  let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
  const services: OneClickConverterServices = {
    present: vi.fn(async (bytes) => createStlPresentationPayload(bytes)),
    materialProfiles: [READY_TEST_MATERIAL],
    cancel: vi.fn(),
    createTimeline: (clock) => {
      let lastStage = -1;
      return {
        advance: (stage, preview) => {
          const nextStage = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'].indexOf(stage);
          if (nextStage <= lastStage) return;
          lastStage = nextStage;
          clock.onStage(stage, preview);
        },
        finish: () => new Promise<never>(() => undefined),
        cancel: vi.fn(),
      };
    },
    convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
      report = onProgress;
      return new Promise<never>(() => undefined);
    }),
    package: vi.fn(() => new Promise<never>(() => undefined)),
  };
  return { services, report: () => report };
}

function completedConversionServices(): OneClickConverterServices {
  return {
    present: vi.fn(async (bytes) => createStlPresentationPayload(bytes)),
    materialProfiles: [READY_TEST_MATERIAL],
    cancel: vi.fn(),
    createTimeline: (clock) => ({
      advance: (stage, preview) => clock.onStage(stage, preview),
      finish: () => Promise.resolve(),
      cancel: vi.fn(),
    }),
    convert: vi.fn().mockResolvedValue(coloredResult()),
    package: vi.fn().mockResolvedValue({
      zip: { href: 'blob:browser-zip', fileName: 'shapecut-files.zip' },
      svg: { href: 'blob:browser-svg', fileName: 'cut-and-engrave.svg' },
      dxf: { href: 'blob:browser-dxf', fileName: 'cut-and-engrave.dxf' },
      previewPdf: { href: 'blob:browser-preview', fileName: 'preview.pdf' },
      explodedPdf: { href: 'blob:browser-exploded', fileName: 'exploded-view.pdf' },
      launcherCoupon: { href: 'blob:browser-launcher-coupon', fileName: 'launcher-fit-coupon.svg' },
    }),
  };
}

describe('OutlineProcessViewport in Chromium', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    disposeOutlineProcessRendererPool();
    await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  });

  it('mounts full effects in a bounded real WebGL canvas', async () => {
    let scene: OutlineProcessScene | undefined;
    const view = render(
      <OutlineProcessViewport
        payload={browserPayload()}
        stage="slicing"
        effectLevel="full"
        reducedMotion={false}
        createScene={(host, payload, options) => {
          scene = createOutlineProcessScene(host, payload, options);
          return scene;
        }}
      />,
    );

    const canvas = await waitFor(() => {
      expect(scene).toBeDefined();
      const candidate = view.container.querySelector('canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const figure = screen.getByRole('figure');
    expect(figure).toHaveAttribute('data-renderer', 'webgl');
    expect(figure).toHaveAttribute('data-effect-level', 'full');
    expect(scene!.scene.userData.effectLevel).toBe('full');
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_560 * 1_440);
    view.unmount();
  });

  it('downgrades a live full scene to static without remounting its viewport state', async () => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [] });
    const scenes: OutlineProcessScene[] = [];
    const createScene = vi.fn((host, payload, options) => {
      const scene = createOutlineProcessScene(host, payload, options);
      scenes.push(scene);
      return scene;
    });
    const view = render(
      <OutlineProcessViewport
        payload={browserPayload()}
        stage="result"
        effectLevel="full"
        createScene={createScene}
      />,
    );

    const canvas = await waitFor(() => {
      expect(scenes).toHaveLength(1);
      const candidate = view.container.querySelector('canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '選擇預覽切片' }), 'actual-layer-2');
    expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'full');

    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });

    await waitFor(() => {
      expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
      expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
      expect(scenes[0].scene.userData.effectLevel).toBe('static');
    });
    expect(createScene).toHaveBeenCalledOnce();
    expect(view.container.querySelector('canvas')).toBe(canvas);
    expect(screen.getByRole('combobox', { name: '選擇預覽切片' })).toHaveValue('actual-layer-2');
    const paused = scenes[0].rotatingGroup.rotation.y;
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    expect(scenes[0].rotatingGroup.rotation.y).toBe(paused);
    view.unmount();
  });

  it.each([
    { cores: 2, restoredLevel: 'energy-saving' },
    { cores: 8, restoredLevel: 'full' },
  ] as const)('holds a live downgrade until active processing exits on $cores cores', async ({ cores, restoredLevel }) => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(cores);
    const user = userEvent.setup();
    const active = activeConversionServices();
    const view = render(<OneClickConverter services={active.services} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'live-motion.stl'));
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), 'acrylic-6');
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    await act(async () => {
      active.report()?.({ stage: 'analyzing', preview: browserPayload() });
    });

    const canvas = await waitFor(() => {
      const candidate = view.container.querySelector('.outline-process-viewport canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const workbench = screen.getByTestId('apple-workbench');
    expect(workbench).toHaveAttribute('data-state', 'processing');
    expect(workbench).toHaveAttribute('data-effect-level', restoredLevel);

    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });

    await waitFor(() => {
      expect(workbench).toHaveAttribute('data-state', 'processing');
      expect(workbench).toHaveAttribute('data-effect-level', 'static');
      expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
    });
    expect(view.container.querySelector('.outline-process-viewport canvas')).toBe(canvas);
    expect(active.services.convert).toHaveBeenCalledOnce();

    await cdp().send('Emulation.setEmulatedMedia', { features: [] });
    await waitFor(() => {
      expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
      expect(workbench).toHaveAttribute('data-state', 'processing');
      expect(workbench).toHaveAttribute('data-effect-level', 'static');
      expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
    });

    fireEvent.change(screen.getByLabelText('選擇 STL 模型'), {
      target: { files: [new File(['not an stl'], 'replacement.txt')] },
    });
    await waitFor(() => {
      expect(workbench).toHaveAttribute('data-state', 'failure');
      expect(workbench).toHaveAttribute('data-effect-level', restoredLevel);
    });
    view.unmount();
  });

  it('shows and disposes the presentation-only mesh across material replacement', async () => {
    const user = userEvent.setup();
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const active = activeConversionServices();
    const view = render(<OneClickConverter services={active.services} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([PRESENTATION_STL], 'presentation.stl', { type: 'model/stl' }),
    );
    const canvas = await waitFor(() => {
      expect(screen.getByLabelText('選擇製作材料')).toBeVisible();
      const candidate = view.container.querySelector<HTMLCanvasElement>('.material-presentation-preview canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(view.container.querySelector('.material-presentation-preview [data-layer-count="0"]')).not.toBeNull();
    const disposeCount = geometryDispose.mock.calls.length;

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['malformed'], 'replacement.stl'));
    await waitFor(() => {
      expect(screen.getByLabelText('選擇製作材料')).toBeVisible();
      expect(view.container.querySelector('.material-presentation-preview')).toBeNull();
      expect(canvas.isConnected).toBe(false);
      expect(geometryDispose.mock.calls.length).toBeGreaterThan(disposeCount);
    });
    expect(active.services.convert).not.toHaveBeenCalled();
    view.unmount();
  });

  it('settles and dims a retained failure preview without rotation, pulse RAF, or blocking retry', async () => {
    const user = userEvent.setup();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const services: OneClickConverterServices = {
      ...completedConversionServices(),
      package: vi.fn().mockRejectedValue(new OutlineArtifactError('preview.pdf')),
    };
    const view = render(<OneClickConverter services={services} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([PRESENTATION_STL], 'settled-failure.stl', { type: 'model/stl' }),
    );
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), 'acrylic-6');
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    await screen.findByRole('alert');

    const retained = view.container.querySelector<HTMLElement>('.failure-retained-preview')!;
    const figure = retained.querySelector<HTMLElement>('.outline-process-viewport')!;
    expect(retained).toHaveAttribute('data-settled', 'true');
    expect(figure).toHaveAttribute('data-effect-level', 'static');
    expect(Number.parseFloat(getComputedStyle(figure).opacity)).toBeLessThan(1);
    requestFrame.mockClear();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    expect(requestFrame).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    expect(screen.getByRole('heading', { name: '把陀螺模型 變成可製作的 三層切片' })).toBeVisible();
    requestFrame.mockRestore();
    view.unmount();
  });

  it('does not let an explicit false test seam opt out of live reduced motion', async () => {
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
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

    await waitFor(() => {
      expect(scene).toBeDefined();
      expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
      expect(scene!.scene.userData.effectLevel).toBe('static');
    });
    view.unmount();
  });

  it('updates an existing scene when rerendered from energy-saving to full', async () => {
    let scene: OutlineProcessScene | undefined;
    const createScene = vi.fn((host, payload, options) => {
      scene = createOutlineProcessScene(host, payload, options);
      return scene;
    });
    const source = browserPayload();
    const view = render(
      <OutlineProcessViewport
        payload={source}
        stage="slicing"
        effectLevel="energy-saving"
        reducedMotion={false}
        createScene={createScene}
      />,
    );

    await waitFor(() => expect(scene).toBeDefined());
    const setEffectLevel = vi.spyOn(scene!, 'setEffectLevel');
    view.rerender(
      <OutlineProcessViewport
        payload={source}
        stage="slicing"
        effectLevel="full"
        reducedMotion={false}
        createScene={createScene}
      />,
    );

    await waitFor(() => expect(setEffectLevel).toHaveBeenCalledWith('full'));
    expect(createScene).toHaveBeenCalledOnce();
    expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'full');
    view.unmount();
  });

  it('keeps real converter downloads and replacement usable after scene construction failure', async () => {
    const observeScene = vi.spyOn(ResizeObserver.prototype, 'observe')
      .mockImplementation(() => { throw new Error('synthetic scene construction failure'); });
    const user = userEvent.setup();
    const services = completedConversionServices();
    const view = render(<OneClickConverter services={services} />);
    try {
      await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'fallback-result.stl'));
      await user.selectOptions(await screen.findByLabelText('選擇製作材料'), 'acrylic-6');
      await user.click(screen.getByRole('button', { name: '開始製作' }));

      const fallback = await screen.findByRole('img', { name: /SVG fallback/ });
      expect(screen.getByRole('figure')).toHaveAttribute('data-renderer', 'fallback');
      expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
      expect(fallback.querySelectorAll('path').length).toBeGreaterThan(0);

      const link = screen.getByRole('link', { name: '下載 ZIP 製作套件' });
      expect(link).toHaveAttribute('href', 'blob:browser-zip');
      expect(link).toHaveAttribute('download', 'shapecut-files.zip');
      let componentPreventedClick: boolean | undefined;
      const observeClick = (event: MouseEvent) => {
        componentPreventedClick = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener('click', observeClick, { once: true });
      try {
        fireEvent.click(link);
      } finally {
        document.removeEventListener('click', observeClick);
      }
      expect(componentPreventedClick).toBe(false);

      await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['replacement'], 'fallback-replacement.stl'));
      expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
      expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'material');
    } finally {
      view.unmount();
      observeScene.mockRestore();
    }
  });

  it('disposes an active converter scene and its RAF when a model replaces it', async () => {
    const user = userEvent.setup();
    const active = activeConversionServices();
    const view = render(<OneClickConverter services={active.services} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['old'], 'old-model.stl'));
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), 'acrylic-6');
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    await act(async () => {
      active.report()?.({ stage: 'analyzing', preview: browserPayload() });
    });

    const oldCanvas = await waitFor(() => {
      const candidate = view.container.querySelector('.outline-process-viewport canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    try {
      await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['replacement'], 'replacement-model.stl'));

      await waitFor(() => {
        expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', 'material');
        expect(oldCanvas).not.toBeInTheDocument();
        expect(cancelFrame).toHaveBeenCalled();
        expect(geometryDispose).toHaveBeenCalled();
        expect(materialDispose).toHaveBeenCalled();
      });
      expect(screen.getByLabelText('選擇製作材料')).toBeVisible();
      expect(active.services.cancel).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      cancelFrame.mockRestore();
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
    }
  });

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

  it('degrades a live viewport to a static SVG exactly once after a runtime render exception', async () => {
    const canvas = document.createElement('canvas');
    let failRender = false;
    const renderer: OutlineProcessRenderer = {
      domElement: canvas,
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      render: vi.fn(() => {
        if (failRender) throw new Error('synthetic runtime render failure');
      }),
      dispose: vi.fn(),
      forceContextLoss: vi.fn(),
    };
    const createScene = (host: HTMLElement, payload: OutlinePreviewPayload, options: Parameters<typeof createOutlineProcessScene>[2]) =>
      createOutlineProcessScene(host, payload, { ...options, createRenderer: () => renderer });
    const source = browserPayload();
    const view = render(
      <OutlineProcessViewport payload={source} stage="analyzing" reducedMotion createScene={createScene} />,
    );
    await waitFor(() => expect(view.container.querySelector('canvas')).toBe(canvas));

    failRender = true;
    view.rerender(
      <OutlineProcessViewport payload={source} stage="slicing" reducedMotion createScene={createScene} />,
    );

    await waitFor(() => expect(screen.getByRole('figure')).toHaveAttribute('data-renderer', 'fallback'));
    expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    view.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it('poisons and destroys the default renderer after a runtime render exception instead of pooling it', async () => {
    const source = browserPayload();
    const view = render(<OutlineProcessViewport payload={source} stage="analyzing" reducedMotion />);
    const canvas = await waitFor(() => {
      const candidate = view.container.querySelector<HTMLCanvasElement>('canvas');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    expect(context).not.toBeNull();
    const renderFailure = vi.spyOn(context!, 'drawElements')
      .mockImplementationOnce(() => { throw new Error('poison default renderer'); });

    view.rerender(<OutlineProcessViewport payload={source} stage="slicing" reducedMotion />);

    await waitFor(() => expect(screen.getByRole('figure')).toHaveAttribute('data-renderer', 'fallback'));
    await waitFor(() => expect(context!.isContextLost()).toBe(true));
    renderFailure.mockRestore();
    view.unmount();
  });

  it('degrades a live viewport to a static SVG exactly once on webglcontextlost', async () => {
    const canvas = document.createElement('canvas');
    const renderer: OutlineProcessRenderer = {
      domElement: canvas,
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
      forceContextLoss: vi.fn(),
    };
    const createScene = (host: HTMLElement, payload: OutlinePreviewPayload, options: Parameters<typeof createOutlineProcessScene>[2]) =>
      createOutlineProcessScene(host, payload, { ...options, createRenderer: () => renderer });
    const view = render(
      <OutlineProcessViewport payload={browserPayload()} stage="analyzing" reducedMotion createScene={createScene} />,
    );
    await waitFor(() => expect(view.container.querySelector('canvas')).toBe(canvas));

    const loss = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(loss);

    expect(loss.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByRole('figure')).toHaveAttribute('data-renderer', 'fallback'));
    expect(screen.getByRole('figure')).toHaveAttribute('data-effect-level', 'static');
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    view.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
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
          deepFeatures: [feature(`maximum-red-${index}`, 'DEEP_RED')],
          lightFeatures: [feature(`maximum-blue-${index}`, 'LIGHT_BLUE')],
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
