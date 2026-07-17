import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AxisCandidate } from '../../domain/axis/find-axis';
import { AxisStep } from './AxisStep';

const candidate: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.92, confirmed: false,
  radialRmsError: 0.02, centroidOffset: 0, source: 'inertia',
};

describe('AxisStep', () => {
  it('shows the top confidence and enables the next step for a confirmed axis', () => {
    render(<AxisStep candidates={[candidate]} confirmedAxis={{ ...candidate, confirmed: true }} onConfirm={() => undefined} />);
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });

  it('requires confirmation for a low confidence candidate', async () => {
    const low = { ...candidate, confidence: 0.61 };
    const onConfirm = vi.fn();
    render(<AxisStep candidates={[low]} onConfirm={onConfirm} />);
    expect(screen.getByText('需要確認')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '確認軸心' }));
    expect(onConfirm).toHaveBeenCalledWith(low);
  });

  it('offers the optional manual-axis action', async () => {
    const onManualRequest = vi.fn();
    render(<AxisStep candidates={[candidate]} onConfirm={() => undefined} onManualRequest={onManualRequest} />);
    await userEvent.click(screen.getByRole('button', { name: '手動設定軸心' }));
    expect(onManualRequest).toHaveBeenCalledOnce();
  });

  it('displays and confirms the highest-confidence candidate regardless of input order', async () => {
    const lower = { ...candidate, confidence: 0.55 };
    const onConfirm = vi.fn();
    render(<AxisStep candidates={[lower, candidate]} onConfirm={onConfirm} />);
    expect(screen.getByText('92%')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '確認軸心' }));
    expect(onConfirm).toHaveBeenCalledWith(candidate);
  });
});
