import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { page } from 'vitest/browser';
import { it, expect, vi } from 'vitest';
import { App } from './App';
import '../styles.css';
import { workbenchResult } from '../test/workbench-result';
import type { OutlineDownloads } from './OneClickConverter';

it('fits upload and material controls within a 1280 by 720 desktop viewport', async () => {
  await page.viewport(1280, 720);
  render(<App services={{ convert: () => new Promise(() => {}), package: () => new Promise(() => {}), cancel: vi.fn() }} oneClickProjectRepository={{ load: async () => undefined, save: vi.fn(), delete: vi.fn() }} />);
  await screen.findByLabelText('選擇 STL 模型');
  await waitFor(() => expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight));
  await page.screenshot({ path: '../../.superpowers/workbench-upload-1280.png' });
  fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'test.stl')] } });
  await screen.findByRole('button', { name: '開始製作' });
  expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
  await page.screenshot({ path: '../../.superpowers/workbench-material-1280.png' });
});

for (const [width, height] of [[1280, 720], [1440, 900]]) {
  it(`keeps result downloads, every paginated detail, and keyboard tabs inside ${width} by ${height}`, async () => {
    await page.viewport(width, height);
    const downloads = Object.fromEntries(['zip', 'svg', 'dxf', 'previewPdf', 'explodedPdf', 'launcherCoupon'].map((key) => [key, { href: 'blob:' + key, fileName: key }])) as OutlineDownloads;
    render(<App services={{ convert: async () => workbenchResult, package: async () => downloads, cancel: vi.fn(),
      present: async () => workbenchResult.preview,
      createTimeline: (clock) => ({ advance: (stage, preview) => clock.onStage(stage, preview), finish: async () => {}, cancel: vi.fn() }),
    }} oneClickProjectRepository={{ load: async () => undefined, save: vi.fn(), delete: vi.fn() }} />);
    fireEvent.change(await screen.findByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'test.stl')] } });
    await screen.findByRole('button', { name: '開始製作' });
    await page.screenshot({ path: `../../.superpowers/workbench-material-preview-${width}.png` });
    fireEvent.click(screen.getByRole('button', { name: '開始製作' }));
    await screen.findByRole('heading', { name: '轉換完成' });
    const assertBounds = () => {
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(height);
      const panel = screen.getByRole('tabpanel');
      expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight);
      const detailPage = panel.querySelector<HTMLElement>('.detail-pages');
      if (detailPage) expect(detailPage.scrollHeight).toBeLessThanOrEqual(detailPage.clientHeight);
      for (const el of document.querySelectorAll('.result-actions a, .result-actions label')) {
        const rect = el.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(height);
        expect(rect.right).toBeLessThanOrEqual(width);
      }
    };
    expect(document.querySelectorAll('.result-actions a[download]')).toHaveLength(6);
    expect(screen.getByText('成品總厚度')).toBeVisible();
    expect(screen.getByText('18 mm')).toBeVisible();
    expect(screen.getByRole('option', { name: '下層：layer-0' })).toBeInTheDocument();
    expect(screen.getByText('模型軸向高度')).toBeVisible();
    assertBounds();
    await page.screenshot({ path: `../../.superpowers/workbench-result-${width}.png` });
    const settingsNext = screen.getByRole('button', { name: '製作設定下一頁' });
    while (!(settingsNext as HTMLButtonElement).disabled) { fireEvent.click(settingsNext); assertBounds(); }
    expect(screen.getByText('三爪區藍色處理')).toBeVisible();
    const settings = screen.getByRole('tab', { name: '製作設定' });
    settings.focus(); fireEvent.keyDown(settings, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '處理提示' })).toHaveFocus();
    assertBounds();
    fireEvent.keyDown(screen.getByRole('tab', { name: '處理提示' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '技術資料' })).toHaveFocus();
    assertBounds();
    expect(screen.queryByText(/ZIP 內含 cut-and-engrave\.svg/)).not.toBeInTheDocument();
    const technicalNext = screen.getByRole('button', { name: '技術資料下一頁' });
    while (!(technicalNext as HTMLButtonElement).disabled) { fireEvent.click(technicalNext); assertBounds(); }
    expect(screen.getByText(/ZIP 內含 cut-and-engrave\.svg/)).toBeVisible();
  });
}
