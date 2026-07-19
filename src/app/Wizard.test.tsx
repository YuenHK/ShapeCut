import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AxisCandidate } from '../domain/axis/find-axis';
import { Wizard, type WizardServices } from './Wizard';

const axis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.94, confirmed: false,
  radialRmsError: 0.01, centroidOffset: 0, source: 'inertia',
};

function successfulServices(): WizardServices {
  return {
    inspect: vi.fn().mockResolvedValue({ candidates: [axis], issues: [] }),
    decompose: vi.fn().mockResolvedValue({ issues: [] }),
    engrave: vi.fn().mockResolvedValue({ issues: [] }),
    preflight: vi.fn().mockResolvedValue({ issues: [] }),
    exportKit: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Wizard', () => {
  it('locks future steps and preserves edited parameters when navigating back', async () => {
    const user = userEvent.setup();
    render(<Wizard services={successfulServices()} />);
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    const ribs = screen.getByLabelText('骨架數量');
    await user.clear(ribs);
    await user.type(ribs, '10');
    await user.click(screen.getByRole('button', { name: '軸心與尺寸' }));
    await user.click(screen.getByRole('button', { name: '自動拆件' }));

    expect(screen.getByLabelText('骨架數量')).toHaveValue(10);
  });

  it('keeps export disabled until the complete successful path passes', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl', { type: 'model/stl' }));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await user.clear(screen.getByLabelText('骨架數量'));
    await user.type(screen.getByLabelText('骨架數量'), '8');
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));

    await user.selectOptions(screen.getByLabelText('材料設定檔'), 'plywood-3');
    await user.selectOptions(screen.getByLabelText('雕刻級數'), '4');
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));

    expect(screen.getByRole('button', { name: '匯出製作套件' })).toBeEnabled();
    expect(services.decompose).toHaveBeenCalledWith(expect.objectContaining({ ribCount: 8 }));
  });

  it('keeps export blocked and links a blocking issue to its explanation', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    services.preflight = vi.fn().mockResolvedValue({
      issues: [{ id: 'sheet-too-small', severity: 'blocking', regionId: 'layout-sheet', label: '板材太細', description: '零件超出板材邊界。' }],
    });
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));

    const issue = await screen.findByRole('button', { name: /板材太細/ });
    expect(issue).toHaveAttribute('aria-describedby', 'sheet-too-small-description');
    expect(screen.getByRole('button', { name: '匯出製作套件' })).toBeDisabled();
  });
});
