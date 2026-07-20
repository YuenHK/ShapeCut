import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AutomaticOutlineError, type AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { SupersededError } from '../workers/geometry-client';
import {
  OneClickConverter,
  type OneClickConverterServices,
  type OutlineDownloads,
} from './OneClickConverter';

const result: AutomaticOutlineResult = {
  sourceHash: 'a'.repeat(32),
  mode: 'exact',
  status: 'success',
  axis: { source: 'candidate', axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: true } },
  layers: [{
    id: 'layer-0', index: 0, zStart: 0, zEnd: 1,
    contour: { outer: [[0, 0], [10, 0], [10, 5], [0, 5]], holes: [] },
    sourceAreaMm2: 50, simplifiedAreaMm2: 50,
    sourceBoundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
  }],
  warnings: [],
  originalReport: {} as AutomaticOutlineResult['originalReport'],
  repairAccepted: true,
};

const downloads: OutlineDownloads = {
  zip: { href: 'blob:zip', fileName: 'model-shapecut.zip' },
  svg: { href: 'blob:svg', fileName: 'model-cut.svg' },
  dxf: { href: 'blob:dxf', fileName: 'model-cut.dxf' },
  pdf: { href: 'blob:pdf', fileName: 'model-preview.pdf' },
  json: { href: 'blob:json', fileName: 'model-manifest.json' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function services(overrides: Partial<OneClickConverterServices> = {}): OneClickConverterServices {
  return {
    convert: vi.fn().mockResolvedValue(result),
    package: vi.fn().mockResolvedValue(downloads),
    cancel: vi.fn(),
    ...overrides,
  };
}

describe('OneClickConverter', () => {
  it('starts the whole workflow immediately after one file selection and exposes no wizard controls', async () => {
    const user = userEvent.setup();
    const api = services();
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['solid model'], 'spinner.stl', { type: 'model/stl' }));

    expect(api.cancel).toHaveBeenCalledOnce();
    expect(api.convert).toHaveBeenCalledOnce();
    await screen.findByRole('heading', { name: '轉換完成' });
    expect(screen.getByRole('status')).toHaveTextContent('轉換完成');
    expect(screen.queryByRole('button', { name: /修復|軸心|下一步|材料|分件|確認輸出/ })).toBeNull();
  });

  it('announces monotonic processing stages through an accessible status', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((stage: 'reading' | 'analyzing' | 'simplifying' | 'slicing' | 'packaging') => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, onProgress) => { report = onProgress; return conversion.promise; }) });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'busy.stl'));
    expect(screen.getByRole('status')).toHaveTextContent('模型已讀取');
    report?.('simplifying');
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在簡化'));
    report?.('reading');
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在簡化'));
    report?.('slicing');
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在產生切片'));
    report?.('packaging');
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在準備下載'));
  });

  it('cancels an old selection and never publishes its late result', async () => {
    const user = userEvent.setup();
    const first = deferred<AutomaticOutlineResult>();
    const second = deferred<AutomaticOutlineResult>();
    const convert = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = services({ convert });
    render(<OneClickConverter services={api} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['one'], 'old.stl'));
    await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce());
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['two'], 'new.stl'));
    second.resolve({ ...result, sourceHash: 'b'.repeat(32) });
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('new.stl'));
    first.resolve(result);
    await Promise.resolve();

    expect(api.cancel).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('old.stl')).toBeNull();
    expect(api.package).toHaveBeenCalledOnce();
  });

  it('silently ignores SupersededError from an obsolete request', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services({ convert: vi.fn().mockRejectedValue(new SupersededError(1)) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'old.stl'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the simplified warning and all five download formats', async () => {
    const user = userEvent.setup();
    const warning = { ...result, mode: 'outline-2.5d' as const, status: 'warning' as const, warnings: ['已簡化模型'] };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(warning) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'broken.stl'));

    expect(await screen.findByRole('status')).toHaveTextContent('需注意');
    expect(screen.getByText('已簡化模型')).toBeVisible();
    expect(screen.getByRole('link', { name: '下載 ZIP 製作套件' })).toHaveAttribute('href', 'blob:zip');
    for (const name of ['SVG', 'DXF', 'PDF', 'JSON']) expect(screen.getByRole('link', { name: `下載 ${name}` })).toBeVisible();
  });

  it('maps typed failures to plain Traditional Chinese and retry returns to upload', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services({
      convert: vi.fn().mockRejectedValue(new AutomaticOutlineError('RESOURCE_LIMIT', 'internal budget details')),
    })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'huge.stl'));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型太複雜，超出這次可處理的上限');
    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    expect(screen.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
  });

  it('revokes every object URL on replacement and unmount', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const { unmount } = render(<OneClickConverter services={services()} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['one'], 'one.stl'));
    await screen.findByText('one.stl');
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['two'], 'two.stl'));
    await screen.findByText('two.stl');
    expect(revoke).toHaveBeenCalledTimes(5);
    unmount();
    expect(revoke).toHaveBeenCalledTimes(10);
  });
});
