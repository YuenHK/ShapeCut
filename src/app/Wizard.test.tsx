import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AxisCandidate } from '../domain/axis/find-axis';
import type { MeshProblemReport, MeshRepairResult, TriangleMesh } from '../domain/mesh/types';
import type { ImportRepairAnalysis } from '../workers/geometry-api';
import { Wizard, type WizardServices } from './Wizard';

vi.mock('../preview/SpinnerViewport', () => ({
  SpinnerViewport: ({ meshProblems }: { readonly meshProblems?: MeshProblemReport }) => (
    <div data-testid="mesh-preview" data-triangles={meshProblems?.inspection.triangleCount} />
  ),
}));

const axis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.94, confirmed: false,
  radialRmsError: 0.01, centroidOffset: 0, source: 'inertia',
};

const mesh: TriangleMesh = {
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};

function report({
  triangles = 100,
  boundary = 0,
  nonManifold = 0,
  degenerate = 0,
  duplicate = 0,
}: {
  readonly triangles?: number;
  readonly boundary?: number;
  readonly nonManifold?: number;
  readonly degenerate?: number;
  readonly duplicate?: number;
} = {}): MeshProblemReport {
  return {
    inspection: {
      triangleCount: triangles,
      boundaryEdgeCount: boundary,
      nonManifoldEdgeCount: nonManifold,
      degenerateTriangleCount: degenerate,
      invertedVolume: false,
    },
    duplicateTriangleCount: duplicate,
    boundaryEdges: boundary > 0 ? [{ regionId: 'mesh-boundary-edge-0', points: [[0, 0, 0], [1, 0, 0]] }] : [],
    nonManifoldEdges: nonManifold > 0 ? [{ regionId: 'mesh-non-manifold-edge-0', points: [[0, 0, 0], [1, 0, 0]] }] : [],
    degenerateTriangles: degenerate > 0 ? [{ regionId: 'mesh-degenerate-triangle-0', points: [[0, 0, 0], [1, 0, 0], [0, 0, 0]] }] : [],
    duplicateTriangles: duplicate > 0 ? [{ regionId: 'mesh-duplicate-triangle-0', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }] : [],
    markersTruncated: {
      boundaryEdges: false,
      nonManifoldEdges: false,
      degenerateTriangles: false,
      duplicateTriangles: false,
    },
  };
}

function repair({
  mode = 'safe',
  accepted = true,
  before = report({ triangles: 163, degenerate: 63 }),
  after = report(),
  blockingReasons = [],
}: {
  readonly mode?: 'safe' | 'advanced';
  readonly accepted?: boolean;
  readonly before?: MeshProblemReport;
  readonly after?: MeshProblemReport;
  readonly blockingReasons?: readonly string[];
} = {}): MeshRepairResult {
  return {
    mode,
    mesh: { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
    before,
    after,
    changes: {
      removedDegenerate: before.inspection.degenerateTriangleCount - after.inspection.degenerateTriangleCount,
      removedDuplicate: before.duplicateTriangleCount - after.duplicateTriangleCount,
      weldedVertices: 4,
      splitVertices: mode === 'advanced' ? 2 : 0,
      filledHoles: mode === 'advanced' ? 1 : 0,
    },
    comparison: {
      beforeSize: [40, 30, 20],
      afterSize: [40, 29.97, 20],
      axisChangePercent: [0, 0.1, 0],
      beforeAbsoluteVolume: 1_000,
      afterAbsoluteVolume: 998,
      volumeChangePercent: 0.2,
    },
    accepted,
    blockingReasons,
  };
}

function analysis(safeRepair: MeshRepairResult = repair(), sourceHash = 'source-a'): ImportRepairAnalysis & { readonly sourceSha256: string } {
  return {
    sourceHash,
    sourceSha256: 'a'.repeat(64),
    originalMesh: { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
    originalPreview: { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
    originalReport: safeRepair.before,
    safeRepair,
    candidates: safeRepair.accepted ? [axis] : [],
  };
}

function successfulServices(): WizardServices {
  return {
    inspectAndRepair: vi.fn().mockResolvedValue(analysis()),
    advancedRepair: vi.fn().mockResolvedValue(repair({ mode: 'advanced' })),
    serializeRepairedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(84)),
    downloadRepairedSTL: vi.fn().mockResolvedValue(undefined),
    decompose: vi.fn().mockResolvedValue({ issues: [] }),
    engrave: vi.fn().mockResolvedValue({ issues: [] }),
    preflight: vi.fn().mockResolvedValue({ issues: [] }),
    buildKit: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    downloadKit: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Wizard', () => {
  it('locks future steps and preserves edited parameters when navigating back', async () => {
    const user = userEvent.setup();
    render(<Wizard services={successfulServices()} />);
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    const ribs = screen.getByLabelText('骨架數量');
    await user.clear(ribs);
    await user.type(ribs, '10');
    await user.click(screen.getByRole('button', { name: '軸心與尺寸' }));
    await user.click(screen.getByRole('button', { name: '自動拆件' }));

    expect(screen.getByLabelText('骨架數量')).toHaveValue(10);
  });

  it('keeps export disabled until the complete successful path passes', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl', { type: 'model/stl' }));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await user.clear(screen.getByLabelText('骨架數量'));
    await user.type(screen.getByLabelText('骨架數量'), '8');
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));

    await user.selectOptions(screen.getByLabelText('材料設定檔'), 'plywood-3');
    await user.selectOptions(screen.getByLabelText('雕刻級數'), '4');
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));

    expect(screen.getByRole('button', { name: '匯出製作套件' })).toBeEnabled();
    expect(services.decompose).toHaveBeenCalledWith(expect.objectContaining({ ribCount: 8 }));
    await user.click(screen.getByRole('button', { name: '匯出製作套件' }));
    expect(services.buildKit).toHaveBeenCalledWith(
      expect.objectContaining({ ribCount: 8 }),
      'a'.repeat(64),
    );
    expect(services.downloadKit).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('keeps export blocked and links a blocking issue to its explanation', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    services.preflight = vi.fn().mockResolvedValue({
      issues: [{ id: 'sheet-too-small', severity: 'blocking', regionId: 'layout-sheet', label: '板材太細', description: '零件超出板材邊界。' }],
    });
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));

    const issue = await screen.findByRole('button', { name: /板材太細/ });
    expect(issue).toHaveAttribute('aria-describedby', 'sheet-too-small-description');
    expect(screen.getByRole('button', { name: '匯出製作套件' })).toBeDisabled();
  });

  it('auto-applies an accepted safe repair and shows exact before-after counts', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'original-base.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(screen.getByText('退化三角形：63 → 0')).toBeVisible();
    expect(screen.getByText('Y 軸尺寸變化：0.1%')).toBeVisible();
    expect(screen.getByText('體積變化：0.2%')).toBeVisible();
    expect(screen.getByRole('heading', { name: '軸心與尺寸' })).toBeVisible();
    expect(services.inspectAndRepair).toHaveBeenCalledWith(expect.objectContaining({ name: 'original-base.stl' }));
  });

  it('requires explicit consent before advanced repair and restores the original report', async () => {
    const user = userEvent.setup();
    const blockedSafeRepair = repair({
      accepted: false,
      before: report({ triangles: 168, boundary: 4, nonManifold: 105, degenerate: 63, duplicate: 2 }),
      after: report({ triangles: 101, boundary: 4, nonManifold: 105 }),
      blockingReasons: ['仍有開放邊界', '仍有非流形邊'],
    });
    const services = successfulServices();
    services.inspectAndRepair = vi.fn().mockResolvedValue(analysis(blockedSafeRepair));
    services.advancedRepair = vi.fn().mockResolvedValue(repair({
      mode: 'advanced',
      accepted: true,
      before: blockedSafeRepair.after,
      after: report({ triangles: 103 }),
    }));
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'blocked.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(screen.getByRole('heading', { name: '匯入與修復' })).toBeVisible();
    expect(screen.getByText('非流形邊：105')).toBeVisible();
    expect(screen.getByText('退化三角形：63')).toBeVisible();
    expect(screen.getByText('非流形邊：105 → 105')).toBeVisible();
    expect(screen.getByText('重複三角形：2 → 0')).toBeVisible();
    expect(screen.getByText('仍有非流形邊')).toBeVisible();
    expect(screen.getByRole('button', { name: '進階修復' })).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /可能改變模型細節/ }));
    await user.click(screen.getByRole('button', { name: '進階修復' }));
    expect(services.advancedRepair).toHaveBeenCalledWith(
      expect.objectContaining({ indices: expect.any(Uint32Array) }),
      expect.objectContaining({ indices: expect.any(Uint32Array) }),
    );

    await user.click(screen.getByRole('button', { name: '復原原始模型' }));
    expect(screen.getByText('目前預覽：原始模型')).toBeVisible();
    expect(screen.getByText('非流形邊：105')).toBeVisible();
    expect(screen.getByText('退化三角形：63')).toBeVisible();
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  });

  it('does not unlock a rejected advanced repair and shows every blocking reason', async () => {
    const user = userEvent.setup();
    const blocked = repair({ accepted: false, after: report({ boundary: 3 }), blockingReasons: ['仍有開放邊界'] });
    const services = successfulServices();
    services.inspectAndRepair = vi.fn().mockResolvedValue(analysis(blocked));
    services.advancedRepair = vi.fn().mockResolvedValue(repair({
      mode: 'advanced',
      accepted: false,
      before: blocked.after,
      after: report({ boundary: 3 }),
      blockingReasons: ['仍有開放邊界', '體積變化超過 1%'],
    }));
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'rejected.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('checkbox', { name: /可能改變模型細節/ }));
    await user.click(screen.getByRole('button', { name: '進階修復' }));

    expect(screen.getByText('體積變化超過 1%')).toBeVisible();
    expect(screen.getByRole('button', { name: '使用進階修復' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  });

  it('downloads only an accepted repair and retains it separately after restore', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'original-base.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '匯入與修復' }));
    await user.click(screen.getByRole('button', { name: '下載已修復 STL' }));

    expect(services.serializeRepairedSTL).toHaveBeenCalledWith(
      expect.objectContaining({ indices: expect.any(Uint32Array) }),
      'safe',
    );
    expect(services.downloadRepairedSTL).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      'original-base.stl',
    );
    await user.click(screen.getByRole('button', { name: '復原原始模型' }));
    expect(screen.getByRole('button', { name: '預覽安全修復' })).toBeEnabled();
  });

  it('shows the exact worker exception without misclassifying topology failures as unreadable files', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    services.inspectAndRepair = vi.fn().mockRejectedValue(new Error('worker exploded exactly'));
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['bad'], 'bad.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(screen.getByRole('alert')).toHaveTextContent('操作失敗：worker exploded exactly');
    expect(screen.queryByText(/讀不到檔案/)).not.toBeInTheDocument();
  });

  it('ignores a stale analysis result after a newer file is selected', async () => {
    const user = userEvent.setup();
    const first = deferred<ReturnType<typeof analysis>>();
    const services = successfulServices();
    services.inspectAndRepair = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(analysis(repair(), 'source-new'));
    render(<Wizard services={services} />);

    const input = screen.getByLabelText('STL 模型檔案');
    await user.upload(input, new File(['first'], 'first.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.upload(input, new File(['second'], 'second.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(await screen.findByRole('heading', { name: '軸心與尺寸' })).toBeVisible();
    expect(services.inspectAndRepair).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'second.stl' }));
    first.resolve(analysis(repair({ accepted: false, after: report({ nonManifold: 8 }), blockingReasons: ['仍有非流形邊'] }), 'source-old'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByRole('heading', { name: '軸心與尺寸' })).toBeVisible();
    expect(screen.queryByText('非流形邊：8')).not.toBeInTheDocument();
  });

  it('does not trigger a download after serialization is superseded by a new file', async () => {
    const user = userEvent.setup();
    const serialization = deferred<ArrayBuffer>();
    const services = successfulServices();
    services.serializeRepairedSTL = vi.fn().mockReturnValue(serialization.promise);
    services.downloadRepairedSTL = vi.fn().mockResolvedValue(undefined);
    render(<Wizard services={services} />);

    const input = screen.getByLabelText('STL 模型檔案');
    await user.upload(input, new File(['first'], 'first.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '匯入與修復' }));
    await user.click(screen.getByRole('button', { name: '下載已修復 STL' }));

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['second'], 'second.stl'));
    expect(screen.getByText('second.stl')).toBeVisible();
    serialization.resolve(new ArrayBuffer(84));
    await Promise.resolve();
    await Promise.resolve();

    expect(services.downloadRepairedSTL).not.toHaveBeenCalled();
  });

  it('does not trigger a kit download after its build is superseded by a new file', async () => {
    const user = userEvent.setup();
    const kitBuild = deferred<Uint8Array>();
    const services = successfulServices();
    services.buildKit = vi.fn().mockReturnValue(kitBuild.promise);
    services.downloadKit = vi.fn().mockResolvedValue(undefined);
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['first'], 'first.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.clear(screen.getByLabelText('骨架數量'));
    await user.type(screen.getByLabelText('骨架數量'), '8');
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));
    await user.click(screen.getByRole('button', { name: '匯出製作套件' }));

    expect(services.buildKit).toHaveBeenCalledWith(
      expect.objectContaining({ ribCount: 8 }),
      'a'.repeat(64),
    );
    await user.click(screen.getByRole('button', { name: '匯入與修復' }));
    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['second'], 'second.stl'));
    kitBuild.resolve(new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();

    expect(services.downloadKit).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
