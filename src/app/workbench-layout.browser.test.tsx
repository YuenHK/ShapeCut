import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { page, userEvent } from 'vitest/browser';
import { it, expect, vi } from 'vitest';
import { App } from './App';
import '../styles.css';
import { workbenchResult } from '../test/workbench-result';
import type { OutlineDownloads, OneClickConverterServices } from './OneClickConverter';
import type { StoredOneClickProjectV3 } from '../persistence/one-click-project-repository';
import layoutProbeFontUrl from '../domain/part-engraving/assets/NotoSansCJKtc-Regular.otf?url';

it('fits mobile chrome and desktop result details with Noto CJK fallback font metrics', async () => {
  const font = await new FontFace('Layout Probe CJK', `url(${layoutProbeFontUrl})`).load();
  document.fonts.add(font);
  const downloads = Object.fromEntries(['zip', 'svg', 'dxf', 'previewPdf', 'explodedPdf', 'launcherCoupon'].map(key => [key, { href: 'blob:' + key, fileName: key }])) as OutlineDownloads;
  const view = render(<div style={{ fontFamily: 'Arial, "Layout Probe CJK", sans-serif' }}><App services={{
    convert: async () => workbenchResult, package: async () => downloads, cancel: vi.fn(),
    present: async () => workbenchResult.preview,
    createTimeline: (clock) => ({ advance: (stage, preview) => clock.onStage(stage, preview), finish: async () => {}, cancel: vi.fn() }),
  }} oneClickProjectRepository={{ load: async () => undefined, save: vi.fn(), delete: vi.fn() }} /></div>);
  try {
    await page.viewport(390, 844);
    await screen.findByLabelText('選擇 STL 模型');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(document.querySelector('.guided-wayfinding')!.getBoundingClientRect().right).toBeLessThanOrEqual(document.querySelector('.current-step-slot')!.getBoundingClientRect().right);
    await page.screenshot({ path: '../../.superpowers/guided-font-metrics-mobile.png' });
    await page.viewport(1280, 720);
    fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'font-metrics.stl')] } });
    fireEvent.click(await screen.findByRole('button', { name: '開始製作' }));
    await screen.findByRole('heading', { name: '轉換完成' });
    expect(document.querySelector('.site-header')!.getBoundingClientRect().height).toBeLessThanOrEqual(72);
    for (const label of ['製作設定', '處理提示', '技術資料']) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      const assertFits = () => {
        const panel = screen.getByRole('tabpanel');
        expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight);
        expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(720);
      };
      assertFits();
      const next = screen.queryByRole('button', { name: `${label}下一頁` });
      while (next && !(next as HTMLButtonElement).disabled) {
        fireEvent.click(next);
        assertFits();
      }
    }
    await page.screenshot({ path: '../../.superpowers/guided-font-metrics-desktop.png' });
  } finally {
    view.unmount();
    document.fonts.delete(font);
  }
});

it('keeps the same preview and footer bounds while making slices and exposes one cancel action', async () => {
  await page.viewport(1280, 720);
  const cancel = vi.fn();
  render(<App services={{
    present: async () => workbenchResult.preview,
    convert: (_bytes, _material, _fit, onProgress) => {
      void onProgress?.({ stage: 'analyzing', preview: workbenchResult.preview });
      return new Promise(() => {});
    },
    package: () => new Promise(() => {}), cancel,
    createTimeline: (clock) => ({ advance: (stage, preview) => clock.onStage(stage, preview), finish: async () => {}, cancel: vi.fn() }),
  }} oneClickProjectRepository={{ load: async () => undefined, save: vi.fn(), delete: vi.fn() }} />);
  fireEvent.change(await screen.findByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'processing.stl')] } });
  await screen.findByRole('button', { name: '開始製作' });
  const before = document.querySelector('.guided-preview')!.getBoundingClientRect();
  fireEvent.click(screen.getByRole('button', { name: '開始製作' }));
  await screen.findByRole('heading', { name: '正在分析模型' });
  const after = document.querySelector('.guided-preview')!.getBoundingClientRect();
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  expect(screen.getAllByRole('button', { name: '取消處理' })).toHaveLength(1);
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  for (const [width, height] of [[1280, 720], [1440, 900]]) {
    await page.viewport(width, height);
    expect(screen.getByRole('button', { name: '取消處理' }).getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(height);
    const heading = document.querySelector('.guided-heading')!.getBoundingClientRect();
    expect(document.querySelector('.guided-preview')!.getBoundingClientRect().top).toBeGreaterThanOrEqual(heading.bottom);
    expect(document.querySelector('.guided-settings')!.getBoundingClientRect().top).toBeGreaterThanOrEqual(heading.bottom);
    await page.screenshot({ path: `../../.superpowers/guided-processing-${width}-${height}.png` });
  }
  fireEvent.click(screen.getByRole('button', { name: '取消處理' }));
  await screen.findByRole('button', { name: '開始製作' });
  expect(cancel).toHaveBeenCalled();
});

it('keeps guided actions outside scrolling settings with material first and advanced fit collapsed', async () => {
  await page.viewport(1280, 720);
  render(<App services={{ convert: () => new Promise(() => {}), package: () => new Promise(() => {}), cancel: vi.fn(), present: async () => workbenchResult.preview }} oneClickProjectRepository={{ load: async () => undefined, save: vi.fn(), delete: vi.fn() }} />);
  fireEvent.change(await screen.findByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'guided.stl')] } });
  const action = await screen.findByRole('button', { name: '開始製作' });
  const settings = document.querySelector<HTMLElement>('.guided-settings');
  const footer = document.querySelector<HTMLElement>('.guided-action-bar');
  expect(settings).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(settings!.contains(action)).toBe(false);
  expect(footer!.contains(action)).toBe(true);
  const material = screen.getByLabelText('選擇製作材料');
  const engraving = screen.getByLabelText('名稱／學號');
  expect(material.compareDocumentPosition(engraving) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const details = screen.getByText(/進階配合設定/).closest('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(details.querySelector('summary')).toHaveTextContent('0.00 mm');
  for (const [width, height] of [[1280, 720], [1440, 900]]) {
    await page.viewport(width, height);
    settings!.scrollTop = settings!.scrollHeight;
    expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    expect(action.getBoundingClientRect().top).toBeGreaterThanOrEqual(settings!.getBoundingClientRect().bottom);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(height);
  }
  await page.viewport(390, 844);
  await userEvent.click(details.querySelector('summary')!);
  await userEvent.tab();
  const fit = screen.getByLabelText('三爪配合微調');
  expect(fit).toHaveFocus();
  expect(fit.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer!.getBoundingClientRect().top);
  expect(fit.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '../../.superpowers/guided-mobile-focus.png' });
});

it('keeps engraving and restored-project settings below the heading and reachable in short viewports', async () => {
  let saved: StoredOneClickProjectV3 | undefined;
  const repository = { load: async () => saved, save: async (value: StoredOneClickProjectV3) => { saved = value; }, delete: vi.fn() };
  const downloads = Object.fromEntries(['zip', 'svg', 'dxf', 'previewPdf', 'explodedPdf', 'launcherCoupon'].map(key => [key, { href: 'blob:' + key, fileName: key }])) as OutlineDownloads;
  const services: OneClickConverterServices = { convert: async () => workbenchResult, package: async () => downloads, cancel: vi.fn(),
    present: async () => workbenchResult.preview,
    createTimeline: (clock) => ({ advance: (stage, preview) => clock.onStage(stage, preview), finish: async () => {}, cancel: vi.fn() }),
  };
  for (const restored of [false, true]) {
    if (restored && saved) saved = { ...saved, launcherExteriorExpansion: { ...saved.launcherExteriorExpansion, offsetMm: 2.35 } };
    await page.viewport(1280, 720);
    const view = render(<App services={services} oneClickProjectRepository={repository} />);
    fireEvent.change(await screen.findByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'sample1 (2).stl')] } });
    const action = await screen.findByRole('button', { name: restored ? '下一步：開始製作' : '開始製作' });
    await screen.findByLabelText('名稱／學號');
    for (const [width, height] of [[1280, 720], [1440, 825], [1440, 900]]) {
      await page.viewport(width, height);
      const heading = document.querySelector('.material-heading')!;
      const controls = document.querySelector<HTMLElement>('.material-controls')!;
      controls.scrollTop = 0;
      await waitFor(() => {
        expect(controls.getBoundingClientRect().top).toBeGreaterThanOrEqual(heading.getBoundingClientRect().bottom);
        expect(screen.getByLabelText('名稱／學號').getBoundingClientRect().top).toBeGreaterThanOrEqual(heading.getBoundingClientRect().bottom);
        expect(controls.getBoundingClientRect().bottom).toBeLessThanOrEqual(document.querySelector('.material-card')!.getBoundingClientRect().bottom);
      });
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(height);
      const footer = document.querySelector<HTMLElement>('.guided-action-bar')!;
      for (const el of [action, footer.querySelector<HTMLElement>('.change-file-button')!]) {
        const bounds = el.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(footer.getBoundingClientRect().top);
        expect(bounds.bottom).toBeLessThanOrEqual(height);
        expect(controls.contains(el)).toBe(false);
      }
      controls.scrollTop = 0;
      await page.screenshot({ path: `../../.superpowers/material-layout-${restored ? 'restored' : 'new'}-${width}-${height}.png` });
    }
    await page.viewport(390, 844);
    await waitFor(() => expect(window.matchMedia('(max-width: 640px)').matches).toBe(true));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(screen.getByLabelText('名稱／學號').getBoundingClientRect().top).toBeGreaterThanOrEqual(document.querySelector('.material-heading')!.getBoundingClientRect().bottom);
    await page.screenshot({ path: `../../.superpowers/material-layout-${restored ? 'restored' : 'new'}-mobile.png` });
    if (!restored) {
      fireEvent.click(action);
      await screen.findByRole('heading', { name: '轉換完成' });
      await waitFor(() => expect(saved).toBeDefined());
    } else {
      await page.viewport(1280, 720);
      fireEvent.click(action);
      await screen.findByText('重新連結原模型');
      expect(screen.getByText('重新連結原模型')).toHaveClass('primary-button');
      const controls = document.querySelector<HTMLElement>('.material-controls')!;
      expect(controls.scrollTop).toBe(0);
      const relink = screen.getByText('重新連結原模型').getBoundingClientRect();
      expect(relink.top).toBeGreaterThanOrEqual(document.querySelector('.material-heading')!.getBoundingClientRect().bottom);
      expect(relink.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(document.querySelector('.guided-preview canvas')).not.toBeNull();
      expect(screen.getByRole('heading', { name: '需要你的操作' })).toBeVisible();
      expect(screen.getByRole('button', { name: '下一步：開始製作' })).toBeDisabled();
      expect(getComputedStyle(screen.getByRole('button', { name: '下一步：開始製作' })).cursor).toBe('not-allowed');
      expect(screen.getAllByRole('heading', { name: '需要你的操作' })).toHaveLength(1);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await page.screenshot({ path: '../../.superpowers/material-relink-required.png' });
      fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'sample1 (2).stl')] } });
      await waitFor(() => expect(screen.getByRole('button', { name: '下一步：開始製作' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: '下一步：開始製作' }));
      await screen.findByRole('heading', { name: '轉換完成' });
    }
    view.unmount();
  }
});

it('fits upload and material controls within a 1280 by 720 desktop viewport', async () => {
  await page.viewport(1280, 720);
  render(<App services={{ convert: () => new Promise(() => {}), package: () => new Promise(() => {}), cancel: vi.fn() }} oneClickProjectRepository={{ load: async () => undefined, save: vi.fn(), delete: vi.fn() }} />);
  await screen.findByLabelText('選擇 STL 模型');
  await waitFor(() => expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight));
  const stage = screen.getByTestId('apple-workbench').querySelector<HTMLElement>('.workbench-stage')!;
  const uploadCard = stage.querySelector<HTMLElement>('.upload-card')!;
  const uploadZone = uploadCard.querySelector<HTMLElement>('.upload-zone')!;
  const eyebrow = uploadCard.querySelector<HTMLElement>('.eyebrow')!;
  const heroHeading = uploadCard.querySelector<HTMLElement>('#converter-title')!;
  const heroDescription = uploadCard.querySelectorAll<HTMLElement>('.hero-copy > p')[1]!;
  const heroTitleLines = [...uploadCard.querySelectorAll<HTMLElement>('.hero-title-line')];
  expect(getComputedStyle(stage).paddingInlineStart).toBe('24px');
  expect(getComputedStyle(uploadCard).columnGap).toBe('40px');
  expect(getComputedStyle(uploadCard).paddingInlineStart).toBe('32px');
  expect(getComputedStyle(uploadZone).paddingInlineStart).toBe('32px');
  expect(heroHeading.getBoundingClientRect().top - eyebrow.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(18);
  expect(heroDescription.getBoundingClientRect().top - heroHeading.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(22);
  expect(heroTitleLines).toHaveLength(3);
  expect(heroTitleLines[0].getBoundingClientRect().bottom).toBeLessThanOrEqual(heroTitleLines[1].getBoundingClientRect().top);
  expect(heroTitleLines[1].getBoundingClientRect().bottom).toBeLessThanOrEqual(heroTitleLines[2].getBoundingClientRect().top);
  await page.screenshot({ path: '../../.superpowers/workbench-upload-1280.png' });

  await page.viewport(390, 844);
  await waitFor(() => expect(window.matchMedia('(max-width: 640px)').matches).toBe(true));
  expect(heroTitleLines.every((line) => getComputedStyle(line).display === 'inline')).toBe(true);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.screenshot({ path: '../../.superpowers/workbench-upload-390.png' });
  await page.viewport(1280, 720);

  fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [new File(['mesh'], 'test.stl')] } });
  await screen.findByRole('button', { name: '開始製作' });
  expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
  await page.screenshot({ path: '../../.superpowers/workbench-material-1280.png' });

  const relatedLinks = [
    screen.getByRole('link', { name: 'GitHub 專案介紹' }),
    screen.getByRole('link', { name: '延伸體驗：陀螺對戰模擬器' }),
  ];
  for (const link of relatedLinks) {
    const rect = link.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  }

  await page.viewport(390, 844);
  await waitFor(() => expect(window.matchMedia('(max-width: 640px)').matches).toBe(true));
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  for (const link of relatedLinks) {
    const rect = link.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  }
  await page.screenshot({ path: '../../.superpowers/workbench-related-links-390.png' });
  await page.viewport(1280, 720);
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
