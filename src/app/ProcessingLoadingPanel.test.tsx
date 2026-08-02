import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessingLoadingPanel } from './ProcessingLoadingPanel';

describe('ProcessingLoadingPanel', () => {
  afterEach(() => vi.useRealTimers());

  it('shows elapsed time from the shared file-selection timestamp and updates independently', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T02:03:04.000Z'));
    render(
      <ProcessingLoadingPanel
        title="正在讀取模型"
        fileName="Knight Fortress.stl"
        startedAt={Date.now() - 123_000}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByText('已處理 02:03')).toBeVisible();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('已處理 02:04')).toBeVisible();
    expect(screen.getByRole('button', { name: '取消處理' })).toBeVisible();
    expect(document.querySelector('.processing-orbit')).toBeInTheDocument();
  });
});
