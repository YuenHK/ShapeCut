import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import type { OneClickConverterServices, OutlineDownloads } from './OneClickConverter';
import { App, createDownloadUrls } from './App';

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

  it('revokes partial download URLs when a later object URL cannot be created', () => {
    const create = vi.fn()
      .mockReturnValueOnce('blob:zip')
      .mockReturnValueOnce('blob:svg')
      .mockImplementationOnce(() => { throw new Error('URL quota'); });
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    expect(() => createDownloadUrls({
      zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
      previewPdf: new Uint8Array([2]), manifestJson: '{}',
    }, 'spinner.stl')).toThrow('URL quota');
    expect(revoke).toHaveBeenNthCalledWith(1, 'blob:zip');
    expect(revoke).toHaveBeenNthCalledWith(2, 'blob:svg');
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('uses generic private download names rather than deriving them from the source file name', () => {
    const create = vi.fn()
      .mockReturnValueOnce('blob:zip').mockReturnValueOnce('blob:svg').mockReturnValueOnce('blob:dxf')
      .mockReturnValueOnce('blob:pdf').mockReturnValueOnce('blob:json');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    const generated = createDownloadUrls({
      zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
      previewPdf: new Uint8Array([2]), manifestJson: '{}',
    }, '/Users/person/private-model.stl');

    expect(Object.values(generated).map(({ fileName }) => fileName)).toEqual([
      'shapecut-outline.zip', 'shapecut-cut.svg', 'shapecut-cut.dxf',
      'shapecut-preview.pdf', 'shapecut-manifest.json',
    ]);
  });
});
