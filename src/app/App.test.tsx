import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import type { OneClickConverterServices, OutlineDownloads } from './OneClickConverter';
import { OutlineArtifactError } from '../workers/geometry-api';
import { App, createDownloadUrls } from './App';
import { BLOCKED_TEST_MATERIAL, READY_TEST_MATERIAL } from '../test/ready-material';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import { manufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';

const services: OneClickConverterServices = {
  convert: vi.fn(() => new Promise<AutomaticOutlineResult>(() => undefined)),
  package: vi.fn(() => new Promise<OutlineDownloads>(() => undefined)),
  cancel: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe('App', () => {
  it('renders only the ShapeCut one-click experience', () => {
    render(<App services={services} />);
    expect(screen.getByRole('banner')).toHaveTextContent('ShapeCut');
    expect(screen.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
    expect(screen.queryByText('匯入與修復')).toBeNull();
    expect(screen.queryByText('材料設定')).toBeNull();
  });

  it('keeps local processing visible in floating chrome', () => {
    render(<App services={services} />);

    const chrome = screen.getByRole('banner');
    expect(within(chrome).getByText('私隱優先 · 本機處理')).toBeVisible();
    expect(within(chrome).getByRole('navigation', { name: '目前步驟' })).toHaveTextContent('上載 STL 模型');
    expect(screen.getAllByText('私隱優先 · 本機處理')).toHaveLength(1);
    expect(chrome).toHaveClass('floating-chrome');
  });

  it('loads only approved stored material profiles through the production App catalog path', async () => {
    const user = userEvent.setup();
    const repository = {
      list: vi.fn().mockResolvedValue([
        defaultPendingMaterialProfile('cardboard-2')!, BLOCKED_TEST_MATERIAL, READY_TEST_MATERIAL,
      ]),
      get: vi.fn(),
      importJson: vi.fn(),
    };
    render(<App services={services} materialRepository={repository} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'stored-ready.stl'));

    expect(await screen.findByRole('option', { name: /TEST ONLY ready birch plywood/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /pending/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /unknown composition/i })).toBeNull();
  });

  it('uses a ready same-ID replacement from the production App catalog path', async () => {
    const user = userEvent.setup();
    const replacement = {
      ...READY_TEST_MATERIAL,
      id: 'plywood-3',
      materialName: 'TEST ONLY App catalog calibrated plywood',
    };
    const activeServices: OneClickConverterServices = {
      convert: vi.fn(() => new Promise<AutomaticOutlineResult>(() => undefined)),
      package: vi.fn(() => new Promise<OutlineDownloads>(() => undefined)),
      cancel: vi.fn(),
    };
    const repository = {
      list: vi.fn().mockResolvedValue([
        replacement,
        { ...BLOCKED_TEST_MATERIAL, id: 'acrylic-3' },
        defaultPendingMaterialProfile('cardboard-2')!,
      ]),
      get: vi.fn(),
      importJson: vi.fn(),
    };
    render(<App services={activeServices} materialRepository={repository} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'catalog-replacement.stl'));
    const picker = await screen.findByLabelText('選擇製作材料');

    expect(await screen.findByRole('option', { name: /TEST ONLY App catalog calibrated plywood/ })).toBeVisible();
    expect(within(picker).getAllByRole('option', { name: /plywood|木夾板/i })).toHaveLength(2);
    expect(screen.queryByRole('option', { name: /unknown composition/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /pending/i })).toBeNull();

    await user.selectOptions(picker, replacement.id);
    expect(activeServices.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      manufacturingGeometryProfile(replacement),
      expect.any(Function),
    );
  });

  it('does not cancel an active conversion when the stored material catalog resolves', async () => {
    const user = userEvent.setup();
    const catalog = deferred<(typeof READY_TEST_MATERIAL)[]>();
    const conversion = deferred<AutomaticOutlineResult>();
    const activeServices: OneClickConverterServices = {
      convert: vi.fn(() => conversion.promise),
      package: vi.fn(() => new Promise<OutlineDownloads>(() => undefined)),
      cancel: vi.fn(),
      materialProfiles: [READY_TEST_MATERIAL],
    };
    const repository = {
      list: vi.fn(() => catalog.promise),
      get: vi.fn(),
      importJson: vi.fn(),
    };
    render(<App services={activeServices} materialRepository={repository} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'catalog-race.stl'));
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    expect(activeServices.convert).toHaveBeenCalledOnce();
    vi.mocked(activeServices.cancel).mockClear();

    await act(async () => {
      catalog.resolve([{
        ...READY_TEST_MATERIAL,
        id: 'late-catalog-ready',
        materialName: 'TEST ONLY late catalog ready',
      }]);
      await catalog.promise;
    });

    expect(activeServices.cancel).not.toHaveBeenCalled();
    expect(activeServices.convert).toHaveBeenCalledOnce();
  });

  it('fails safely with a sanitized message when the stored material catalog cannot load', async () => {
    const repository = {
      list: vi.fn().mockRejectedValue(new Error('/Users/private/materials.db operator@example.test')),
      get: vi.fn(),
      importJson: vi.fn(),
    };
    render(<App services={services} materialRepository={repository} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('已儲存的材料設定檔未能載入');
    expect(alert).not.toHaveTextContent('/Users/private');
    expect(alert).not.toHaveTextContent('operator@example.test');
  });

  it('ignores stale catalog completion after repository replacement and unmount', async () => {
    let resolveFirst!: (profiles: typeof READY_TEST_MATERIAL[]) => void;
    const first = new Promise<typeof READY_TEST_MATERIAL[]>((resolve) => { resolveFirst = resolve; });
    const stale = { ...READY_TEST_MATERIAL, id: 'stale-ready', materialName: 'TEST ONLY stale ready profile' };
    const firstRepository = { list: vi.fn(() => first), get: vi.fn(), importJson: vi.fn() };
    const secondRepository = { list: vi.fn().mockResolvedValue([READY_TEST_MATERIAL]), get: vi.fn(), importJson: vi.fn() };
    const view = render(<App services={services} materialRepository={firstRepository} />);

    view.rerender(<App services={services} materialRepository={secondRepository} />);
    await act(async () => { resolveFirst([stale]); await first; });
    await userEvent.setup().upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'latest.stl'));
    expect(await screen.findByRole('option', { name: /TEST ONLY ready birch plywood/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /stale ready profile/ })).toBeNull();

    view.unmount();
    expect(firstRepository.list).toHaveBeenCalledOnce();
    expect(secondRepository.list).toHaveBeenCalledOnce();
  });

  it('revokes partial download URLs when a later object URL cannot be created', () => {
    const create = vi.fn()
      .mockReturnValueOnce('blob:zip')
      .mockReturnValueOnce('blob:svg')
      .mockImplementationOnce(() => { throw new Error('URL quota'); });
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    let failure: unknown;
    try {
      createDownloadUrls({
        zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
        previewPdf: new Uint8Array([2]), explodedViewPdf: new Uint8Array([3]),
      }, 'spinner.stl');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OutlineArtifactError);
    expect(failure).toMatchObject({ artifact: 'cut-and-engrave.dxf' });
    expect(revoke).toHaveBeenNthCalledWith(1, 'blob:zip');
    expect(revoke).toHaveBeenNthCalledWith(2, 'blob:svg');
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('uses generic private download names rather than deriving them from the source file name', () => {
    const create = vi.fn()
      .mockReturnValueOnce('blob:zip').mockReturnValueOnce('blob:svg').mockReturnValueOnce('blob:dxf')
      .mockReturnValueOnce('blob:preview').mockReturnValueOnce('blob:exploded');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    const generated = createDownloadUrls({
      zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
      previewPdf: new Uint8Array([2]), explodedViewPdf: new Uint8Array([3]),
    }, '/Users/person/private-model.stl');

    expect(Object.values(generated).map(({ fileName }) => fileName)).toEqual([
      'shapecut-files.zip', 'cut-and-engrave.svg', 'cut-and-engrave.dxf',
      'preview.pdf', 'exploded-view.pdf',
    ]);
  });

  it('attempts to revoke every partial URL even when one revoke fails', () => {
    const create = vi.fn()
      .mockReturnValueOnce('blob:zip')
      .mockReturnValueOnce('blob:svg')
      .mockImplementationOnce(() => { throw new Error('URL quota'); });
    const revoke = vi.fn((href: string) => {
      if (href === 'blob:zip') throw new Error('revocation failed');
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    expect(() => createDownloadUrls({
      zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
      previewPdf: new Uint8Array([2]), explodedViewPdf: new Uint8Array([3]),
    })).toThrow(OutlineArtifactError);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenNthCalledWith(2, 'blob:svg');
  });
});
