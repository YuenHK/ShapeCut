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
    removedComponentCount: 0,
  }],
  warnings: [],
  originalReport: {} as AutomaticOutlineResult['originalReport'],
  repairAccepted: true,
  removedComponentCount: 0,
  removalEvidenceFingerprint: '0'.repeat(32),
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
    const { container } = render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'busy.stl'));
    expect(container.querySelector('.progress-status > strong')).toHaveTextContent('模型已讀取');
    report?.('simplifying');
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在簡化'));
    report?.('reading');
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在簡化'));
    report?.('slicing');
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在產生切片'));
    report?.('packaging');
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在準備下載'));
    const checklist = container.querySelectorAll('.stage-list li');
    expect(checklist).toHaveLength(5);
    expect(checklist.item(4)).toHaveTextContent('正在準備下載');
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

    await screen.findByRole('heading', { name: '轉換完成' });
    expect(screen.getByRole('status')).toHaveTextContent('需注意');
    expect(screen.getAllByText('已簡化模型')[0]).toBeVisible();
    expect(screen.getByText(/不同材料厚度會改變堆疊後高度/)).toBeVisible();
    expect(screen.getByRole('link', { name: '下載 ZIP 製作套件' })).toHaveAttribute('href', 'blob:zip');
    for (const name of ['SVG', 'DXF', 'PDF', 'JSON']) expect(screen.getByRole('link', { name: `下載 ${name}` })).toBeVisible();
    expect(screen.getByText('10 × 5 mm')).toBeVisible();
    expect(screen.getByText('總高度 1 mm')).toBeVisible();
    expect(screen.getByRole('img', { name: '實際外形切片預覽' })).toHaveAttribute('viewBox', '0 0 10 5');
  });

  it('reports an exact-mode warning without falsely claiming that the model was simplified', async () => {
    const user = userEvent.setup();
    const axisWarning = '未找到可信旋轉軸，已使用模型最短包圍盒軸';
    const exactWarning = { ...result, status: 'warning' as const, warnings: [axisWarning] };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(exactWarning) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'exact-warning.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.queryByText('已簡化模型')).toBeNull();
    expect(screen.queryByText(/內部細節、孔洞/)).toBeNull();
    expect(screen.getAllByText(axisWarning)[0]).toBeVisible();
  });

  it('provides keyboard-accessible technical data from the actual result and points to JSON diagnostics', async () => {
    const user = userEvent.setup();
    const warning = { ...result, mode: 'outline-2.5d' as const, status: 'warning' as const, warnings: ['已簡化模型', '正式製作前應先試切少量零件'] };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(warning) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'private-name.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    const summary = screen.getByText('技術資料');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    summary.focus();
    expect(summary).toHaveFocus();
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    expect(details).toHaveTextContent('outline-2.5d');
    expect(details).toHaveTextContent('warning');
    expect(details).toHaveTextContent('a'.repeat(32));
    expect(details).toHaveTextContent('正式製作前應先試切少量零件');
    expect(details).toHaveTextContent('JSON manifest');
    expect(details).not.toHaveTextContent('private-name.stl');
  });

  it('renders an SVG path from the actual contour instead of a fixed decorative shape', async () => {
    const user = userEvent.setup();
    const firstServices = services();
    const firstRender = render(<OneClickConverter services={firstServices} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'wide.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    const firstPath = firstRender.container.querySelector('svg path')?.getAttribute('d');
    firstRender.unmount();

    const changed = {
      ...result,
      layers: [{
        ...result.layers[0],
        contour: { outer: [[0, 0], [4, 0], [2, 8]], holes: [] as const },
        sourceAreaMm2: 16,
        simplifiedAreaMm2: 16,
        sourceBoundsMm: { minX: 0, minY: 0, maxX: 4, maxY: 8 },
      }],
    };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(changed) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'tall.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    const secondPath = document.querySelector('svg path')?.getAttribute('d');

    expect(firstPath).toBe('M 0 5 L 10 5 L 10 0 L 0 0 Z');
    expect(secondPath).toBe('M 0 8 L 4 8 L 2 0 Z');
    expect(secondPath).not.toBe(firstPath);
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
