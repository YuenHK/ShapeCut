import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionSurface } from './MotionSurface';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MotionSurface', () => {
  it('responds on pointer down and releases without disabling input', () => {
    const onPointerDown = vi.fn();
    render(<MotionSurface as="button" level="full" onPointerDown={onPointerDown}>開始</MotionSurface>);
    const button = screen.getByRole('button', { name: '開始' });
    const setPointerCapture = vi.fn();
    Object.assign(button, { setPointerCapture });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    fireEvent(button, pointerDown);
    expect(button).toHaveAttribute('data-pressed', 'true');
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(onPointerDown).toHaveBeenCalledOnce();
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(button).toHaveAttribute('data-pressed', 'false');
    expect(button).not.toBeDisabled();
  });

  it('uses static feedback when motion is reduced', () => {
    render(<MotionSurface as="button" level="static">下載</MotionSurface>);
    const button = screen.getByRole('button', { name: '下載' });
    fireEvent.pointerDown(button, { pointerId: 1 });

    expect(button).toHaveAttribute('data-motion', 'static');
    expect(button).toHaveStyle({ '--press-scale': '0.97' });
  });

  it('gives non-native surfaces keyboard press and release parity', () => {
    render(<MotionSurface as="div" level="static">預覽</MotionSurface>);
    const surface = screen.getByRole('button', { name: '預覽' });

    expect(surface).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(surface, { key: 'Enter' });
    expect(surface).toHaveAttribute('data-pressed', 'true');
    fireEvent.keyUp(surface, { key: 'Enter' });
    expect(surface).toHaveAttribute('data-pressed', 'false');
  });

  it('renders anchor props and cancels its owned frame on unmount', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<MotionSurface as="a" href="/download" level="full">下載套件</MotionSurface>);
    const link = screen.getByRole('link', { name: '下載套件' });

    fireEvent.pointerDown(link, { pointerId: 1 });
    expect(link).toHaveAttribute('href', '/download');
    expect(requestFrame).toHaveBeenCalledOnce();
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(41);
  });
});
