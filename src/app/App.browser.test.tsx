import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { App } from './App';
import type { OneClickConverterServices } from './OneClickConverter';

describe('App real browser one-click flow', () => {
  it('starts from one keyboard-accessible selection and renders the result downloads', async () => {
    const user = userEvent.setup();
    const result = {
      sourceHash: 'c'.repeat(32), mode: 'exact', status: 'success', warnings: [], layers: [{
        id: 'layer-0', index: 0, zStart: 0, zEnd: 1,
        contour: { outer: [[0, 0], [10, 0], [10, 5], [0, 5]], holes: [] },
        sourceAreaMm2: 50, simplifiedAreaMm2: 50,
        sourceBoundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
      }],
    } as unknown as AutomaticOutlineResult;
    const services: OneClickConverterServices = {
      cancel: vi.fn(),
      convert: vi.fn().mockResolvedValue(result),
      package: vi.fn().mockResolvedValue({
        zip: { href: 'blob:zip', fileName: 'shape.zip' }, svg: { href: 'blob:svg', fileName: 'shape.svg' },
        dxf: { href: 'blob:dxf', fileName: 'shape.dxf' }, pdf: { href: 'blob:pdf', fileName: 'shape.pdf' },
        json: { href: 'blob:json', fileName: 'shape.json' },
      }),
    };
    render(<App services={services} />);

    const input = screen.getByLabelText('選擇 STL 模型');
    input.focus();
    await user.upload(input, new File(['mesh'], 'keyboard.stl', { type: 'model/stl' }));

    expect(await screen.findByRole('link', { name: '下載 ZIP 製作套件' })).toBeVisible();
    const technicalSummary = screen.getByText('技術資料');
    technicalSummary.focus();
    await user.keyboard('{Enter}');
    expect(technicalSummary.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('img', { name: '實際外形切片預覽' })).toHaveAttribute('viewBox', '0 0 10 5');
    expect(services.convert).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /修復|軸心|下一步|材料|分件/ })).toBeNull();
  });
});
