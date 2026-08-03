import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessingLoadingPanel } from './ProcessingLoadingPanel';

describe('ProcessingLoadingPanel', () => {
  afterEach(() => vi.useRealTimers());

  it('updates visible elapsed time every second but politely announces only every 30 seconds or stage', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T02:03:04.000Z'));
    const view = render(
      <ProcessingLoadingPanel
        title="正在讀取模型"
        fileName="Knight Fortress.stl"
        startedAt={Date.now() - 123_000}
        onCancel={() => undefined}
      />,
    );

    const elapsed = screen.getByText('已處理 02:03');
    expect(elapsed).toBeVisible();
    expect(elapsed).not.toHaveAttribute('aria-live');
    const announcement = document.querySelector('.processing-elapsed-announcement');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveTextContent('正在讀取模型，已處理 02:03');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('已處理 02:04')).toBeVisible();
    expect(announcement).toHaveTextContent('正在讀取模型，已處理 02:03');
    act(() => vi.advanceTimersByTime(26_000));
    expect(screen.getByText('已處理 02:30')).toBeVisible();
    expect(announcement).toHaveTextContent('正在讀取模型，已處理 02:30');
    view.rerender(
      <ProcessingLoadingPanel
        title="正在分析模型"
        fileName="Knight Fortress.stl"
        startedAt={Date.now() - 150_000}
        onCancel={() => undefined}
      />,
    );
    expect(announcement).toHaveTextContent('正在分析模型，已處理 02:30');
    expect(screen.getByRole('button', { name: '取消處理' })).toBeVisible();
    expect(document.querySelector('.processing-orbit')).toBeInTheDocument();
  });
});
