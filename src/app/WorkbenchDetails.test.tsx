import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it } from 'vitest';
import { WorkbenchDetails, DetailPages } from './WorkbenchDetails';

it('keeps every detail accessible through bounded pages and keyboard tabs', () => {
  render(<WorkbenchDetails settings={<DetailPages label="製作設定"><dl>{Array.from({ length: 9 }, (_, i) => <div key={i}><dt>項目 {i}</dt><dd>{i}</dd></div>)}</dl></DetailPages>} warnings={<p>完整提示</p>} technical={<p>完整技術資料</p>} />);
  expect(screen.getByRole('tab', { name: '製作設定' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('項目 0')).toBeVisible();
  expect(screen.queryByText('項目 4')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '製作設定下一頁' }));
  expect(screen.getByText('項目 4')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '製作設定下一頁' }));
  expect(screen.getByText('項目 8')).toBeVisible();
  const tab = screen.getByRole('tab', { name: '製作設定' });
  tab.focus();
  fireEvent.keyDown(tab, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '處理提示' })).toHaveFocus();
  expect(screen.getByText('完整提示')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('tab', { name: '處理提示' }), { key: 'End' });
  expect(screen.getByText('完整技術資料')).toBeVisible();
});
