import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomaticOutlineError,
  type AutomaticOutlineProgressEvent,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, type ColoredOutlineLayer } from '../domain/outline-features/types';
import { MAX_STL_BYTES } from '../domain/mesh/parse-stl';
import { SupersededError } from '../workers/geometry-client';
import * as outlineProcessScene from '../preview/outline-process-scene';
import {
  OneClickConverter,
  type OneClickConverterServices,
  type OutlineDownloads,
} from './OneClickConverter';

const coloredLayer: ColoredOutlineLayer = {
  id: 'layer-0', index: 0, zStart: 0, zEnd: 1,
  exterior: {
    id: 'layer-0-exterior', role: 'CUT_BLACK',
    outer: [[0, 0], [10, 0], [10, 5], [0, 5]],
    boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 5 }, areaMm2: 50,
  },
  removedComponentCount: 0,
  diagnostics: {
    hole: { status: 'omitted' },
    depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
  },
};

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
    simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0,
    removedComponentCount: 0,
  }],
  coloredLayers: [coloredLayer],
  featureWarnings: [],
  featureEvidenceFingerprint: featureEvidenceFingerprint({
    sourceHash: 'a'.repeat(32), mode: 'exact', coloredLayers: [coloredLayer],
    preview: { axis: {
      origin: [0, 0, 0], direction: [0, 0, 1], planeX: [0, 1, 0], planeY: [-1, 0, 0],
    } },
  }),
  preview: {
    mesh: {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 5, 0]),
      indices: new Uint32Array([0, 1, 2]),
    },
    axis: {
      origin: [0, 0, 0], direction: [0, 0, 1],
      planeX: [0, 1, 0], planeY: [-1, 0, 0],
    },
    layers: [coloredLayer],
  },
  warnings: [],
  originalReport: {} as AutomaticOutlineResult['originalReport'],
  repairAccepted: true,
  removedComponentCount: 0,
  removalEvidenceFingerprint: '0'.repeat(32),
  diagnostics: { topology: { triangleCount: 0, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true }, repairDecision: 'accepted', rasterCellSizeMm: null, layers: [{ id: 'layer-0', simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0, areaEvidenceBasis: 'exact-slice-pre-simplification' }] },
};

const downloads: OutlineDownloads = {
  zip: { href: 'blob:zip', fileName: 'shapecut-files.zip' },
  svg: { href: 'blob:svg', fileName: 'cut-and-engrave.svg' },
  dxf: { href: 'blob:dxf', fileName: 'cut-and-engrave.dxf' },
  previewPdf: { href: 'blob:preview', fileName: 'preview.pdf' },
  explodedPdf: { href: 'blob:exploded', fileName: 'exploded-view.pdf' },
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
  it('drains the idle renderer pool when the application workflow unmounts', () => {
    const shutdown = vi.spyOn(outlineProcessScene, 'shutdownOutlineProcessRendererPool');
    const view = render(<OneClickConverter services={services()} />);

    view.unmount();

    expect(shutdown).toHaveBeenCalled();
  });

  it('rejects an oversized file before reading bytes and permits a retry', async () => {
    const user = userEvent.setup();
    const api = services();
    const oversized = new File(['x'], 'oversized.stl');
    const arrayBuffer = vi.fn();
    Object.defineProperties(oversized, { size: { value: MAX_STL_BYTES + 1 }, arrayBuffer: { value: arrayBuffer } });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), oversized);
    expect(await screen.findByRole('alert')).toHaveTextContent('模型太複雜');
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(api.convert).not.toHaveBeenCalled();
    expect(api.package).not.toHaveBeenCalled();
    expect(api.cancel).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['solid model'], 'retry.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    expect(api.convert).toHaveBeenCalledOnce();
  });
  it('starts the whole workflow immediately after one file selection and exposes no wizard controls', async () => {
    const user = userEvent.setup();
    const api = services();
    const { container } = render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['solid model'], 'spinner.stl', { type: 'model/stl' }));

    expect(api.cancel).toHaveBeenCalledOnce();
    expect(api.convert).toHaveBeenCalledOnce();
    await screen.findByRole('heading', { name: '轉換完成' });
    expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('轉換完成'))).toBe(true);
    expect(container.querySelector('.result-viewport .outline-process-viewport')).toHaveAttribute('data-stage', 'result');
    expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('正在準備輸出'))).toBe(false);
    expect(screen.queryByRole('button', { name: /修復|軸心|下一步|材料|分件|確認輸出/ })).toBeNull();
  });

  it('announces monotonic processing stages through an accessible status', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, onProgress) => { report = onProgress; return conversion.promise; }) });
    const { container } = render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'busy.stl'));
    expect(container.querySelector('.progress-status > strong')).toHaveTextContent('模型已讀取');
    report?.({ stage: 'simplifying' });
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在簡化'));
    report?.({ stage: 'reading' });
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在簡化'));
    report?.({ stage: 'slicing', preview: result.preview });
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在產生切片'));
    report?.({ stage: 'packaging' });
    await vi.waitFor(() => expect(container.querySelector('.progress-status > strong')).toHaveTextContent('正在準備下載'));
    const checklist = container.querySelectorAll('.stage-list li');
    expect(checklist).toHaveLength(5);
    expect(checklist.item(4)).toHaveTextContent('正在準備下載');
  });

  it('stays neutral until parsed preview data arrives, then uses the real viewport through packaging', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, onProgress) => { report = onProgress; return conversion.promise; }) });
    const { container } = render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'preview.stl'));
    expect(screen.queryByRole('img', { name: /模型分層預覽/ })).toBeNull();
    expect(container.querySelector('.spinner')).toBeNull();

    report?.({ stage: 'analyzing', preview: result.preview });
    const preview = await screen.findByRole('img', { name: /模型分層預覽/ });
    expect(preview.closest('.outline-process-viewport')).toHaveAttribute('data-stage', 'analyzing');

    report?.({ stage: 'slicing', preview: result.preview });
    report?.({ stage: 'packaging' });
    await vi.waitFor(() => expect(preview.closest('.outline-process-viewport')).toHaveAttribute('data-stage', 'packaging'));
  });

  it('ignores a stale preview frame after a second file hard-cancels the first job', async () => {
    const user = userEvent.setup();
    const conversions = [deferred<AutomaticOutlineResult>(), deferred<AutomaticOutlineResult>()];
    const reports: Array<((event: AutomaticOutlineProgressEvent) => void) | undefined> = [];
    const api = services({
      convert: vi.fn((_bytes, onProgress) => {
        reports.push(onProgress);
        return conversions[reports.length - 1].promise;
      }),
    });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['one'], 'old.stl'));
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['two'], 'new.stl'));
    reports[0]?.({ stage: 'slicing', preview: result.preview });
    await Promise.resolve();
    expect(screen.queryByRole('img', { name: /模型分層預覽/ })).toBeNull();
    expect(screen.getByText('new.stl')).toBeVisible();

    reports[1]?.({ stage: 'analyzing', preview: result.preview });
    expect(await screen.findByRole('img', { name: /模型分層預覽/ })).toBeVisible();
    expect(api.cancel).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(screen.getByText('new.stl')).toBeVisible());
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

  it('shows the simplified warning, primary real viewport, and exact five colored downloads', async () => {
    const user = userEvent.setup();
    const warning = { ...result, mode: 'outline-2.5d' as const, status: 'warning' as const, warnings: ['已簡化模型'] };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(warning) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'broken.stl'));

    await screen.findByRole('heading', { name: '轉換完成' });
    expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('需注意'))).toBe(true);
    expect(screen.getAllByText(/模型已使用 2.5D 外形簡化/)[0]).toBeVisible();
    expect(screen.getByRole('link', { name: '下載 ZIP 製作套件' })).toHaveAttribute('href', 'blob:zip');
    expect(screen.getByRole('link', { name: /下載 ZIP/ })).toHaveAttribute('download', 'shapecut-files.zip');
    expect(screen.getByRole('link', { name: /下載 SVG/ })).toHaveAttribute('download', 'cut-and-engrave.svg');
    expect(screen.getByRole('link', { name: /下載 DXF/ })).toHaveAttribute('download', 'cut-and-engrave.dxf');
    expect(screen.getByRole('link', { name: /平面預覽 PDF/ })).toHaveAttribute('download', 'preview.pdf');
    expect(screen.getByRole('link', { name: /爆炸圖 PDF/ })).toHaveAttribute('download', 'exploded-view.pdf');
    expect(screen.queryByRole('link', { name: /JSON|manifest/i })).not.toBeInTheDocument();
    expect(screen.getByText('10 × 5 mm')).toBeVisible();
    expect(screen.getByText('總高度 1 mm')).toBeVisible();
    expect(screen.getByRole('img', { name: /模型分層預覽/ })).toBeVisible();
    expect(screen.getByText(/顏色.*相對.*不代表.*雷射功率/)).toBeVisible();
  });

  it('distinguishes omitted hole, deep, and light features and only shows measured technical values', async () => {
    const user = userEvent.setup();
    const retainedHole = {
      id: 'hole', role: 'CUT_BLACK' as const,
      outer: [[3, 2], [4, 1], [5, 2], [4, 3]] as const,
      boundsMm: { minX: 3, minY: 1, maxX: 5, maxY: 3 }, areaMm2: 2,
    };
    const deepFeature = {
      id: 'deep', role: 'DEEP_RED' as const,
      outer: [[1, 1], [2, 1], [2, 2], [1, 2]] as const,
      boundsMm: { minX: 1, minY: 1, maxX: 2, maxY: 2 }, areaMm2: 1,
    };
    const measuredLayer: ColoredOutlineLayer = {
      ...coloredLayer,
      centralHole: retainedHole,
      deepFeature,
      diagnostics: {
        hole: { status: 'retained', equivalentDiameterMm: 1.6, axisDistanceMm: 0.1 },
        depth: { cellSizeMm: 0.1, contrastMm: 0.9, redThresholdMm: 0.7, blueThresholdMm: 0.3 },
      },
    };
    const omittedLayer: ColoredOutlineLayer = {
      ...coloredLayer,
      id: 'layer-1', index: 1, zStart: 1, zEnd: 2,
      exterior: { ...coloredLayer.exterior, id: 'layer-1-exterior' },
    };
    const warningResult = {
      ...result,
      status: 'warning' as const,
      coloredLayers: [measuredLayer, omittedLayer],
      preview: { ...result.preview, layers: [measuredLayer, omittedLayer] },
      featureWarnings: [
        'No reliable central axle hole was found; the hole was omitted.',
        '表面深度資料不足，已省略雕刻特徵',
      ],
    };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(warningResult) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'features.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    const warningPanel = screen.getByRole('region', { name: '模型處理提示' });
    expect(warningPanel).toHaveTextContent('部分切片未偵測到可靠中央孔');
    expect(warningPanel).toHaveTextContent('部分切片未保留較深層紅色特徵');
    expect(warningPanel).toHaveTextContent('未保留較淺層藍色特徵');
    await user.click(screen.getByText('技術資料'));
    expect(screen.getByText('1.6 mm')).toBeVisible();
    expect(screen.getByText('0.7 mm')).toBeVisible();
    expect(screen.queryByText('0.3 mm')).toBeNull();
  });

  it('omits hole diameter and depth-threshold rows when no corresponding feature was detected', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services()} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'plain.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    await user.click(screen.getByText('技術資料'));

    expect(screen.queryByText('偵測中央孔直徑')).toBeNull();
    expect(screen.queryByText('紅色深層門檻')).toBeNull();
    expect(screen.queryByText('藍色淺層門檻')).toBeNull();
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

  it('provides keyboard-accessible technical data and describes the exact ZIP contents', async () => {
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
    expect(details).toHaveTextContent('cut-and-engrave.svg、cut-and-engrave.dxf、preview.pdf 及 exploded-view.pdf');
    expect(details).not.toHaveTextContent('private-name.stl');
  });

  it('renders the result viewport from the actual preview payload instead of a fixed decorative shape', async () => {
    const user = userEvent.setup();
    const firstServices = services();
    const firstRender = render(<OneClickConverter services={firstServices} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'wide.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    const firstPath = firstRender.container.querySelector('[data-role="CUT_BLACK"]')?.getAttribute('d');
    firstRender.unmount();

    const changedLayer = {
      ...coloredLayer,
      exterior: {
        ...coloredLayer.exterior,
        outer: [[0, 0], [4, 0], [2, 8]] as const,
        boundsMm: { minX: 0, minY: 0, maxX: 4, maxY: 8 }, areaMm2: 16,
      },
    };
    const changed = {
      ...result,
      layers: [{
        ...result.layers[0],
        contour: { outer: [[0, 0], [4, 0], [2, 8]], holes: [] as const },
        sourceAreaMm2: 16,
        simplifiedAreaMm2: 16,
        sourceBoundsMm: { minX: 0, minY: 0, maxX: 4, maxY: 8 },
      }],
      coloredLayers: [changedLayer],
      preview: { ...result.preview, layers: [changedLayer] },
    };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(changed) })} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'tall.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    const secondPath = document.querySelector('[data-role="CUT_BLACK"]')?.getAttribute('d');

    expect(firstPath).toBe('M 0 0 L 10 0 L 10 5 L 0 5 Z');
    expect(secondPath).toBe('M 0 0 L 4 0 L 2 8 Z');
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
