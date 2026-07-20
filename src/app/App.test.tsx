import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import type { OneClickConverterServices, OutlineDownloads } from './OneClickConverter';
import { App } from './App';

const services: OneClickConverterServices = {
  convert: vi.fn(() => new Promise<AutomaticOutlineResult>(() => undefined)),
  package: vi.fn(() => new Promise<OutlineDownloads>(() => undefined)),
  cancel: vi.fn(),
};

describe('App', () => {
  it('renders only the ShapeCut one-click experience', () => {
    render(<App services={services} />);
    expect(screen.getByRole('banner')).toHaveTextContent('ShapeCut');
    expect(screen.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
    expect(screen.queryByText('匯入與修復')).toBeNull();
    expect(screen.queryByText('材料設定')).toBeNull();
  });
});
