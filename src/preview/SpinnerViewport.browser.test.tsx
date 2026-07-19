import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SceneController } from './scene-controller';
import { SpinnerViewport } from './SpinnerViewport';

function fakeController(): SceneController {
  return {
    setMesh: vi.fn(),
    setParts: vi.fn(),
    setExploded: vi.fn(),
    setEngraving: vi.fn(),
    selectPart: vi.fn(),
    focusRegion: vi.fn(),
    dispose: vi.fn(),
  };
}

const thinWallIssue = {
  id: 'thin-wall-1',
  regionId: 'rib-edge-4',
  severity: 'blocking' as const,
  label: '薄壁區域',
  description: '剩餘材料厚度低於安全下限。',
};

describe('SpinnerViewport', () => {
  it('creates and removes the real WebGL canvas', () => {
    const view = render(<SpinnerViewport issues={[]} />);
    expect(view.container.querySelector('canvas')).toBeInTheDocument();

    view.unmount();

    expect(view.container.querySelector('canvas')).not.toBeInTheDocument();
  });

  it('releases the real WebGL canvas across 20 mount cycles', () => {
    for (let index = 0; index < 20; index += 1) {
      const view = render(<SpinnerViewport issues={[]} />);
      expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
      view.unmount();
      expect(view.container.querySelectorAll('canvas')).toHaveLength(0);
    }
  });

  it('focuses the referenced geometry issue', async () => {
    const controller = fakeController();
    render(<SpinnerViewport issues={[thinWallIssue]} createController={() => controller} />);

    await userEvent.click(screen.getByRole('button', { name: /薄壁區域/i }));

    expect(controller.focusRegion).toHaveBeenCalledWith(thinWallIssue.regionId);
  });

  it('updates exploded transforms from an accessible range control', async () => {
    const controller = fakeController();
    render(<SpinnerViewport issues={[]} createController={() => controller} />);

    const slider = screen.getByRole('slider', { name: '爆炸圖距離' });
    fireEvent.change(slider, { target: { value: '0.2' } });

    expect(controller.setExploded).toHaveBeenLastCalledWith(0.2);
  });

  it('disposes every scene controller across 20 mount cycles', () => {
    const controllers: SceneController[] = [];
    for (let index = 0; index < 20; index += 1) {
      const controller = fakeController();
      controllers.push(controller);
      const view = render(<SpinnerViewport issues={[]} createController={() => controller} />);
      view.unmount();
    }

    for (const controller of controllers) expect(controller.dispose).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-spinner-viewport]')).toHaveLength(0);
  });
});
