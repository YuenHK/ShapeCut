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
    expect(screen.getByText('需要手動設定')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '確認軸心' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
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

  it('requires manual entry when no candidate exists and normalizes a finite non-zero direction', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AxisStep candidates={[]} onConfirm={onConfirm} />);

    expect(screen.getByText('未找到候選軸心')).toBeVisible();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
    await user.type(screen.getByLabelText('手動原點 X'), '10');
    await user.type(screen.getByLabelText('手動原點 Y'), '-2');
    await user.type(screen.getByLabelText('手動原點 Z'), '4');
    await user.type(screen.getByLabelText('手動方向 X'), '0');
    await user.type(screen.getByLabelText('手動方向 Y'), '3');
    await user.type(screen.getByLabelText('手動方向 Z'), '4');
    await user.click(screen.getByRole('button', { name: '確認手動軸心' }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      origin: [10, -2, 4],
      direction: [0, 0.6, 0.8],
      confirmed: false,
      source: 'manual',
    }));
  });

  it('rejects blank, non-finite, and zero manual directions', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<AxisStep candidates={[]} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: '確認手動軸心' });
    expect(confirm).toBeDisabled();
    for (const label of ['手動原點 X', '手動原點 Y', '手動原點 Z', '手動方向 X', '手動方向 Y', '手動方向 Z']) {
      await user.type(screen.getByLabelText(label), '0');
    }
    expect(screen.getByRole('alert')).toHaveTextContent(/非零/);
    expect(confirm).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('never enables next for an unconfirmed axis even when a high-confidence candidate exists', () => {
    render(<AxisStep candidates={[candidate]} confirmedAxis={{ ...candidate, confirmed: false }} onConfirm={() => undefined} />);

    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  });
});
