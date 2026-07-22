import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ColoredOutlineLayer, FeatureContour, OutlinePreviewPayload } from '../domain/outline-features/types';
import { OutlineProcessViewport, type OutlineProcessSceneFactory } from './OutlineProcessViewport';
import type { OutlineProcessScene } from './outline-process-scene';

function contour(id: string, role: FeatureContour['role'], outer: FeatureContour['outer']): FeatureContour {
  const xs = outer.map(([x]) => x), ys = outer.map(([, y]) => y);
  return {
    id, role, outer,
    boundsMm: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    areaMm2: 1,
  };
}

function payload(suffix = '', count = 6): OutlinePreviewPayload {
  const layers: ColoredOutlineLayer[] = Array.from({ length: count }, (_, index) => ({
    id: `layer-${index}${suffix}`, index, zStart: index, zEnd: index + 1,
    exterior: contour(`exterior-${index}${suffix}`, 'CUT_BLACK', [[0, 0], [20, 0], [20, 10], [0, 10]]),
    centralHole: index === 0
      ? contour(`hole-${index}${suffix}`, 'CUT_BLACK', [[8, 4], [12, 4], [12, 6], [8, 6]])
      : undefined,
    launcherCuts: index === 0
      ? [contour(`launcher-${index}${suffix}`, 'CUT_BLACK', [[1, 6], [3, 6], [3, 8], [1, 8]])]
      : [],
    fastenerHoles: index === 0
      ? [contour(`fastener-${index}${suffix}`, 'CUT_BLACK', [[16, 1], [18, 1], [18, 3], [16, 3]])]
      : [],
    deepFeatures: index === 1
      ? [contour(`red-${index}${suffix}`, 'DEEP_RED', [[1, 1], [5, 1], [5, 4], [1, 4]])]
      : [],
    lightFeatures: index === 2
      ? [contour(`blue-${index}${suffix}`, 'LIGHT_BLUE', [[14, 6], [19, 6], [19, 9], [14, 9]])]
      : [],
    removedComponentCount: 0,
    diagnostics: {
      hole: index === 0
        ? { status: 'retained' as const, equivalentDiameterMm: 4, axisDistanceMm: 0 }
        : { status: 'omitted' as const },
      depth: { cellSizeMm: 0.2, contrastMm: 1, redThresholdMm: 0.8, blueThresholdMm: 0.4 },
    },
  }));
  return {
    mesh: {
      positions: Float32Array.from([0, 0, 0, 20, 0, 0, 0, 10, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    },
    axis: {
      origin: [10, 5, 0], direction: [0, 0, 1],
      planeX: [0, 1, 0], planeY: [-1, 0, 0],
    },
    layers,
  };
}

function maximumFallbackPayload(): OutlinePreviewPayload {
  const outer = Array.from({ length: 4_096 }, (_, index) => {
    const angle = index / 4_096 * Math.PI * 2;
    return [50 * Math.cos(angle), 50 * Math.sin(angle)] as const;
  });
  const source = payload('', 24);
  return {
    ...source,
    layers: source.layers.map((item, index) => ({
      ...item,
      exterior: contour(`maximum-exterior-${index}`, 'CUT_BLACK', outer),
      centralHole: contour(`maximum-hole-${index}`, 'CUT_BLACK', outer),
      launcherCuts: [], fastenerHoles: [],
      deepFeatures: [contour(`maximum-red-${index}`, 'DEEP_RED', outer)],
      lightFeatures: [contour(`maximum-blue-${index}`, 'LIGHT_BLUE', outer)],
    })),
  };
}

function fakeScene(): OutlineProcessScene {
  return {
    setPayload: vi.fn(), setStage: vi.fn(), setReducedMotion: vi.fn(), setVisible: vi.fn(),
    setHighlightedLayer: vi.fn(), rotateBy: vi.fn(), zoomBy: vi.fn(), resetView: vi.fn(), dispose: vi.fn(),
  } as unknown as OutlineProcessScene;
}

describe('OutlineProcessViewport', () => {
  it('hydrates, replaces, and disposes the scene through an accessible boundary', () => {
    const scene = fakeScene();
    const createScene = vi.fn<OutlineProcessSceneFactory>(() => scene);
    const first = payload();
    const view = render(
      <OutlineProcessViewport payload={first} stage="slicing" reducedMotion createScene={createScene} />,
    );
    const viewport = screen.getByRole('img', { name: /模型分層預覽/ });

    expect(viewport).toHaveAttribute('data-layer-count', '6');
    expect(scene.setPayload).not.toHaveBeenCalled();
    expect(scene.setStage).toHaveBeenCalledWith('slicing');
    expect(scene.setReducedMotion).toHaveBeenCalledWith(true);

    const replacement = payload('-new', 7);
    view.rerender(
      <OutlineProcessViewport payload={replacement} stage="packaging" reducedMotion createScene={createScene} />,
    );
    expect(screen.getByRole('img', { name: /模型分層預覽/ })).toHaveAttribute('data-layer-count', '7');
    expect(scene.setPayload).toHaveBeenLastCalledWith(replacement);
    expect(scene.setPayload).toHaveBeenCalledTimes(1);
    expect(scene.setStage).toHaveBeenLastCalledWith('packaging');

    view.unmount();
    expect(scene.dispose).toHaveBeenCalledOnce();
  });

  it('renders exterior, central/launcher/fastener cuts, red, and blue actual geometry when WebGL is unavailable', () => {
    render(<OutlineProcessViewport payload={payload()} stage="slicing" reducedMotion />);

    const fallback = screen.getByRole('img', { name: /模型分層預覽.*SVG/ });
    expect(fallback).toHaveAttribute('data-layer-count', '6');
    expect(fallback.querySelector('[data-feature-id="exterior-0"]')).toHaveAttribute('stroke', '#000000');
    expect(fallback.querySelector('[data-feature-id="hole-0"]')).toHaveAttribute('stroke', '#000000');
    expect(fallback.querySelector('[data-feature-id="launcher-0"]')).toHaveAttribute('stroke', '#000000');
    expect(fallback.querySelector('[data-feature-id="fastener-0"]')).toHaveAttribute('stroke', '#000000');
    expect(fallback.querySelector('[data-feature-id="red-1"]')).toHaveAttribute('stroke', '#E5484D');
    expect(fallback.querySelector('[data-feature-id="blue-2"]')).toHaveAttribute('stroke', '#3A78D4');
    expect(fallback.querySelector('[data-feature-id="exterior-0"]')).toHaveAttribute('d', 'M 0 0 L 20 0 L 20 10 L 0 10 Z');
    expect(screen.getByText(/WebGL.*SVG/)).toBeVisible();
    expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('projects the bounded mesh when analyzing has no layers in SVG fallback', () => {
    const analyzing = { ...payload(), layers: [] };
    render(<OutlineProcessViewport payload={analyzing} stage="analyzing" reducedMotion />);

    const fallback = screen.getByRole('img', { name: /SVG/ });
    expect(fallback.querySelector('[data-preview-mesh]')).toHaveAttribute('d', expect.stringContaining('M'));
    expect(fallback.getAttribute('viewBox')).not.toBe('0 0 1 1');
    expect(screen.getByRole('status')).toHaveTextContent('實際模型線框');
    expect(screen.getByRole('status')).not.toHaveTextContent('實際輪廓');
  });

  it('announces a completed result without manual controls while retaining the layer selector', () => {
    const scene = fakeScene();
    const createScene = vi.fn<OutlineProcessSceneFactory>(() => scene);
    const { container } = render(
      <OutlineProcessViewport payload={payload()} stage="result" reducedMotion createScene={createScene} />,
    );

    expect(container.querySelector('.outline-process-viewport')).toHaveAttribute('data-stage', 'result');
    expect(screen.getByRole('status')).toHaveTextContent(/轉換完成.*模型分層預覽/);
    expect(screen.queryByRole('group', { name: '模型預覽控制' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /旋轉|縮小|放大|重設/ })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '選擇預覽切片' })).toBeInTheDocument();
    expect(createScene.mock.calls[0][2]).toMatchObject({ stage: 'packaging' });
    expect(scene.setStage).toHaveBeenLastCalledWith('packaging');
  });

  it('separates layer contours deterministically in the SVG exploded result', () => {
    render(<OutlineProcessViewport payload={payload('', 3)} stage="packaging" reducedMotion />);

    const fallback = screen.getByRole('img', { name: /SVG/ });
    const transforms = Array.from(fallback.querySelectorAll('[data-layer-id]'), (group) => group.getAttribute('transform'));
    expect(new Set(transforms).size).toBe(3);
    expect(transforms).toEqual(['translate(0 -6)', 'translate(0 0)', 'translate(0 6)']);
  });

  it('lists ordered layers and highlights one layer in both the scene and SVG fallback', async () => {
    const user = userEvent.setup();
    const scene = fakeScene();
    const { rerender } = render(
      <OutlineProcessViewport payload={payload('', 3)} stage="result" reducedMotion createScene={() => scene} />,
    );

    const selector = screen.getByRole('combobox', { name: '選擇預覽切片' });
    expect(selector).toHaveValue('layer-0');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '第 1 層：layer-0', '第 2 層：layer-1', '第 3 層：layer-2',
    ]);
    await user.selectOptions(selector, 'layer-2');
    expect(scene.setHighlightedLayer).toHaveBeenLastCalledWith('layer-2');

    rerender(<OutlineProcessViewport payload={payload('', 3)} stage="result" reducedMotion />);
    const fallback = screen.getByRole('img', { name: /SVG/ });
    expect(fallback.querySelector('[data-layer-id="layer-2"]')).toHaveAttribute('data-selected', 'true');
    expect(fallback.querySelector('[data-layer-id="layer-0"]')).toHaveAttribute('data-selected', 'false');
  });

  it('clears a selected layer when a replacement payload no longer contains it', async () => {
    const user = userEvent.setup();
    const scene = fakeScene();
    const view = render(
      <OutlineProcessViewport payload={payload('', 3)} stage="result" reducedMotion createScene={() => scene} />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: '選擇預覽切片' }), 'layer-2');
    view.rerender(
      <OutlineProcessViewport payload={payload('-replacement', 2)} stage="result" reducedMotion createScene={() => scene} />,
    );
    expect(screen.getByRole('combobox', { name: '選擇預覽切片' })).toHaveValue('layer-0-replacement');
    expect(scene.setHighlightedLayer).toHaveBeenLastCalledWith('layer-0-replacement');
  });

  it('renders the legal maximum fallback geometry without spreading the full point set', () => {
    expect(() => render(
      <OutlineProcessViewport payload={maximumFallbackPayload()} stage="slicing" reducedMotion />,
    )).not.toThrow();

    const fallback = screen.getByRole('img', { name: /SVG/ });
    expect(fallback.querySelectorAll('path')).toHaveLength(24 * 4);
    expect(fallback.getAttribute('viewBox')).not.toMatch(/NaN|Infinity/);
  });

  it('falls back without leaking a partially constructed scene when construction fails', () => {
    const dispose = vi.fn();
    const createScene = vi.fn(() => {
      const error = new Error('renderer construction failed') as Error & { partialScene?: { dispose(): void } };
      error.partialScene = { dispose };
      throw error;
    });
    render(<OutlineProcessViewport payload={payload()} stage="analyzing" createScene={createScene} />);

    expect(screen.getByRole('img', { name: /SVG/ })).toBeVisible();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
