import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import type { OneClickConverterServices, OutlineDownloads } from './OneClickConverter';
import { OutlineArtifactError } from '../workers/geometry-api';
import { App, createDownloadUrls } from './App';
import { BLOCKED_TEST_MATERIAL, READY_TEST_MATERIAL as SOURCE_READY_TEST_MATERIAL } from '../test/ready-material';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import { manufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import type { StoredOneClickProjectV3 } from '../persistence/one-click-project-repository';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import { sha256Hex } from '../persistence/project-repository';
import { coloredResult } from '../export/colored-outline-test-fixture';

const READY_TEST_MATERIAL = { ...SOURCE_READY_TEST_MATERIAL, id: 'plywood-3' };

const services: OneClickConverterServices = {
  convert: vi.fn(() => new Promise<AutomaticOutlineResult>(() => undefined)),
  package: vi.fn(() => new Promise<OutlineDownloads>(() => undefined)),
  cancel: vi.fn(),
};
const emptyProjectRepository = {
  load: vi.fn().mockResolvedValue(undefined),
  save: vi.fn(),
  delete: vi.fn(),
};
const emptyMaterialRepository = {
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn(),
  importJson: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe('App', () => {
  const savedProject: StoredOneClickProjectV3 = {
    schemaVersion: 3,
    id: 'one-click-current',
    updatedAt: '2026-07-28T00:00:00.000Z',
    sourceSha256: 'a'.repeat(64),
    material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
    launcherFitOffsetMm: 0,
    launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
    launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
    launcherExteriorExpansion: {
      mode: 'shared-uniform',
      offsetMm: 2.35,
      maxOffsetMm: 6,
      affectedLayerIds: ['layer-5', 'layer-6'],
    },
    decorationOmissions: [],
    canonicalSourceHash: 'b'.repeat(32),
    status: 'ready',
  };

  it('links to project information and the related Beyblade simulator safely', async () => {
    render(
      <App
        services={services}
        materialRepository={emptyMaterialRepository}
        oneClickProjectRepository={emptyProjectRepository}
      />,
    );

    const github = await screen.findByRole('link', { name: 'GitHub 專案介紹' });
    const simulator = screen.getByRole('link', { name: '延伸體驗：陀螺對戰模擬器' });
    expect(github).toHaveAttribute('href', 'https://github.com/YuenHK/ShapeCut');
    expect(simulator).toHaveAttribute('href', 'https://yuenhk.github.io/Bayblad-Simulator/');
    for (const link of [github, simulator]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }
  });

  it('does not expose conversion while saved-project loading is unsettled', async () => {
    const pending = deferred<StoredOneClickProjectV3 | undefined>();
    render(<App services={services} materialRepository={emptyMaterialRepository} oneClickProjectRepository={{
      load: vi.fn(() => pending.promise),
      save: vi.fn(),
      delete: vi.fn(),
    }} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在載入已儲存專案');
    expect(screen.queryByLabelText('選擇 STL 模型')).toBeNull();

    await act(async () => { pending.resolve(savedProject); await pending.promise; });
    expect(await screen.findByText(/需要重新連結原本 STL/)).toBeVisible();
  });

  it('propagates a replacement omission decision and keeps regeneration blocked through the App adapter', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const baseResult = coloredResult();
    const result: AutomaticOutlineResult = {
      ...baseResult,
      status: 'warning',
      assembly: {
        ...baseResult.assembly,
        decorationOmissions: [{
          layerId: baseResult.coloredLayers[1].id,
          reason: 'protected-cut-work-budget',
          roles: ['DEEP_RED', 'LIGHT_BLUE'],
        }],
      },
    };
    const initialProject: StoredOneClickProjectV3 = {
      ...savedProject,
      sourceSha256: await sha256Hex(bytes),
      canonicalSourceHash: result.sourceHash,
      status: 'regeneration-required',
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: [],
    };
    const save = vi.fn().mockResolvedValue(undefined);
    const activeServices: OneClickConverterServices = {
      convert: vi.fn().mockResolvedValue(result),
      package: vi.fn().mockResolvedValue({
        zip: { href: 'blob:zip', fileName: 'shapecut-files.zip' },
        svg: { href: 'blob:svg', fileName: 'cut-and-engrave.svg' },
        dxf: { href: 'blob:dxf', fileName: 'cut-and-engrave.dxf' },
        previewPdf: { href: 'blob:preview', fileName: 'preview.pdf' },
        explodedPdf: { href: 'blob:exploded', fileName: 'exploded-view.pdf' },
        launcherCoupon: { href: 'blob:coupon', fileName: 'launcher-fit-coupon.svg' },
      }),
      cancel: vi.fn(),
      createTimeline: () => ({
        advance: vi.fn(),
        finish: () => Promise.resolve(),
        cancel: vi.fn(),
      }),
    };
    render(<App
      services={activeServices}
      materialRepository={emptyMaterialRepository}
      oneClickProjectRepository={{
        load: vi.fn().mockResolvedValue(initialProject),
        save,
        delete: vi.fn(),
      }}
    />);
    const file = new File([bytes], 'reattached.stl');

    await user.upload(await screen.findByLabelText('選擇 STL 模型'), file);
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));

    expect(activeServices.package).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'regeneration-required',
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
    }));
    expect(screen.getByRole('button', { name: '重新產生正式輸出' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();

    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
    expect(screen.getByRole('button', { name: '重新產生正式輸出' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '重新產生正式輸出' }));

    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();
    expect(activeServices.package).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready',
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
    }));
  });

  it('fails closed on saved-project load failure and only offers sanitized retry', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('/Users/private/project.db owner@example.test'))
      .mockResolvedValueOnce(undefined);
    render(<App services={services} materialRepository={emptyMaterialRepository} oneClickProjectRepository={{
      load,
      save: vi.fn(),
      delete: vi.fn(),
    }} />);

    const alert = await screen.findByText(/已儲存專案未能載入/);
    expect(alert).toHaveTextContent('已儲存專案未能載入');
    expect(alert).not.toHaveTextContent('/Users/private');
    expect(alert).not.toHaveTextContent('owner@example.test');
    expect(screen.queryByLabelText('選擇 STL 模型')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: '重試載入已儲存專案' }));
    expect(await screen.findByLabelText('選擇 STL 模型')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('can explicitly discard one unreadable saved record before unlocking conversion', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    render(<App services={services} materialRepository={emptyMaterialRepository} oneClickProjectRepository={{
      load: vi.fn().mockRejectedValue(new Error('unreadable')),
      save: vi.fn(),
      delete: remove,
    }} />);
    const user = userEvent.setup();
    expect(await screen.findByText(/已儲存專案未能載入/)).toBeVisible();
    expect(screen.queryByLabelText('選擇 STL 模型')).toBeNull();

    await user.click(screen.getByRole('button', { name: '刪除無法讀取的已儲存專案' }));

    expect(remove).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText('選擇 STL 模型')).toBeVisible();
  });

  it('remains fail closed with a sanitized retry when unreadable-record deletion fails', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('/Users/private/delete owner@example.test'));
    render(<App services={services} materialRepository={emptyMaterialRepository} oneClickProjectRepository={{
      load: vi.fn().mockRejectedValue(new Error('unreadable')),
      save: vi.fn(),
      delete: remove,
    }} />);
    const user = userEvent.setup();
    await screen.findByText(/已儲存專案未能載入/);

    await user.click(screen.getByRole('button', { name: '刪除無法讀取的已儲存專案' }));

    const alert = await screen.findByText(/未能安全刪除/);
    expect(alert).not.toHaveTextContent('/Users/private');
    expect(alert).not.toHaveTextContent('owner@example.test');
    expect(screen.queryByLabelText('選擇 STL 模型')).toBeNull();
    expect(screen.getByRole('button', { name: '重試刪除無法讀取的已儲存專案' })).toBeEnabled();
  });

  it('renders only the ShapeCut one-click experience', async () => {
    render(<App services={services} oneClickProjectRepository={emptyProjectRepository} />);
    expect(screen.getByRole('banner')).toHaveTextContent('ShapeCut');
    expect(await screen.findByRole('heading', { name: '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片' })).toBeVisible();
    expect(screen.queryByText('匯入與修復')).toBeNull();
    expect(screen.queryByText('材料設定')).toBeNull();
  });

  it('keeps local processing visible in floating chrome', async () => {
    render(<App services={services} oneClickProjectRepository={emptyProjectRepository} />);

    const chrome = screen.getByRole('banner');
    expect(within(chrome).getByText('私隱優先 · 本機處理')).toBeVisible();
    expect(await within(chrome).findByRole('navigation', { name: '目前步驟' })).toHaveTextContent('上載 STL 模型');
    expect(screen.getAllByText('私隱優先 · 本機處理')).toHaveLength(1);
    expect(chrome).toHaveClass('floating-chrome');
  });

  it('keeps ready custom profiles stored but hides them from new model choices', async () => {
    const user = userEvent.setup();
    const repository = {
      list: vi.fn().mockResolvedValue([
        defaultPendingMaterialProfile('cardboard-2')!, BLOCKED_TEST_MATERIAL, SOURCE_READY_TEST_MATERIAL,
      ]),
      get: vi.fn(),
      importJson: vi.fn(),
    };
    render(<App services={services} materialRepository={repository} oneClickProjectRepository={emptyProjectRepository} />);

    await user.upload(await screen.findByLabelText('選擇 STL 模型'), new File(['mesh'], 'stored-ready.stl'));

    expect(await screen.findByLabelText('選擇製作材料')).toHaveValue('acrylic-6');
    expect(screen.queryByRole('option', { name: /TEST ONLY ready birch plywood/ })).toBeNull();
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
    render(<App services={activeServices} materialRepository={repository} oneClickProjectRepository={emptyProjectRepository} />);

    await user.upload(await screen.findByLabelText('選擇 STL 模型'), new File(['mesh'], 'catalog-replacement.stl'));
    const picker = await screen.findByLabelText('選擇製作材料');

    expect(await screen.findByRole('option', { name: /TEST ONLY App catalog calibrated plywood/ })).toBeVisible();
    expect(within(picker).getAllByRole('option', { name: /plywood|木（/i })).toHaveLength(2);
    expect(screen.queryByRole('option', { name: /unknown composition/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /pending/i })).toBeNull();

    await user.selectOptions(picker, replacement.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(activeServices.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      manufacturingGeometryProfile(replacement),
      0,
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
    render(<App services={activeServices} materialRepository={repository} oneClickProjectRepository={emptyProjectRepository} />);

    await user.upload(await screen.findByLabelText('選擇 STL 模型'), new File(['mesh'], 'catalog-race.stl'));
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
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
    render(<App services={services} materialRepository={repository} oneClickProjectRepository={emptyProjectRepository} />);

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
    const view = render(<App services={services} materialRepository={firstRepository} oneClickProjectRepository={emptyProjectRepository} />);

    view.rerender(<App services={services} materialRepository={secondRepository} oneClickProjectRepository={emptyProjectRepository} />);
    await act(async () => { resolveFirst([stale]); await first; });
    await userEvent.setup().upload(await screen.findByLabelText('選擇 STL 模型'), new File(['mesh'], 'latest.stl'));
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
        launcherCouponSvg: '<svg/>',
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
      .mockReturnValueOnce('blob:preview').mockReturnValueOnce('blob:exploded')
      .mockReturnValueOnce('blob:launcher-coupon');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    const generated = createDownloadUrls({
      zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
      previewPdf: new Uint8Array([2]), explodedViewPdf: new Uint8Array([3]),
      launcherCouponSvg: '<svg id="launcher-coupon"/>',
    }, '/Users/person/private-model.stl');

    expect(Object.values(generated).map(({ fileName }) => fileName)).toEqual([
      'shapecut-files.zip', 'cut-and-engrave.svg', 'cut-and-engrave.dxf',
      'preview.pdf', 'exploded-view.pdf', 'launcher-fit-coupon.svg',
    ]);
    expect(generated.launcherCoupon).toEqual({
      href: 'blob:launcher-coupon',
      fileName: 'launcher-fit-coupon.svg',
    });
  });

  it('attributes coupon URL creation failure and revokes all earlier URLs', () => {
    const create = vi.fn()
      .mockReturnValueOnce('blob:zip')
      .mockReturnValueOnce('blob:svg')
      .mockReturnValueOnce('blob:dxf')
      .mockReturnValueOnce('blob:preview')
      .mockReturnValueOnce('blob:exploded')
      .mockImplementationOnce(() => { throw new Error('URL quota'); });
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    expect(() => createDownloadUrls({
      zip: new Uint8Array([1]), cutSvg: '<svg/>', cutDxf: 'DXF',
      previewPdf: new Uint8Array([2]), explodedViewPdf: new Uint8Array([3]),
      launcherCouponSvg: '<svg id="launcher-coupon"/>',
    })).toThrow(expect.objectContaining({
      name: 'OutlineArtifactError',
      artifact: 'launcher-fit-coupon.svg',
    }));
    expect(revoke.mock.calls.map(([href]) => href)).toEqual([
      'blob:zip', 'blob:svg', 'blob:dxf', 'blob:preview', 'blob:exploded',
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
      launcherCouponSvg: '<svg/>',
    })).toThrow(OutlineArtifactError);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenNthCalledWith(2, 'blob:svg');
  });
});
