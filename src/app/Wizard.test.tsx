import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AxisCandidate } from '../domain/axis/find-axis';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import { classifyMaterialReadiness, type MaterialProfileV1 } from '../domain/materials/schema';
import type { MeshProblemReport, MeshRepairResult, TriangleMesh } from '../domain/mesh/types';
import type { ManufacturingArtifacts } from '../domain/pipeline/manufacturing-pipeline';
import { SourceFingerprintError, type StoredProjectV1 } from '../persistence/project-repository';
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

const readyTestMaterial: MaterialProfileV1 = {
  ...defaultPendingMaterialProfile('plywood-3')!,
  id: 'test-only-ready-birch-b42',
  machine: 'TEST ONLY Trotec Q400 #1',
  materialCode: 'TEST-BIRCH-PLY-B42',
  materialName: 'TEST ONLY ready birch plywood',
  batchNotes: 'TEST ONLY exact manufacturer batch B42 measured at four corners',
  calibratedAt: '2026-07-19T01:02:03.000Z',
  physicalCouponVerified: true,
  operatorApproval: {
    operatorName: 'Test Operator',
    qualification: 'TEST ONLY qualified laser cutter operator',
    signedAt: '2026-07-19T01:02:03.000Z',
    signature: 'TEST-OPERATOR-SIGNATURE-B42',
    couponId: 'TEST-COUPON-B42',
  },
  safetyEvidence: {
    kind: 'allowlisted',
    category: 'laser-approved-plywood',
    compositionKnown: true,
    manufacturer: 'TEST ONLY Timber Company',
    productId: 'TEST BIRCH PLY B42',
    laserSafetyReference: 'TEST ONLY manufacturer safety reference B42',
  },
};

const pendingTestMaterial: MaterialProfileV1 = {
  ...readyTestMaterial,
  id: 'test-only-pending-birch-b42',
  materialName: 'TEST ONLY pending birch plywood',
  calibratedAt: null,
  physicalCouponVerified: false,
  operatorApproval: undefined,
};

function report({
  triangles = 100,
  boundary = 0,
  nonManifold = 0,
  degenerate = 0,
  duplicate = 0,
  inconsistentWinding = 0,
  selfIntersections = 0,
  selfIntersectionAnalysisComplete = true,
}: {
  readonly triangles?: number;
  readonly boundary?: number;
  readonly nonManifold?: number;
  readonly degenerate?: number;
  readonly duplicate?: number;
  readonly inconsistentWinding?: number;
  readonly selfIntersections?: number;
  readonly selfIntersectionAnalysisComplete?: boolean;
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
    inconsistentWindingEdgeCount: inconsistentWinding,
    selfIntersectionCount: selfIntersections,
    selfIntersectionAnalysisComplete,
    boundaryEdges: boundary > 0 ? [{ regionId: 'mesh-boundary-edge-0', points: [[0, 0, 0], [1, 0, 0]] }] : [],
    nonManifoldEdges: nonManifold > 0 ? [{ regionId: 'mesh-non-manifold-edge-0', points: [[0, 0, 0], [1, 0, 0]] }] : [],
    degenerateTriangles: degenerate > 0 ? [{ regionId: 'mesh-degenerate-triangle-0', points: [[0, 0, 0], [1, 0, 0], [0, 0, 0]] }] : [],
    duplicateTriangles: duplicate > 0 ? [{ regionId: 'mesh-duplicate-triangle-0', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }] : [],
    inconsistentWindingEdges: inconsistentWinding > 0 ? [{ regionId: 'mesh-winding-edge-0', points: [[0, 0, 0], [1, 0, 0]] }] : [],
    selfIntersections: selfIntersections > 0 ? [{ regionId: 'mesh-self-intersection-0', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }] : [],
    markersTruncated: {
      boundaryEdges: false,
      nonManifoldEdges: false,
      degenerateTriangles: false,
      duplicateTriangles: false,
      inconsistentWindingEdges: false,
      selfIntersections: false,
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

function analysis(safeRepair: MeshRepairResult = repair(), sourceHash = 'source-a'): ImportRepairAnalysis & {
  readonly sourceSha256: string;
  readonly meshSha256: string;
  readonly repairProvenance: { readonly mode: 'safe'; readonly algorithmVersion: string };
} {
  return {
    sourceHash,
    sourceSha256: 'a'.repeat(64),
    meshSha256: 'c'.repeat(64),
    repairProvenance: { mode: 'safe', algorithmVersion: 'safe-repair-v1' },
    originalMesh: { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
    originalPreview: { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
    originalReport: safeRepair.before,
    safeRepair,
    candidates: safeRepair.accepted ? [axis] : [],
  };
}

function artifactResult(issues: readonly { readonly code: string; readonly severity: 'blocking' | 'confirm' | 'info'; readonly message: string; readonly regionId?: string; readonly fixes: readonly [] }[] = []): ManufacturingArtifacts {
  const provenance = { inputFingerprint: 'version-a' };
  const envelope = (value: unknown) => ({ provenance, value });
  return {
    provenance,
    profile: envelope({}),
    kit: envelope({}),
    material: envelope({}),
    engraving: envelope({}),
    layout: envelope({}),
    preflight: envelope({ issues, canExport: issues.every(({ severity }) => severity === 'info') }),
    document: envelope({ provenance }),
  } as unknown as ManufacturingArtifacts;
}

function successfulServices(): WizardServices {
  const pendingBuiltin = defaultPendingMaterialProfile('plywood-3')!;
  return {
    cancelGeometry: vi.fn(),
    listMaterials: vi.fn().mockResolvedValue([{
      source: 'builtin',
      profile: pendingBuiltin,
      readiness: classifyMaterialReadiness(pendingBuiltin),
    }]),
    saveMaterialJson: vi.fn().mockRejectedValue(new Error('Material storage is unavailable in this test')),
    inspectAndRepair: vi.fn().mockResolvedValue(analysis()),
    advancedRepair: vi.fn().mockResolvedValue({
      ...repair({ mode: 'advanced' }),
      meshSha256: 'd'.repeat(64),
      repairProvenance: { mode: 'advanced', algorithmVersion: 'advanced-repair-v1' },
    }),
    serializeRepairedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(84)),
    downloadRepairedSTL: vi.fn().mockResolvedValue(undefined),
    createArtifacts: vi.fn().mockResolvedValue(artifactResult()),
    buildKit: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    downloadKit: vi.fn().mockResolvedValue(undefined),
  };
}

async function reachEngraving(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl'));
  await user.click(screen.getByRole('button', { name: '分析模型' }));
  await user.click(screen.getByRole('button', { name: '確認軸心' }));
  await user.click(screen.getByRole('button', { name: '下一步' }));
  await user.click(screen.getByRole('button', { name: '接受拆件建議' }));
  expect(await screen.findByRole('heading', { name: '紋理與材料' })).toBeVisible();
}

function storedProject(overrides: Partial<StoredProjectV1> = {}): StoredProjectV1 {
  return {
    schemaVersion: 1,
    id: 'saved-spinner',
    name: 'Saved spinner',
    step: 'decomposition',
    axis: { ...axis, confirmed: true },
    settings: {
      splitPositionPercent: 50, ribCount: 10, ringLayers: 2, shaftMm: 3, fit: 'snug', materialId: 'plywood-3',
      engravingLevels: 4, textureStrength: 0.6, sheetWidthMm: 300, sheetHeightMm: 200,
    },
    sourceSha256: 'a'.repeat(64),
    repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1', meshSha256: 'c'.repeat(64) },
    updatedAt: '2026-07-19T09:00:00.000Z',
    ...overrides,
  };
}

function repositoryWith(project: StoredProjectV1) {
  return {
    list: vi.fn().mockResolvedValue([project]),
    get: vi.fn().mockResolvedValue(project),
    attachSource: vi.fn().mockResolvedValue(project),
    save: vi.fn().mockResolvedValue(project),
  };
}

describe('Wizard', () => {
  it('lists a ready stored profile and loads, validates, saves, and selects its edited JSON', async () => {
    const user = userEvent.setup();
    const edited = { ...readyTestMaterial, machine: 'TEST ONLY edited Q400' };
    const services = Object.assign(successfulServices(), {
      listMaterials: vi.fn().mockResolvedValue([
        { source: 'builtin', profile: defaultPendingMaterialProfile('plywood-3')!, readiness: classifyMaterialReadiness(defaultPendingMaterialProfile('plywood-3')) },
        { source: 'stored', profile: readyTestMaterial, readiness: classifyMaterialReadiness(readyTestMaterial) },
      ]),
      saveMaterialJson: vi.fn().mockResolvedValue({ source: 'stored', profile: edited, readiness: classifyMaterialReadiness(edited) }),
    });
    render(<Wizard services={services as never} />);
    await reachEngraving(user);

    const materialSelect = screen.getByLabelText('材料設定檔');
    expect(await screen.findByRole('option', { name: /TEST ONLY ready birch plywood.*已就緒/ })).toBeVisible();
    await user.selectOptions(materialSelect, readyTestMaterial.id);
    await user.click(screen.getByRole('button', { name: '載入所選設定檔 JSON' }));
    expect(screen.getByLabelText('材料設定檔 JSON')).toHaveValue(JSON.stringify(readyTestMaterial, null, 2));

    fireEvent.change(screen.getByLabelText('材料設定檔 JSON'), { target: { value: JSON.stringify(edited) } });
    await user.click(screen.getByRole('button', { name: '驗證並儲存材料設定檔' }));

    expect(services.saveMaterialJson).toHaveBeenCalledWith(JSON.stringify(edited));
    expect(await screen.findByRole('status')).toHaveTextContent(`已儲存並選取材料設定檔：${edited.materialName}`);
    expect(materialSelect).toHaveValue(edited.id);
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));
    expect(services.createArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ materialId: edited.id }),
    }));
  });

  it('shows a controlled error when material JSON validation fails and does not change selection', async () => {
    const user = userEvent.setup();
    const services = Object.assign(successfulServices(), {
      listMaterials: vi.fn().mockResolvedValue([
        { source: 'builtin', profile: defaultPendingMaterialProfile('plywood-3')!, readiness: classifyMaterialReadiness(defaultPendingMaterialProfile('plywood-3')) },
      ]),
      saveMaterialJson: vi.fn().mockRejectedValue(new SyntaxError('Material profile JSON is invalid')),
    });
    render(<Wizard services={services as never} />);
    await reachEngraving(user);

    fireEvent.change(screen.getByLabelText('材料設定檔 JSON'), { target: { value: '{"schemaVersion":1' } });
    await user.click(screen.getByRole('button', { name: '驗證並儲存材料設定檔' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('操作失敗：Material profile JSON is invalid');
    expect(screen.getByLabelText('材料設定檔')).toHaveValue('plywood-3');
  });

  it('labels stored profiles missing coupon and operator evidence as pending and keeps their preflight blocked', async () => {
    const user = userEvent.setup();
    const services = Object.assign(successfulServices(), {
      listMaterials: vi.fn().mockResolvedValue([
        { source: 'stored', profile: pendingTestMaterial, readiness: classifyMaterialReadiness(pendingTestMaterial) },
      ]),
      saveMaterialJson: vi.fn(),
      createArtifacts: vi.fn().mockResolvedValue(artifactResult([
        { code: 'material-calibration', severity: 'blocking', message: 'Physical coupon and signed operator approval are pending.', fixes: [] },
      ])),
    });
    render(<Wizard services={services as never} />);
    await reachEngraving(user);

    expect(await screen.findByRole('option', { name: /TEST ONLY pending birch plywood.*待確認/ })).toBeVisible();
    expect(screen.getByText(/Physical coupon and signed operator approval are pending/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));
    expect(screen.getByRole('button', { name: '匯出製作套件' })).toBeDisabled();
  });

  it('opens a saved project through the startup chooser but keeps every downstream step locked until reanalysis', async () => {
    const user = userEvent.setup();
    const saved = storedProject();
    const repository = repositoryWith(saved);
    const services = successfulServices();
    render(<Wizard services={services} repository={repository as never} />);

    await user.selectOptions(await screen.findByLabelText('開啟已儲存專案'), saved.id);
    await user.click(screen.getByRole('button', { name: '載入專案' }));

    expect(screen.getByRole('heading', { name: '匯入與修復' })).toBeVisible();
    expect(screen.getByText(/請重新附加原始 STL/)).toHaveTextContent(saved.sourceSha256);
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
    expect(services.inspectAndRepair).not.toHaveBeenCalled();
  });

  it('rejects a different reattached STL before geometry analysis and stays locked at import', async () => {
    const user = userEvent.setup();
    const saved = storedProject();
    const repository = repositoryWith(saved);
    repository.attachSource.mockRejectedValue(new SourceFingerprintError());
    const services = successfulServices();
    render(<Wizard services={services} repository={repository as never} />);

    await user.selectOptions(await screen.findByLabelText('開啟已儲存專案'), saved.id);
    await user.click(screen.getByRole('button', { name: '載入專案' }));
    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['wrong'], 'wrong.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('原始 STL 指紋不符');
    expect(services.inspectAndRepair).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '匯入與修復' })).toBeVisible();
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  });

  it('restores only a verified saved repair and resumes no later than decomposition', async () => {
    const user = userEvent.setup();
    const saved = storedProject({ step: 'export' });
    const repository = repositoryWith(saved);
    const services = successfulServices();
    render(<Wizard services={services} repository={repository as never} />);

    await user.selectOptions(await screen.findByLabelText('開啟已儲存專案'), saved.id);
    await user.click(screen.getByRole('button', { name: '載入專案' }));
    const file = new File(['matching'], 'matching.stl');
    await user.upload(screen.getByLabelText('STL 模型檔案'), file);
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(repository.attachSource).toHaveBeenCalledWith(saved.id, file);
    expect(services.inspectAndRepair).toHaveBeenCalledWith(file);
    expect(await screen.findByRole('heading', { name: '自動拆件' })).toBeVisible();
    expect(screen.getByLabelText('骨架數量')).toHaveValue(10);
    expect(screen.getByRole('button', { name: '紋理與材料' })).toBeDisabled();
  });

  it('deterministically reruns and verifies a saved advanced repair before resuming', async () => {
    const user = userEvent.setup();
    const saved = storedProject({
      repair: { mode: 'advanced', algorithmVersion: 'advanced-repair-v1', meshSha256: 'd'.repeat(64) },
    });
    const repository = repositoryWith(saved);
    const services = successfulServices();
    render(<Wizard services={services} repository={repository as never} />);

    await user.selectOptions(await screen.findByLabelText('開啟已儲存專案'), saved.id);
    await user.click(screen.getByRole('button', { name: '載入專案' }));
    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['matching'], 'matching.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(services.advancedRepair).toHaveBeenCalledWith(
      expect.objectContaining({ indices: expect.any(Uint32Array) }),
      expect.objectContaining({ indices: expect.any(Uint32Array) }),
    );
    expect(await screen.findByRole('heading', { name: '自動拆件' })).toBeVisible();
  });

  it('rejects a reanalysis whose repaired mesh fingerprint differs from the saved project', async () => {
    const user = userEvent.setup();
    const saved = storedProject({ repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1', meshSha256: 'e'.repeat(64) } });
    const repository = repositoryWith(saved);
    const services = successfulServices();
    render(<Wizard services={services} repository={repository as never} />);

    await user.selectOptions(await screen.findByLabelText('開啟已儲存專案'), saved.id);
    await user.click(screen.getByRole('button', { name: '載入專案' }));
    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['matching'], 'matching.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已儲存的修復結果與重新分析不一致');
    expect(screen.getByRole('heading', { name: '匯入與修復' })).toBeVisible();
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  });

  it('exports only the current versioned artifacts built from the accepted mesh, confirmed axis, repair provenance, and settings', async () => {
    const user = userEvent.setup();
    const artifacts = artifactResult();
    const services = {
      ...successfulServices(),
      createArtifacts: vi.fn().mockResolvedValue(artifacts),
      buildKit: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    };
    render(<Wizard services={services as never} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));
    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));
    await user.click(screen.getByRole('button', { name: '匯出製作套件' }));

    expect(services.createArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      sourceSha256: 'a'.repeat(64),
      meshSha256: 'c'.repeat(64),
      mesh: expect.objectContaining({ positions: expect.any(Float64Array), indices: expect.any(Uint32Array) }),
      axis: expect.objectContaining({ direction: [0, 0, 1], confirmed: true }),
      repair: { mode: 'safe', algorithmVersion: 'safe-repair-v1' },
      settings: expect.objectContaining({ ribCount: 6 }),
    }));
    expect(services.buildKit).toHaveBeenCalledWith(artifacts);
    expect(services.downloadKit).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('locks every job-affecting decomposition and engraving control while its artifact job is active', async () => {
    const user = userEvent.setup();
    const decomposition = deferred<ManufacturingArtifacts>();
    const engraving = deferred<ManufacturingArtifacts>();
    const services = successfulServices();
    services.createArtifacts = vi.fn()
      .mockReturnValueOnce(decomposition.promise)
      .mockReturnValueOnce(engraving.promise);
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));

    for (const label of ['分件線位置 (%)', '骨架數量', '外環層數', '金屬軸直徑 (mm)', '卡榫配合']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '匯入與修復' })).toBeEnabled();
    decomposition.resolve(artifactResult());
    expect(await screen.findByRole('heading', { name: '紋理與材料' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '產生雕刻與材料設定' }));
    for (const label of ['材料設定檔', '雕刻級數', '紋理強度', '板材闊度 (mm)', '板材高度 (mm)']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: '自動拆件' })).toBeDisabled();
    engraving.resolve(artifactResult());
    expect(await screen.findByRole('heading', { name: '排版與輸出' })).toBeVisible();
  });

  it('discards an artifact result when the settings fingerprint no longer matches the launched job', async () => {
    const user = userEvent.setup();
    const pending = deferred<ManufacturingArtifacts>();
    const services = successfulServices();
    services.createArtifacts = vi.fn().mockReturnValue(pending.promise);
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));
    const ribs = screen.getByLabelText('骨架數量');
    fireEvent.change(ribs, { target: { value: '10' } });
    expect(ribs).toHaveValue(10);
    pending.resolve(artifactResult());

    expect(await screen.findByRole('button', { name: '接受拆件建議' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: '自動拆件' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '紋理與材料' })).not.toBeInTheDocument();
    expect(services.createArtifacts).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ ribCount: 6 }) }));
  });

  it('rejects mixed-version manufacturing stages before applying them to the workflow', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    const coherent = artifactResult();
    services.createArtifacts = vi.fn().mockResolvedValue({
      ...coherent,
      layout: { ...coherent.layout, provenance: { ...coherent.provenance, inputFingerprint: 'version-b' } },
    });
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid'], 'spinner.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('button', { name: '確認軸心' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('製作 artifacts 不屬於同一輸入版本');
    expect(screen.getByRole('heading', { name: '自動拆件' })).toBeVisible();
    expect(screen.getByRole('button', { name: '紋理與材料' })).toBeDisabled();
  });

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

  it('keeps empty axis candidates manual-required and passes only the explicitly confirmed normalized manual axis', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    services.inspectAndRepair = vi.fn().mockResolvedValue({ ...analysis(), candidates: [] });
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid manual'], 'manual.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
    for (const [label, value] of [
      ['手動原點 X', '1'], ['手動原點 Y', '2'], ['手動原點 Z', '3'],
      ['手動方向 X', '0'], ['手動方向 Y', '3'], ['手動方向 Z', '4'],
    ] as const) await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: '確認手動軸心' }));
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '接受拆件建議' }));

    expect(services.createArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      axis: expect.objectContaining({ origin: [1, 2, 3], direction: [0, 0.6, 0.8], confirmed: true }),
    }));
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
    expect(services.createArtifacts).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ ribCount: 8 }) }));
    await user.click(screen.getByRole('button', { name: '匯出製作套件' }));
    expect(services.buildKit).toHaveBeenCalledWith(expect.objectContaining({ provenance: expect.any(Object) }));
    expect(services.downloadKit).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('keeps export blocked and links a blocking issue to its explanation', async () => {
    const user = userEvent.setup();
    const services = successfulServices();
    services.createArtifacts = vi.fn().mockResolvedValue(artifactResult([
      { code: 'sheet-too-small', severity: 'blocking', regionId: 'layout-sheet', message: '板材太細：零件超出板材邊界。', fixes: [] },
    ]));
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
    services.advancedRepair = vi.fn().mockResolvedValue({
      ...repair({
        mode: 'advanced',
        accepted: true,
        before: blockedSafeRepair.after,
        after: report({ triangles: 103 }),
      }),
      meshSha256: 'd'.repeat(64),
      repairProvenance: { mode: 'advanced', algorithmVersion: 'advanced-repair-v1' },
    });
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
    services.advancedRepair = vi.fn().mockResolvedValue({
      ...repair({
        mode: 'advanced',
        accepted: false,
        before: blocked.after,
        after: report({ boundary: 3 }),
        blockingReasons: ['仍有開放邊界', '體積變化超過 1%'],
      }),
      meshSha256: 'd'.repeat(64),
      repairProvenance: { mode: 'advanced', algorithmVersion: 'advanced-repair-v1' },
    });
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid test'], 'rejected.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));
    await user.click(screen.getByRole('checkbox', { name: /可能改變模型細節/ }));
    await user.click(screen.getByRole('button', { name: '進階修復' }));

    expect(screen.getByText('體積變化超過 1%')).toBeVisible();
    expect(screen.getByRole('button', { name: '使用進階修復' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  });

  it.each([
    ['面方向不一致', report({ inconsistentWinding: 3 }), '修復結果仍有面方向不一致'],
    ['三維自相交', report({ selfIntersections: 4 }), '仍有三維自相交'],
  ])('keeps a closed %s counterexample in the repair step', async (summaryLabel, after, reason) => {
    const user = userEvent.setup();
    const blocked = repair({ accepted: false, before: after, after, blockingReasons: [reason] });
    const services = successfulServices();
    services.inspectAndRepair = vi.fn().mockResolvedValue(analysis(blocked));
    render(<Wizard services={services} />);

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['solid counterexample'], 'counterexample.stl'));
    await user.click(screen.getByRole('button', { name: '分析模型' }));

    expect(screen.getAllByText(new RegExp(`${summaryLabel}：`)).length).toBeGreaterThan(0);
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.getByRole('button', { name: '軸心與尺寸' })).toBeDisabled();
  });

  it('downloads an accepted repair and retains it separately after restore', async () => {
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
    expect(services.cancelGeometry).toHaveBeenCalledTimes(2);
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

    expect(services.buildKit).toHaveBeenCalledWith(expect.objectContaining({ provenance: expect.any(Object) }));
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
