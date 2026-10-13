import { render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { expect, it, vi } from 'vitest';
import { App } from './App';
import '../styles.css';

it('centers the transfer notice above the workbench on desktop and mobile', async () => {
  const previousUrl = location.href;
  window.history.replaceState(null, '', '#bayblad-transfer=invalid');
  const view = render(<App services={{ convert: vi.fn(), package: vi.fn(), cancel: vi.fn() }}
    materialRepository={{ list: vi.fn().mockResolvedValue([]), get: vi.fn(), importJson: vi.fn() }}
    oneClickProjectRepository={{ load: vi.fn().mockResolvedValue(undefined), save: vi.fn(), delete: vi.fn() }} />);
  try {
    const notice = await screen.findByText('本次傳送不會覆寫已儲存專案；轉換結果請直接下載。');
    for (const [width, height] of [[1280, 720], [390, 844]]) {
      await page.viewport(width, height);
      expect(getComputedStyle(notice).textAlign).toBe('center');
      const bounds = notice.getBoundingClientRect();
      const main = view.container.querySelector('main')!.getBoundingClientRect();
      expect(Math.abs((bounds.left + bounds.right - main.left - main.right) / 2)).toBeLessThan(1);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(bounds.bottom).toBeLessThanOrEqual(view.container.querySelector('.apple-workbench')!.getBoundingClientRect().top);
      await page.screenshot({ path: `../../.superpowers/transfer-notice-${width}.png` });
    }
  } finally {
    view.unmount();
    window.history.replaceState(null, '', previousUrl);
  }
});
