import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AutomaticOutlineError,
  type AutomaticOutlineProgressEvent,
  type AutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, type ColoredOutlineLayer } from '../domain/outline-features/types';
import { MAX_STL_BYTES } from '../domain/mesh/parse-stl';
import { manufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import { SupersededError } from '../workers/geometry-client';
import { OutlineArtifactError } from '../workers/geometry-api';
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
  launcherCuts: [], fastenerHoles: [], deepFeatures: [], lightFeatures: [],
  removedComponentCount: 0,
  diagnostics: {
    hole: { status: 'omitted' },
    depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
  },
};
const resultMaterial = manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!);

const result: AutomaticOutlineResult = {
  sourceHash: 'a'.repeat(32),
  material: resultMaterial,
  assembly: {
    material: resultMaterial,
    launcher: { status: 'omitted', cutCount: 0 },
    fastener: { count: 0, centers: [], finishedDiameterMm: 3, pathDiameterMm: 2.85 },
    topFeatures: { retained: { red: 0, blue: 0 }, omitted: { red: 0, blue: 0 } },
  },
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
    createTimeline: (clock) => {
      let lastStage = -1;
      return {
        advance: (stage, preview) => {
          const nextStage = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'].indexOf(stage);
          if (nextStage <= lastStage) return;
          lastStage = nextStage;
          clock.onStage(stage, preview);
        },
        finish: () => Promise.resolve(),
        cancel: vi.fn(),
      };
    },
    ...overrides,
  };
}

async function uploadAndSelectMaterial(user: ReturnType<typeof userEvent.setup>, file: File): Promise<void> {
  await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
  await user.selectOptions(await screen.findByLabelText('選擇製作材料'), 'plywood-3');
}

describe('OneClickConverter', () => {
  it('holds a fast completed conversion behind the five-stage eight-second presentation', async () => {
    vi.useFakeTimers();
    try {
      let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
      const api = services({
        createTimeline: undefined,
        convert: vi.fn((_bytes, _material, onProgress) => {
          report = onProgress;
          report?.({ stage: 'reading' });
          report?.({ stage: 'analyzing', preview: result.preview });
          report?.({ stage: 'simplifying' });
          report?.({ stage: 'slicing', preview: result.preview });
          report?.({ stage: 'packaging' });
          return Promise.resolve(result);
        }),
      });
      render(<OneClickConverter services={api} />);

      const file = new File(['mesh'], 'fast.stl');
      Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [file] } }); });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: 'plywood-3' } }); });
      await act(async () => { await Promise.resolve(); });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(screen.queryByRole('heading', { name: '轉換完成' })).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('heading', { name: '轉換完成' })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the material, launcher, fastener, and top-feature assembly summary without adding downloads', async () => {
    const user = userEvent.setup();
    const assemblyResult = {
      ...result,
      assembly: {
        material: manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!),
        launcher: { status: 'fallback' as const, cutCount: 3 as const, assemblyAllowanceMm: 0.2 as const },
        fastener: {
          count: 2 as const, centers: [[6, 0], [-6, 0]] as const,
          finishedDiameterMm: 3 as const, pathDiameterMm: 2.85, radiusMm: 6, rotationRad: 0,
        },
        topFeatures: { retained: { red: 4, blue: 3 }, omitted: { red: 2, blue: 1 } },
      },
    };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(assemblyResult) })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'assembly.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.getByText('發射器相容性').nextElementSibling).toHaveTextContent('後備樣板');
    expect(screen.getByText('固定螺絲孔').nextElementSibling).toHaveTextContent('2 個');
    expect(screen.getByText('頂層紅色特徵').nextElementSibling).toHaveTextContent('保留 4，省略 2');
    expect(screen.getByText('頂層藍色特徵').nextElementSibling).toHaveTextContent('保留 3，省略 1');
    expect(screen.getByText('製作材料').nextElementSibling).toHaveTextContent(/3 mm.*kerf 0\.15 mm/i);
    expect(screen.getAllByRole('link', { name: /下載/ })).toHaveLength(5);
  });

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
    await uploadAndSelectMaterial(user, new File(['solid model'], 'retry.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });
    expect(api.convert).toHaveBeenCalledOnce();
  });
  it('requires material selection before conversion and resets the chooser for a replacement file', async () => {
    const user = userEvent.setup();
    const api = services();
    render(<OneClickConverter services={api} />);
    const file = new File(['solid model'], 'spinner.stl', { type: 'model/stl' });
    const expectedSubset = manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);

    expect(api.cancel).toHaveBeenCalledOnce();
    expect(api.convert).not.toHaveBeenCalled();
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), expectedSubset.id);
    expect(api.convert).toHaveBeenCalledOnce();
    expect(api.convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), expectedSubset, expect.any(Function));
    await screen.findByRole('heading', { name: '轉換完成' });
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['replacement'], 'replacement.stl'));
    expect(await screen.findByLabelText('選擇製作材料')).toHaveValue('');
  });

  it('does not leave an old material selection actionable while a replacement file is still reading', async () => {
    const user = userEvent.setup();
    const replacementRead = deferred<ArrayBuffer>();
    const oldBytes = new ArrayBuffer(3);
    const replacementBytes = new ArrayBuffer(4);
    const oldFile = new File(['old'], 'old.stl');
    const replacement = new File(['replacement'], 'replacement.stl');
    Object.defineProperty(oldFile, 'arrayBuffer', { value: vi.fn().mockResolvedValue(oldBytes) });
    Object.defineProperty(replacement, 'arrayBuffer', { value: vi.fn(() => replacementRead.promise) });
    const api = services();
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), oldFile);
    await screen.findByLabelText('選擇製作材料');
    await user.upload(screen.getByLabelText('選擇 STL 模型'), replacement);

    expect(screen.queryByLabelText('選擇製作材料')).toBeNull();
    expect(api.convert).not.toHaveBeenCalled();
    replacementRead.resolve(replacementBytes);
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), 'plywood-3');

    expect(api.convert).toHaveBeenCalledWith(replacementBytes, expect.any(Object), expect.any(Function));
  });

  it('cancels the presentation hold before the worker when a replacement returns to material selection', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    const trace: string[] = [];
    const api = services({
      convert: vi.fn().mockReturnValue(conversion.promise),
      cancel: vi.fn(() => trace.push('worker')),
      createTimeline: (clock) => ({
        advance: (stage, preview) => clock.onStage(stage, preview),
        finish: () => Promise.resolve(),
        cancel: () => { trace.push('timeline'); },
      }),
    });
    const replacement = new File(['replacement'], 'replacement.stl');
    Object.defineProperty(replacement, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
    render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['old'], 'old.stl'));
    trace.length = 0;
    await user.upload(screen.getByLabelText('選擇 STL 模型'), replacement);

    expect(trace).toEqual(['timeline', 'worker']);
    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
    conversion.resolve(result);
  });

  it('keeps pre-geometry progress neutral, then announces monotonic stages through the preview status', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, _material, onProgress) => { report = onProgress; return conversion.promise; }) });
    const { container } = render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'busy.stl'));
    expect(screen.getByRole('heading', { name: '正在讀取模型' })).toBeVisible();
    expect(container.querySelector('.processing-loading-panel')).toHaveAttribute('role', 'status');
    expect(container.querySelector('.processing-loading-panel')).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelector('.processing-status-overlay')).toBeNull();
    report?.({ stage: 'simplifying' });
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: '正在讀取模型' })).toBeVisible());
    expect(container.querySelector('.processing-status-overlay')).toBeNull();
    report?.({ stage: 'reading' });
    await vi.waitFor(() => expect(container.querySelector('.processing-status-overlay')).toBeNull());
    report?.({ stage: 'slicing', preview: result.preview });
    await vi.waitFor(() => expect(container.querySelector('.processing-status-overlay > strong')).toHaveTextContent('正在產生切片'));
    expect(container.querySelector('.processing-status-overlay')).toHaveAttribute('role', 'status');
    report?.({ stage: 'analyzing', preview: result.preview });
    await vi.waitFor(() => expect(container.querySelector('.processing-status-overlay > strong')).toHaveTextContent('正在產生切片'));
    report?.({ stage: 'packaging' });
    await vi.waitFor(() => expect(container.querySelector('.processing-status-overlay > strong')).toHaveTextContent('正在準備下載'));
  });

  it('stays neutral until parsed preview data arrives, then uses the real viewport through packaging', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, _material, onProgress) => { report = onProgress; return conversion.promise; }) });
    const { container } = render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'preview.stl'));
    expect(container.querySelector('.processing-card')).not.toHaveClass('has-preview');
    expect(container.querySelector('.processing-loading-panel')).toBeInTheDocument();
    expect(container.querySelector('.processing-status-overlay')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /模型分層預覽/ })).toBeNull();
    expect(container.querySelector('.spinner')).toBeNull();

    report?.({ stage: 'analyzing', preview: result.preview });
    const preview = await screen.findByRole('img', { name: /模型分層預覽/ });
    expect(container.querySelector('.processing-card')).toHaveClass('has-preview');
    expect(container.querySelector('.processing-status-overlay')).toBeInTheDocument();
    expect(container.querySelector('.processing-loading-panel')).not.toBeInTheDocument();
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
      convert: vi.fn((_bytes, _material, onProgress) => {
        reports.push(onProgress);
        return conversions[reports.length - 1].promise;
      }),
    });
    render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['one'], 'old.stl'));
    await uploadAndSelectMaterial(user, new File(['two'], 'new.stl'));
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
    await uploadAndSelectMaterial(user, new File(['one'], 'old.stl'));
    await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce());
    await uploadAndSelectMaterial(user, new File(['two'], 'new.stl'));
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'old.stl'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the simplified warning, primary real viewport, and exact five colored downloads', async () => {
    const user = userEvent.setup();
    const warning = { ...result, mode: 'outline-2.5d' as const, status: 'warning' as const, warnings: ['已簡化模型'] };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(warning) })} />);
    await uploadAndSelectMaterial(user, new File(['mesh'], 'broken.stl'));

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
      deepFeatures: [deepFeature],
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'features.stl'));
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'plain.stl'));
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'exact-warning.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.queryByText('已簡化模型')).toBeNull();
    expect(screen.queryByText(/內部細節、孔洞/)).toBeNull();
    expect(screen.getAllByText(axisWarning)[0]).toBeVisible();
  });

  it('provides keyboard-accessible technical data and describes the exact ZIP contents', async () => {
    const user = userEvent.setup();
    const warning = { ...result, mode: 'outline-2.5d' as const, status: 'warning' as const, warnings: ['已簡化模型', '正式製作前應先試切少量零件'] };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(warning) })} />);
    await uploadAndSelectMaterial(user, new File(['mesh'], 'private-name.stl'));
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'wide.stl'));
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'tall.stl'));
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
    await uploadAndSelectMaterial(user, new File(['mesh'], 'huge.stl'));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型太複雜，超出這次可處理的上限');
    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    expect(screen.getByRole('heading', { name: '把 3D 模型變成 Laser Cut 切片' })).toBeVisible();
  });

  it('retains the real preview and shared-hole warning when preview PDF packaging fails', async () => {
    const user = userEvent.setup();
    const omissionResult = {
      ...result,
      status: 'warning' as const,
      featureWarnings: ['No reliable central axle hole was found; the hole was omitted.'],
    };
    render(<OneClickConverter services={services({
      convert: vi.fn().mockResolvedValue(omissionResult),
      package: vi.fn().mockRejectedValue(new OutlineArtifactError('preview.pdf')),
    })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'omitted-hole.stl'));

    expect(await screen.findByRole('alert')).toHaveTextContent('preview.pdf');
    expect(screen.getByRole('img', { name: /模型分層預覽/ })).toBeVisible();
    expect(document.querySelector('.failure-card .outline-process-viewport')).toHaveAttribute('data-stage', 'packaging');
    expect(screen.getByRole('region', { name: '模型處理提示' })).toHaveTextContent('所有切片未偵測到可靠中央孔');
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
  });

  it('retains completed evidence without inventing an artifact identity for a packaging timeout', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services({
      convert: vi.fn().mockResolvedValue(result),
      package: vi.fn().mockRejectedValue(new AutomaticOutlineError('TIME_LIMIT', 'internal package timeout')),
    })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'timeout.stl'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('處理時間過長，已安全停止');
    expect(alert).not.toHaveTextContent('受影響輸出');
    expect(screen.getByRole('img', { name: /模型分層預覽/ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
  });

  it('revokes every object URL on replacement and unmount', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const { unmount } = render(<OneClickConverter services={services()} />);
    await uploadAndSelectMaterial(user, new File(['one'], 'one.stl'));
    await screen.findByText('one.stl');
    await uploadAndSelectMaterial(user, new File(['two'], 'two.stl'));
    await screen.findByText('two.stl');
    expect(revoke).toHaveBeenCalledTimes(5);
    unmount();
    expect(revoke).toHaveBeenCalledTimes(10);
  });
});
