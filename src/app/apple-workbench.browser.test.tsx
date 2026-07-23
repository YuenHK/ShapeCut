import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cdp, page } from '@vitest/browser/context';
import type {} from '@vitest/browser/providers/playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import stylesText from '../styles.css?raw';
import '../styles.css';
import { READY_TEST_MATERIAL } from '../test/ready-material';
import { App } from './App';
import type { OneClickConverterServices } from './OneClickConverter';

function services(): OneClickConverterServices {
  return {
    convert: vi.fn(() => new Promise<never>(() => undefined)),
    package: vi.fn(() => new Promise<never>(() => undefined)),
    cancel: vi.fn(),
  };
}

type Rgb = readonly [number, number, number];

function luminance([red, green, blue]: Rgb): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + .05) / (darker + .05);
}

function gradientStops(backgroundImage: string): Rgb[] {
  return [...backgroundImage.matchAll(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gu)]
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const);
}

function expectWhiteTextContrast(element: HTMLElement): void {
  const stops = gradientStops(getComputedStyle(element).backgroundImage);
  expect(stops).toHaveLength(2);
  for (const stop of stops) {
    expect(contrastRatio([255, 255, 255], stop)).toBeGreaterThanOrEqual(4.5);
  }
}

async function renderProcessingSurfaces(): Promise<readonly HTMLElement[]> {
  const activeServices: OneClickConverterServices = {
    ...services(),
    materialProfiles: [READY_TEST_MATERIAL],
    createTimeline: (clock) => ({
      advance: (stage, preview) => clock.onStage(stage, preview),
      finish: () => Promise.resolve(),
      cancel: vi.fn(),
    }),
    convert: vi.fn((_bytes, _material, onProgress) => {
      void onProgress?.({
        stage: 'analyzing',
        preview: {
          mesh: {
            positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 5, 0]),
            indices: new Uint32Array([0, 1, 2]),
          },
          axis: {
            origin: [0, 0, 0],
            direction: [0, 0, 1],
            planeX: [0, 1, 0],
            planeY: [-1, 0, 0],
          },
          layers: [],
        },
      });
      return new Promise<never>(() => undefined);
    }),
  };
  render(<App services={activeServices} />);
  fireEvent.change(screen.getByLabelText('選擇 STL 模型'), {
    target: { files: [new File(['mesh'], 'media-query.stl', { type: 'model/stl' })] },
  });
  fireEvent.change(await screen.findByLabelText('選擇製作材料'), {
    target: { value: READY_TEST_MATERIAL.id },
  });
  await waitFor(() => {
    expect(document.querySelector('.processing-status-overlay')).toBeTruthy();
  });
  return [
    screen.getByRole('banner'),
    document.querySelector<HTMLElement>('.converter-card')!,
    document.querySelector<HTMLElement>('.processing-status-overlay')!,
  ];
}

afterEach(async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  await page.viewport(1024, 768);
});

describe('Apple workbench visual contracts', () => {
  it('exposes centralized glass tokens, adaptive effects, and a 48px primary action', async () => {
    render(<App services={services()} />);

    const workbench = screen.getByTestId('apple-workbench');
    expect(getComputedStyle(workbench).getPropertyValue('--glass-blur')).not.toBe('');
    expect(workbench.getAttribute('data-effect-level')).toMatch(/full|energy-saving|static/);

    fireEvent.change(screen.getByLabelText('選擇 STL 模型'), {
      target: { files: [new File(['not an stl'], 'invalid.txt', { type: 'text/plain' })] },
    });
    const primaryAction = screen.getByRole('button', { name: /選擇/ });
    expect(getComputedStyle(primaryAction).minHeight).toBe('48px');
    expect(getComputedStyle(primaryAction).willChange).toBe('auto');
    expectWhiteTextContrast(primaryAction);
    await page.getByRole('button', { name: /選擇/ }).hover();
    expectWhiteTextContrast(primaryAction);
  });

  it('keeps the main action visible at 390px without horizontal page overflow', async () => {
    await page.viewport(390, 844);
    render(<App services={services()} />);
    fireEvent.change(screen.getByLabelText('選擇 STL 模型'), {
      target: { files: [new File(['not an stl'], 'invalid.txt', { type: 'text/plain' })] },
    });

    const action = screen.getByRole('button', { name: /選擇/ });
    const bounds = action.getBoundingClientRect();
    expect(action).toBeVisible();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it('tracks bounded drag attraction and clears it on leave, drop, static mode, and unmount', async () => {
    const view = render(<App services={services()} />);
    const target = screen.getByText('拖放 STL 到這裏').closest('label')!;
    await waitFor(() => {
      expect(screen.getByTestId('apple-workbench')).not.toHaveAttribute('data-effect-level', 'static');
    });
    const bounds = target.getBoundingClientRect();
    const enterAtEdge = () => fireEvent.dragEnter(target, {
      clientX: bounds.right + 1_000,
      clientY: bounds.top - 1_000,
    });

    enterAtEdge();
    expect(target.style.getPropertyValue('--drag-attract-x')).toBe('12px');
    expect(target.style.getPropertyValue('--drag-attract-y')).toBe('-12px');

    fireEvent.dragLeave(target);
    expect(target.style.getPropertyValue('--drag-attract-x')).toBe('');
    expect(target.style.getPropertyValue('--drag-attract-y')).toBe('');

    enterAtEdge();
    fireEvent.drop(target, { dataTransfer: new DataTransfer() });
    expect(target.style.getPropertyValue('--drag-attract-x')).toBe('');
    expect(target.style.getPropertyValue('--drag-attract-y')).toBe('');

    enterAtEdge();
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await waitFor(() => {
      expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-effect-level', 'static');
      expect(target.style.getPropertyValue('--drag-attract-x')).toBe('');
      expect(target.style.getPropertyValue('--drag-attract-y')).toBe('');
    });

    await cdp().send('Emulation.setEmulatedMedia', { features: [] });
    await waitFor(() => {
      expect(screen.getByTestId('apple-workbench')).not.toHaveAttribute('data-effect-level', 'static');
    });
    enterAtEdge();
    view.unmount();
    expect(target.style.getPropertyValue('--drag-attract-x')).toBe('');
    expect(target.style.getPropertyValue('--drag-attract-y')).toBe('');
  });

  it('makes reduced motion authoritative for the rendered effect level', async () => {
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);

    render(<App services={services()} />);

    await waitFor(() => {
      expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-effect-level', 'static');
    });
    const orbit = document.querySelector<HTMLElement>('.workbench-orbit');
    expect(orbit).toBeTruthy();
    expect(getComputedStyle(orbit!).animationName).toBe('none');
    expect(getComputedStyle(orbit!).transform).toBe('none');
  });

  it('uses solid glass and removes backdrop blur when reduced transparency is emulated', async () => {
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    expect(window.matchMedia('(prefers-reduced-transparency: reduce)').matches).toBe(true);

    for (const surface of await renderProcessingSurfaces()) {
      const style = getComputedStyle(surface);
      expect(style.backgroundColor).toBe('rgba(255, 255, 255, 0.94)');
      expect(style.backdropFilter).toBe('none');
    }
  });

  it('uses solid white glass and a defined border when high contrast is emulated', async () => {
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-contrast', value: 'more' }],
    });
    expect(window.matchMedia('(prefers-contrast: more)').matches).toBe(true);

    for (const surface of await renderProcessingSurfaces()) {
      const style = getComputedStyle(surface);
      expect(style.backgroundColor).toBe('rgb(255, 255, 255)');
      expect(style.borderColor).toBe('rgb(48, 67, 93)');
    }
  });

  it('ships independent reduced-motion, reduced-transparency, and high-contrast CSS fallbacks', () => {
    const css = stylesText.replace(/\s+/gu, ' ');

    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.workbench-orbit, .workbench-grid, .workbench-particle { animation: none !important; transform: none !important; }');
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(css).toContain('.site-header, .converter-card, .processing-status-overlay { background: var(--glass-solid); backdrop-filter: none; }');
    expect(css).toContain('@media (prefers-contrast: more)');
    expect(css).toContain('.site-header, .converter-card, .processing-status-overlay { background: #fff; border-color: #30435d; }');
  });
});
