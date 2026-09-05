import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
import { createStlPresentationPayload } from '../preview/stl-presentation';
import { BLOCKED_TEST_MATERIAL, READY_TEST_MATERIAL as SOURCE_READY_TEST_MATERIAL } from '../test/ready-material';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import { PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING } from '../domain/outline-features/depth-field';
import { sha256Hex } from '../persistence/project-repository';
import {
  OneClickConverter,
  type OneClickConverterServices,
  type OutlineDownloads,
} from './OneClickConverter';

const VALID_PRESENTATION_STL = `solid preview
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 6 2
  endloop
endfacet
endsolid preview`;

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
const READY_TEST_MATERIAL = { ...SOURCE_READY_TEST_MATERIAL, id: 'acrylic-6', thicknessMm: 6 };

const resultMaterial = manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!);

const result: AutomaticOutlineResult = {
  sourceHash: 'a'.repeat(32),
  material: resultMaterial,
  assembly: {
    material: resultMaterial,
    launcher: {
      status: 'fixed', cutCount: 3,
      templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      rotationRad: 0, fitOffsetMm: 0, finishedAllowanceMm: 0.2,
      exteriorExpansion: {
        mode: 'shared-uniform', offsetMm: 0, maxOffsetMm: 6,
        affectedLayerIds: ['layer-0', 'layer-1'],
      },
    },
    fastener: { count: 0, centers: [], finishedDiameterMm: 3, pathDiameterMm: 2.85 },
    decorationOmissions: [],
    topFeatures: {
      retained: { red: 0, blue: 0 }, omitted: { red: 0, blue: 0 },
      launcherOverlap: {
        clipped: { red: 0, blue: 0 }, removed: { red: 0, blue: 0 },
      },
    },
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
  centralHoleSourceEvidence: [{ status: 'omitted' }],
  decorationOmissionSourceEvidence: [],
  coloredLayers: [coloredLayer],
  featureWarnings: [],
  featureEvidenceFingerprint: featureEvidenceFingerprint({
    sourceHash: 'a'.repeat(32), status: 'success', mode: 'exact',
    centralHoleSourceEvidence: [{ status: 'omitted' }],
    decorationOmissionSourceEvidence: [], coloredLayers: [coloredLayer],
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

function resultWithDecorationOmissions(
  layerIds: readonly string[] = ['layer-0'],
): AutomaticOutlineResult {
  return {
    ...result,
    status: 'warning',
    assembly: {
      ...result.assembly,
      decorationOmissions: layerIds.map((layerId) => ({
        layerId,
        reason: 'protected-cut-work-budget',
        roles: ['DEEP_RED', 'LIGHT_BLUE'],
      })),
    },
    featureWarnings: [PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING],
  };
}

const downloads: OutlineDownloads = {
  zip: { href: 'blob:zip', fileName: 'shapecut-files.zip' },
  svg: { href: 'blob:svg', fileName: 'cut-and-engrave.svg' },
  dxf: { href: 'blob:dxf', fileName: 'cut-and-engrave.dxf' },
  previewPdf: { href: 'blob:preview', fileName: 'preview.pdf' },
  explodedPdf: { href: 'blob:exploded', fileName: 'exploded-view.pdf' },
  launcherCoupon: { href: 'blob:launcher-coupon', fileName: 'launcher-fit-coupon.svg' },
};

function packageDownloads(prefix: string): OutlineDownloads {
  return {
    zip: { href: `blob:${prefix}-zip`, fileName: 'shapecut-files.zip' },
    svg: { href: `blob:${prefix}-svg`, fileName: 'cut-and-engrave.svg' },
    dxf: { href: `blob:${prefix}-dxf`, fileName: 'cut-and-engrave.dxf' },
    previewPdf: { href: `blob:${prefix}-preview`, fileName: 'preview.pdf' },
    explodedPdf: { href: `blob:${prefix}-exploded`, fileName: 'exploded-view.pdf' },
    launcherCoupon: { href: `blob:${prefix}-launcher-coupon`, fileName: 'launcher-fit-coupon.svg' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function services(overrides: Partial<OneClickConverterServices> = {}): OneClickConverterServices {
  return {
    present: vi.fn(async (bytes) => createStlPresentationPayload(bytes)),
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
    materialProfiles: [READY_TEST_MATERIAL],
    ...overrides,
  };
}

async function uploadAndSelectMaterial(user: ReturnType<typeof userEvent.setup>, file: File): Promise<void> {
  await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
  await user.selectOptions(await screen.findByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
}

describe('OneClickConverter', () => {
  it('offers downloadable sample models without selecting or processing them', async () => {
    const user = userEvent.setup();
    const api = services();

    render(<OneClickConverter services={api} />);

    expect(screen.getByRole('heading', {
      level: 1,
      name: '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片',
    })).toBeVisible();
    expect(screen.getByText(
      '放入 3D 陀螺 STL 模型，ShapeCut 會自動分析、簡化和分層切片，並準備可供 Laser Cut 使用的平面外形與製作檔案。',
    )).toBeVisible();

    const samples = screen.getByRole('region', { name: '範例模型' });
    expect(within(samples).getByRole('link', { name: '下載 sample1' })).toHaveAttribute(
      'href',
      '/samples/sample1.stl',
    );
    expect(within(samples).getByRole('link', { name: '下載 sample1' })).toHaveAttribute(
      'download',
      'sample1.stl',
    );
    expect(within(samples).getByRole('link', { name: '下載 sample2' })).toHaveAttribute(
      'href',
      '/samples/sample2.stl',
    );
    expect(within(samples).getByRole('link', { name: '下載 sample2' })).toHaveAttribute(
      'download',
      'sample2.stl',
    );
    expect(within(samples).getByText(
      '範例只供測試 ShapeCut 工作流程；實際切割前仍須檢查尺寸、材料、刀縫與結構安全。',
    )).toBeVisible();
    expect(screen.getByText('檔案只在你的瀏覽器內處理，不會上載到伺服器。')).toBeVisible();

    const sample1 = within(samples).getByRole('link', { name: '下載 sample1' });
    sample1.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await user.click(sample1);
    expect(screen.getByLabelText('選擇 STL 模型')).toBeInTheDocument();
    expect(api.convert).not.toHaveBeenCalled();
  });

  it('keeps a migrated v2 shell gated after source reattachment until explicit canonical regeneration', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const convert = vi.fn().mockResolvedValue(result);
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const deleteSavedProject = vi.fn().mockResolvedValue(undefined);
    const initialSavedProject = {
      schemaVersion: 3 as const,
      id: 'one-click-current' as const,
      updatedAt: '2026-07-28T00:00:00.000Z',
      sourceSha256: await sha256Hex(bytes),
      material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
      launcherFitOffsetMm: 0.05,
      launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: null,
      canonicalSourceHash: result.sourceHash,
      status: 'regeneration-required' as const,
    };
    const api = services({
      convert,
      saveProject,
      deleteSavedProject,
      savedProject: initialSavedProject,
    });
    const view = render(<OneClickConverter services={api} />);
    const file = new File([bytes], 'reattached.stl');

    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);

    expect(await screen.findByRole('button', { name: '重新產生正式輸出' })).toBeEnabled();
    expect(convert).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新產生正式輸出' }));
    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();
    expect(convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.objectContaining({ id: READY_TEST_MATERIAL.id }),
      0.05,
      expect.any(Function),
    );
    expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 3,
      status: 'ready',
      launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
    }));

    await user.click(screen.getByRole('button', { name: '捨棄已儲存專案並選擇另一個模型' }));
    expect(deleteSavedProject).toHaveBeenCalledOnce();
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['different'], 'different.stl'));
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(convert).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();

    const replacement = vi.mocked(saveProject).mock.calls[1][0];
    view.rerender(<OneClickConverter services={{ ...api, savedProject: replacement }} />);

    expect(await screen.findByRole('button', { name: '捨棄已儲存專案並選擇另一個模型' })).toBeVisible();
    expect(screen.queryByLabelText('選擇 STL 模型')).toBeNull();
    expect(replacement.sourceSha256).toBe(await sha256Hex(new TextEncoder().encode('different')));
    expect(replacement.launcherExteriorExpansion).toEqual(
      result.assembly.launcher.exteriorExpansion,
    );
  });

  it('keeps a changed stored expansion blocked until the replacement decision is reattached and regenerated', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const api = services({
      convert: vi.fn().mockResolvedValue(result),
      saveProject,
      savedProject: {
        schemaVersion: 3,
        id: 'one-click-current',
        updatedAt: '2026-07-28T00:00:00.000Z',
        sourceSha256: await sha256Hex(bytes),
        material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
        launcherFitOffsetMm: 0,
        launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
        launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
        launcherExteriorExpansion: {
          ...result.assembly.launcher.exteriorExpansion,
          offsetMm: 2.35,
        },
        decorationOmissions: result.assembly.decorationOmissions,
        canonicalSourceHash: result.sourceHash,
        status: 'regeneration-required',
      },
    });
    const view = render(<OneClickConverter services={api} />);
    const file = new File([bytes], 'reattached.stl');

    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));

    expect(api.package).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'regeneration-required',
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
    }));
    expect(screen.getByRole('button', { name: '重新產生正式輸出' })).toBeDisabled();

    const replacement = vi.mocked(saveProject).mock.calls.at(-1)![0];
    view.rerender(<OneClickConverter services={{ ...api, savedProject: replacement }} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));

    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();
    expect(api.package).toHaveBeenCalledOnce();
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready',
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
    }));
  });

  it('keeps a changed stored decoration-omission decision blocked until replacement save, reattachment, and regeneration', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const omissionResult = resultWithDecorationOmissions();
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const api = services({
      convert: vi.fn().mockResolvedValue(omissionResult),
      saveProject,
      savedProject: {
        schemaVersion: 3,
        id: 'one-click-current',
        updatedAt: '2026-07-28T00:00:00.000Z',
        sourceSha256: await sha256Hex(bytes),
        material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
        launcherFitOffsetMm: 0,
        launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
        launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
        launcherExteriorExpansion: omissionResult.assembly.launcher.exteriorExpansion,
        decorationOmissions: [],
        canonicalSourceHash: omissionResult.sourceHash,
        status: 'regeneration-required',
      },
    });
    const view = render(<OneClickConverter services={api} />);
    const file = new File([bytes], 'reattached.stl');

    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));

    expect(api.package).not.toHaveBeenCalled();
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      schemaVersion: 3,
      status: 'regeneration-required',
      decorationOmissions: omissionResult.assembly.decorationOmissions,
    }));
    expect(screen.getByText(
      '紅藍裝飾省略決策已更新；請重新連結原本 STL 後再次產生正式輸出。',
    )).toBeVisible();
    expect(screen.getByRole('button', { name: '重新產生正式輸出' })).toBeDisabled();

    const replacement = vi.mocked(saveProject).mock.calls.at(-1)![0];
    view.rerender(<OneClickConverter services={{ ...api, savedProject: replacement }} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));

    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();
    expect(api.package).toHaveBeenCalledOnce();
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready',
      decorationOmissions: omissionResult.assembly.decorationOmissions,
    }));
  });

  it('reports a template-only replacement without claiming the exterior expansion changed', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const saveProject = vi.fn().mockResolvedValue(undefined);
    const api = services({
      convert: vi.fn().mockResolvedValue(result),
      saveProject,
      savedProject: {
        schemaVersion: 3,
        id: 'one-click-current',
        updatedAt: '2026-07-28T00:00:00.000Z',
        sourceSha256: await sha256Hex(bytes),
        material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
        launcherFitOffsetMm: 0,
        launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
        launcherTemplateFingerprint: 'f'.repeat(32),
        launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
        decorationOmissions: result.assembly.decorationOmissions,
        canonicalSourceHash: result.sourceHash,
        status: 'regeneration-required',
      },
    });
    render(<OneClickConverter services={api} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([bytes], 'reattached.stl'),
    );
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));

    expect(api.package).not.toHaveBeenCalled();
    expect(saveProject).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'regeneration-required',
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
    }));
    expect(screen.getByText(
      '三爪樣板決策已更新；請重新連結原本 STL 後再次產生正式輸出。',
    )).toBeVisible();
    expect(screen.queryByText(/外框擴大決策已更新/)).not.toBeInTheDocument();
  });

  it('re-arms source reattachment when only the stored expansion decision is replaced', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const savedProject = {
      schemaVersion: 3 as const,
      id: 'one-click-current' as const,
      updatedAt: '2026-07-28T00:00:00.000Z',
      sourceSha256: await sha256Hex(bytes),
      material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
      launcherFitOffsetMm: 0,
      launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
      canonicalSourceHash: result.sourceHash,
      status: 'regeneration-required' as const,
    };
    const api = services({ savedProject });
    const view = render(<OneClickConverter services={api} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([bytes], 'reattached.stl'),
    );
    expect(await screen.findByRole('button', { name: '重新產生正式輸出' })).toBeEnabled();

    view.rerender(<OneClickConverter services={{
      ...api,
      savedProject: {
        ...savedProject,
        launcherExteriorExpansion: {
          ...savedProject.launcherExteriorExpansion,
          offsetMm: 2.35,
        },
      },
    }} />);

    expect(screen.getByRole('button', { name: '重新產生正式輸出' })).toBeDisabled();
  });

  it('re-arms source reattachment when only the stored decoration-omission decision is replaced', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved mesh');
    const savedProject = {
      schemaVersion: 3 as const,
      id: 'one-click-current' as const,
      updatedAt: '2026-07-28T00:00:00.000Z',
      sourceSha256: await sha256Hex(bytes),
      material: manufacturingGeometryProfile(READY_TEST_MATERIAL),
      launcherFitOffsetMm: 0,
      launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: [],
      canonicalSourceHash: result.sourceHash,
      status: 'regeneration-required' as const,
    };
    const api = services({ savedProject });
    const view = render(<OneClickConverter services={api} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([bytes], 'reattached.stl'),
    );
    expect(await screen.findByRole('button', { name: '重新產生正式輸出' })).toBeEnabled();

    view.rerender(<OneClickConverter services={{
      ...api,
      savedProject: {
        ...savedProject,
        decorationOmissions: resultWithDecorationOmissions().assembly.decorationOmissions,
      },
    }} />);

    expect(screen.getByRole('button', { name: '重新產生正式輸出' })).toBeDisabled();
  });

  it('keeps every workflow state inside one workbench without changing actions', async () => {
    const user = userEvent.setup();
    const read = deferred<ArrayBuffer>();
    const conversion = deferred<AutomaticOutlineResult>();
    const api = services({ convert: vi.fn().mockReturnValue(conversion.promise) });
    const file = new File(['mesh'], 'workbench.stl');
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockReturnValue(read.promise) });
    render(<OneClickConverter services={api} />);
    const expectState = (state: string) => {
      expect(screen.getAllByTestId('apple-workbench')).toHaveLength(1);
      expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', state);
    };

    expectState('upload');
    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);
    expectState('reading');

    await act(async () => { read.resolve(new ArrayBuffer(4)); await read.promise; });
    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
    expectState('material');

    await user.selectOptions(screen.getByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expectState('processing');
    expect(api.convert).toHaveBeenCalledOnce();

    await act(async () => { conversion.resolve(result); await conversion.promise; });
    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();
    expectState('result');
    expect(api.package).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('link', { name: /下載/ })).toHaveLength(6);

    fireEvent.change(screen.getByLabelText('選擇 STL 模型'), {
      target: { files: [new File(['bad'], 'not-stl.txt')] },
    });
    expect(await screen.findByRole('alert')).toBeVisible();
    expectState('failure');
    expect(api.convert).toHaveBeenCalledOnce();
    expect(api.package).toHaveBeenCalledOnce();
  });

  it('keeps an active conversion alive when only material profiles refresh', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    const api = services({ convert: vi.fn(() => conversion.promise) });
    const view = render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'profile-refresh.stl'));
    expect(api.convert).toHaveBeenCalledOnce();
    vi.mocked(api.cancel).mockClear();

    view.rerender(<OneClickConverter services={{
      ...api,
      materialProfiles: [
        ...(api.materialProfiles ?? []),
        {
          ...READY_TEST_MATERIAL,
          id: 'late-ready-profile',
          materialName: 'TEST ONLY late ready profile',
        },
      ],
    }} />);

    expect(api.cancel).not.toHaveBeenCalled();
    await act(async () => {
      conversion.resolve(result);
      await conversion.promise;
    });
    expect(await screen.findByRole('heading', { name: '轉換完成' })).toBeVisible();
    expect(api.package).toHaveBeenCalledOnce();
  });

  it('cancels an active conversion when operational services actually swap', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    const first = services({ convert: vi.fn(() => conversion.promise) });
    const second = services();
    const view = render(<OneClickConverter services={first} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'runtime-swap.stl'));
    vi.mocked(first.cancel).mockClear();
    view.rerender(<OneClickConverter services={second} />);

    expect(first.cancel).toHaveBeenCalledOnce();
    await act(async () => {
      conversion.resolve(result);
      await conversion.promise;
    });
    expect(first.package).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '轉換完成' })).toBeNull();
  });

  it('cancels the presentation hold and releases its URLs when operational services swap', async () => {
    vi.useFakeTimers();
    try {
      const packaged = deferred<OutlineDownloads>();
      const revoke = vi.fn();
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
      const first = services({
        createTimeline: undefined,
        convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
          onProgress?.({ stage: 'reading' });
          onProgress?.({ stage: 'analyzing', preview: result.preview });
          onProgress?.({ stage: 'simplifying' });
          onProgress?.({ stage: 'slicing', preview: result.preview });
          onProgress?.({ stage: 'packaging' });
          return Promise.resolve(result);
        }),
        package: vi.fn().mockReturnValue(packaged.promise),
      });
      const second = services();
      const view = render(<OneClickConverter services={first} />);
      const file = new File(['mesh'], 'runtime-swap-held.stl');
      Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });

      await act(async () => {
        fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [file] } });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: READY_TEST_MATERIAL.id } }); fireEvent.click(screen.getByRole('button', { name: '開始製作' }));
      });
      await act(async () => { await Promise.resolve(); });
      packaged.resolve(packageDownloads('runtime-swap-held'));
      await act(async () => { await Promise.resolve(); });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      vi.mocked(first.cancel).mockClear();

      await act(async () => {
        view.rerender(<OneClickConverter services={second} />);
      });

      expect(first.cancel).toHaveBeenCalledOnce();
      expect(revoke.mock.calls.map(([href]) => href)).toEqual([
        'blob:runtime-swap-held-zip',
        'blob:runtime-swap-held-svg',
        'blob:runtime-swap-held-dxf',
        'blob:runtime-swap-held-preview',
        'blob:runtime-swap-held-exploded',
        'blob:runtime-swap-held-launcher-coupon',
      ]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(screen.queryByRole('heading', { name: '轉換完成' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows depth-safe drag attraction and clears it on leave, drop, and reset', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services()} />);
    const input = screen.getByLabelText('選擇 STL 模型');
    const target = input.closest('label')!;
    const child = screen.getByText('拖放 STL 到這裏');

    fireEvent.dragEnter(target);
    fireEvent.dragEnter(child);
    expect(target).toHaveAttribute('data-drag-active', 'true');
    fireEvent.dragLeave(child);
    expect(target).toHaveAttribute('data-drag-active', 'true');
    fireEvent.dragLeave(target);
    expect(target).toHaveAttribute('data-drag-active', 'false');

    fireEvent.dragEnter(target);
    fireEvent.drop(target, { dataTransfer: { files: [] } });
    expect(target).toHaveAttribute('data-drag-active', 'false');

    fireEvent.dragEnter(target);
    fireEvent.change(input, { target: { files: [new File(['bad'], 'not-stl.txt')] } });
    expect(await screen.findByRole('alert')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    expect(screen.getByLabelText('選擇 STL 模型').closest('label')).toHaveAttribute('data-drag-active', 'false');
  });

  it('holds a fast completed conversion behind the five-stage eight-second presentation', async () => {
    vi.useFakeTimers();
    try {
      let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
      const api = services({
        createTimeline: undefined,
        convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
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
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: READY_TEST_MATERIAL.id } }); fireEvent.click(screen.getByRole('button', { name: '開始製作' })); });
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

  it('revokes package URLs already resolved during the result hold when a replacement cancels it', async () => {
    vi.useFakeTimers();
    try {
      const packaged = deferred<OutlineDownloads>();
      const revoke = vi.fn();
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
      const api = services({
        createTimeline: undefined,
        convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
          onProgress?.({ stage: 'reading' });
          onProgress?.({ stage: 'analyzing', preview: result.preview });
          onProgress?.({ stage: 'simplifying' });
          onProgress?.({ stage: 'slicing', preview: result.preview });
          onProgress?.({ stage: 'packaging' });
          return Promise.resolve(result);
        }),
        package: vi.fn().mockReturnValue(packaged.promise),
      });
      render(<OneClickConverter services={api} />);
      const first = new File(['mesh'], 'held.stl');
      const replacement = new File(['new'], 'replacement.stl');
      Object.defineProperty(first, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      Object.defineProperty(replacement, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [first] } }); });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: READY_TEST_MATERIAL.id } }); fireEvent.click(screen.getByRole('button', { name: '開始製作' })); });
      await act(async () => { await Promise.resolve(); });
      packaged.resolve(packageDownloads('held'));
      await act(async () => { await Promise.resolve(); });
      await vi.advanceTimersByTimeAsync(7_999);

      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [replacement] } }); });

      expect(revoke.mock.calls.map(([href]) => href)).toEqual([
        'blob:held-zip', 'blob:held-svg', 'blob:held-dxf', 'blob:held-preview', 'blob:held-exploded',
        'blob:held-launcher-coupon',
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.queryByRole('heading', { name: '轉換完成' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes package URLs that arrive after the result hold has been cancelled', async () => {
    vi.useFakeTimers();
    try {
      const packaged = deferred<OutlineDownloads>();
      const revoke = vi.fn();
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
      const api = services({ createTimeline: undefined, convert: vi.fn().mockResolvedValue(result), package: vi.fn().mockReturnValue(packaged.promise) });
      render(<OneClickConverter services={api} />);
      const first = new File(['mesh'], 'late-package.stl');
      const replacement = new File(['new'], 'replacement.stl');
      Object.defineProperty(first, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      Object.defineProperty(replacement, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [first] } }); });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: READY_TEST_MATERIAL.id } }); fireEvent.click(screen.getByRole('button', { name: '開始製作' })); });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [replacement] } }); });
      packaged.resolve(packageDownloads('late'));
      await act(async () => { await Promise.resolve(); });

      expect(revoke.mock.calls.map(([href]) => href)).toEqual([
        'blob:late-zip', 'blob:late-svg', 'blob:late-dxf', 'blob:late-preview', 'blob:late-exploded',
        'blob:late-launcher-coupon',
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(screen.queryByRole('heading', { name: '轉換完成' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes package URLs already resolved during the result hold on unmount', async () => {
    vi.useFakeTimers();
    try {
      const packaged = deferred<OutlineDownloads>();
      const revoke = vi.fn();
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
      const api = services({ createTimeline: undefined, convert: vi.fn().mockResolvedValue(result), package: vi.fn().mockReturnValue(packaged.promise) });
      const view = render(<OneClickConverter services={api} />);
      const file = new File(['mesh'], 'unmount-held.stl');
      Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [file] } }); });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: READY_TEST_MATERIAL.id } }); fireEvent.click(screen.getByRole('button', { name: '開始製作' })); });
      await act(async () => { await Promise.resolve(); });
      packaged.resolve(packageDownloads('unmount-held'));
      await act(async () => { await Promise.resolve(); });
      await vi.advanceTimersByTimeAsync(7_999);
      view.unmount();

      expect(revoke.mock.calls.map(([href]) => href)).toEqual([
        'blob:unmount-held-zip', 'blob:unmount-held-svg', 'blob:unmount-held-dxf', 'blob:unmount-held-preview', 'blob:unmount-held-exploded',
        'blob:unmount-held-launcher-coupon',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores late same-request worker progress after conversion resolves', async () => {
    vi.useFakeTimers();
    try {
      let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
      const api = services({
        createTimeline: undefined,
        convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
          report = onProgress;
          return Promise.resolve(result);
        }),
      });
      render(<OneClickConverter services={api} />);
      const file = new File(['mesh'], 'late-progress.stl');
      Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(4)) });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇 STL 模型'), { target: { files: [file] } }); });
      await act(async () => { fireEvent.change(screen.getByLabelText('選擇製作材料'), { target: { value: READY_TEST_MATERIAL.id } }); fireEvent.click(screen.getByRole('button', { name: '開始製作' })); });
      await act(async () => { await Promise.resolve(); });
      report?.({ stage: 'analyzing', preview: result.preview });
      await vi.advanceTimersByTimeAsync(8_000);
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByRole('heading', { name: '轉換完成' })).toBeVisible();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the material, launcher, fastener, and top-feature assembly summary with the coupon download', async () => {
    const user = userEvent.setup();
    const assemblyResult = {
      ...result,
      assembly: {
        material: manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!),
        launcher: {
          ...result.assembly.launcher,
          exteriorExpansion: {
            ...result.assembly.launcher.exteriorExpansion,
            offsetMm: 2.35,
          },
        },
        fastener: {
          count: 2 as const, centers: [[6, 0], [-6, 0]] as const,
          finishedDiameterMm: 3 as const, pathDiameterMm: 2.85, radiusMm: 6, rotationRad: 0,
        },
        decorationOmissions: [],
        topFeatures: {
          retained: { red: 4, blue: 3 }, omitted: { red: 2, blue: 1 },
          launcherOverlap: {
            clipped: { red: 1, blue: 0 }, removed: { red: 0, blue: 1 },
          },
        },
      },
    };
    render(<OneClickConverter services={services({ convert: vi.fn().mockResolvedValue(assemblyResult) })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'assembly.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.getByText('發射器相容性').nextElementSibling).toHaveTextContent('官方三爪孔：已加入頂部兩層');
    expect(screen.getByText('固定螺絲孔').nextElementSibling).toHaveTextContent('2 個');
    expect(screen.getByText('頂層紅色特徵').nextElementSibling).toHaveTextContent('保留 4，省略 2');
    expect(screen.getByText('頂層藍色特徵').nextElementSibling).toHaveTextContent('保留 3，省略 1');
    expect(screen.getByText('製作材料').nextElementSibling).toHaveTextContent(/3 mm.*kerf 0\.15 mm/i);
    expect(screen.getByText('頂部兩層外框已共同擴大 2.35 mm')).toBeVisible();
    expect(screen.getAllByRole('link', { name: /下載/ })).toHaveLength(6);
  });

  it('shows ordered affected layers and retained black geometry as a warning for protected-work omissions', async () => {
    const user = userEvent.setup();
    const omissionResult = resultWithDecorationOmissions(['layer-2', 'layer-4']);
    render(<OneClickConverter services={services({
      convert: vi.fn().mockResolvedValue(omissionResult),
    })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'protected-work-warning.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.getByText(
      PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING,
    )).toBeVisible();
    const affected = screen.getAllByText(/^受影響層：/);
    expect(affected.map((item) => item.textContent)).toEqual([
      '受影響層：layer-2',
      '受影響層：layer-4',
    ]);
    expect(screen.getByText('官方三爪孔及黑色切割幾何已保留')).toBeVisible();
    expect(screen.getByText('需注意')).toHaveClass('warning');
    expect(screen.queryByText('成功')).not.toBeInTheDocument();
    expect(screen.getByText(
      '依 Knight Fortress 樣本建立，待官方發射器實物校準',
    )).toBeVisible();
  });

  it('does not show the protected-work omission warning for an empty decision', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services()} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'no-protected-work-omission.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.queryByText(PROTECTED_CUT_WORK_BUDGET_OMISSION_WARNING))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/^受影響層：/)).not.toBeInTheDocument();
    expect(screen.queryByText('官方三爪孔及黑色切割幾何已保留'))
      .not.toBeInTheDocument();
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
  it('requires explicit start before conversion and resets the chooser for a replacement file', async () => {
    const user = userEvent.setup();
    const api = services();
    render(<OneClickConverter services={api} />);
    const file = new File(['solid model'], 'spinner.stl', { type: 'model/stl' });
    const expectedSubset = manufacturingGeometryProfile(READY_TEST_MATERIAL);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), file);

    expect(api.cancel).toHaveBeenCalledOnce();
    expect(api.convert).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('選擇製作材料')).toHaveValue(expectedSubset.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(api.convert).toHaveBeenCalledOnce();
    expect(api.convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), expectedSubset, 0, expect.any(Function));
    await screen.findByRole('heading', { name: '轉換完成' });
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['replacement'], 'replacement.stl'));
    expect(await screen.findByLabelText('選擇製作材料')).toHaveValue('acrylic-6');
    expect(screen.getByLabelText('三爪配合微調')).toHaveValue(0);
  });

  it('passes the controlled launcher fit offset with the selected material', async () => {
    const user = userEvent.setup();
    const api = services({ materialProfiles: [] });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'fit-offset.stl'));
    const fitInput = await screen.findByLabelText('三爪配合微調');
    expect(fitInput).toHaveValue(0);
    await user.clear(fitInput);
    await user.type(fitInput, '0.05');
    await user.selectOptions(screen.getByLabelText('選擇製作材料'), 'plywood-3');
    await user.click(screen.getByRole('button', { name: '開始製作' }));

    expect(api.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.objectContaining({ id: 'plywood-3' }),
      0.05,
      expect.any(Function),
    );
  });

  it('restores the default launcher fit after failure reset', async () => {
    const user = userEvent.setup();
    const api = services({
      convert: vi.fn().mockRejectedValue(new AutomaticOutlineError('RESOURCE_LIMIT', 'internal limit')),
    });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'first-fit.stl'));
    const fitInput = await screen.findByLabelText('三爪配合微調');
    await user.clear(fitInput);
    await user.type(fitInput, '0.05');
    await user.selectOptions(screen.getByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'second-fit.stl'));
    expect(await screen.findByLabelText('三爪配合微調')).toHaveValue(0);
    expect(screen.getByLabelText('選擇製作材料')).toHaveValue('acrylic-6');
  });

  it.each([
    ['a non-step value', '0.205'],
    ['an underflowing exponent', '1e-9999'],
    ['a rounded long decimal', '0.1000000000000000001'],
    ['a leading-zero coercion', '00.10'],
    ['Infinity', 'Infinity'],
    ['pasted text', 'not-a-number'],
  ])('blocks material conversion and announces an inline error for %s', async (_label, invalidValue) => {
    const user = userEvent.setup();
    const api = services({ materialProfiles: [] });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'invalid-fit.stl'));
    const fitInput = await screen.findByLabelText('三爪配合微調');
    await user.clear(fitInput);
    if (invalidValue === 'not-a-number') {
      await user.click(fitInput);
      await user.paste(invalidValue);
    } else {
      fireEvent.change(fitInput, { target: { value: invalidValue } });
    }

    expect(screen.getByRole('alert')).toHaveTextContent('請輸入 -0.20 至 +0.20 mm，步進 0.01 mm。');
    await user.selectOptions(screen.getByLabelText('選擇製作材料'), 'plywood-3');
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(api.convert).not.toHaveBeenCalled();
    expect(screen.getByLabelText('選擇製作材料')).toHaveValue('plywood-3');
  });

  it.each([
    ['0', 0],
    ['0.00', 0],
    ['-0.20', -0.2],
    ['0.20', 0.2],
    ['.10', 0.1],
  ])('accepts the practical decimal fit form %s', async (fitValue, expectedOffset) => {
    const user = userEvent.setup();
    const api = services({ materialProfiles: [] });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'valid-fit.stl'));
    fireEvent.change(await screen.findByLabelText('三爪配合微調'), {
      target: { value: fitValue },
    });
    await user.selectOptions(screen.getByLabelText('選擇製作材料'), 'plywood-3');
    await user.click(screen.getByRole('button', { name: '開始製作' }));

    expect(api.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.objectContaining({ id: 'plywood-3' }),
      expectedOffset,
      expect.any(Function),
    );
  });

  it('reports canonical launcher evidence and offers the separate fit coupon', async () => {
    const user = userEvent.setup();
    const launcherResult: AutomaticOutlineResult = {
      ...result,
      assembly: {
        ...result.assembly,
        launcher: {
          ...result.assembly.launcher,
          fitOffsetMm: 0.05,
          finishedAllowanceMm: 0.25,
        },
        topFeatures: {
          ...result.assembly.topFeatures,
          launcherOverlap: {
            clipped: { red: 1, blue: 0 },
            removed: { red: 0, blue: 0 },
          },
        },
      },
    };
    render(<OneClickConverter services={services({
      convert: vi.fn().mockResolvedValue(launcherResult),
    })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'launcher-status.stl'));
    await screen.findByRole('heading', { name: '轉換完成' });

    expect(screen.getByText('官方三爪孔：已加入頂部兩層')).toBeVisible();
    expect(screen.getByText(/模板版本 1/)).toBeVisible();
    expect(screen.getByText(/配合微調 \+0\.05 mm/)).toBeVisible();
    expect(screen.getByText('頂部兩層外框已共同擴大 0.00 mm')).toBeVisible();
    expect(screen.getByText(/已裁切紅色 1/)).toBeVisible();
    expect(screen.getByText('依 Knight Fortress 樣本建立，待官方發射器實物校準')).toBeVisible();
    expect(screen.getByRole('link', { name: '下載三爪尺寸測試片' })).toBeVisible();
  });

  it('preselects acrylic-6 but waits for explicit start and hides custom materials', async () => {
    const user = userEvent.setup();
    const api = services({ materialProfiles: [SOURCE_READY_TEST_MATERIAL] });
    render(<OneClickConverter services={api} />);
    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'defaults.stl'));
    const picker = await screen.findByLabelText('選擇製作材料');
    expect(picker).toHaveValue('acrylic-6');
    expect(within(picker).getAllByRole('option').map((option) => (option as HTMLOptionElement).value))
      .toEqual(['acrylic-6', 'acrylic-3', 'plywood-6', 'plywood-3']);
    expect(api.convert).not.toHaveBeenCalled();
    await user.selectOptions(picker, 'plywood-6');
    expect(api.convert).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(api.convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.objectContaining({ id: 'plywood-6', thicknessMm: 6 }), 0, expect.any(Function));
  });

  it('offers exactly four geometry estimates on a fresh installation', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services({ materialProfiles: [] })} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File(['mesh'], 'fresh-install.stl'),
    );

    const picker = await screen.findByLabelText('選擇製作材料');
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '壓克力（幾何估算） (6 mm)',
      '壓克力（幾何估算） (3 mm)',
      '木（幾何估算） (6 mm)',
      '木（幾何估算） (3 mm)',
    ]);
  });

  it.each([
    ['plywood-3', 3],
    ['plywood-6', 6],
    ['acrylic-3', 3],
    ['acrylic-6', 6],
  ] as const)('passes %s with exact thickness %s into conversion', async (id, thicknessMm) => {
    const user = userEvent.setup();
    const api = services({ materialProfiles: [] });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], `${id}.stl`));
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));

    expect(api.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.objectContaining({ id, thicknessMm }),
      0,
      expect.any(Function),
    );
  });

  it('shows the trustworthy uploaded mesh while material selection remains pending', async () => {
    const user = userEvent.setup();
    const api = services();
    const { container } = render(<OneClickConverter services={api} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([VALID_PRESENTATION_STL], 'trustworthy-preview.stl', { type: 'model/stl' }),
    );

    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
    expect(await screen.findByRole('img', { name: /模型分層預覽/ })).toBeVisible();
    expect(container.querySelector('[data-preview-mesh]')).toBeInTheDocument();
    expect(container.querySelector('.material-presentation-preview')).toBeInTheDocument();
    expect(api.convert).not.toHaveBeenCalled();
  });

  it('keeps a malformed presentation parse neutral and lets the pipeline report its existing error', async () => {
    const user = userEvent.setup();
    const api = services({
      convert: vi.fn().mockRejectedValue(new AutomaticOutlineError('INVALID_STL', 'worker parse failed')),
    });
    const { container } = render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['malformed'], 'malformed.stl'));
    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
    expect(container.querySelector('.material-presentation-preview')).toBeNull();

    await user.selectOptions(screen.getByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('這個檔案不是可讀取的 STL');
    expect(api.convert).toHaveBeenCalledOnce();
  });

  it('clears an old presentation mesh as soon as replacement reading starts', async () => {
    const user = userEvent.setup();
    const replacementRead = deferred<ArrayBuffer>();
    const replacement = new File(['malformed'], 'replacement.stl');
    Object.defineProperty(replacement, 'arrayBuffer', { value: vi.fn(() => replacementRead.promise) });
    const { container } = render(<OneClickConverter services={services()} />);

    await user.upload(
      screen.getByLabelText('選擇 STL 模型'),
      new File([VALID_PRESENTATION_STL], 'old-preview.stl', { type: 'model/stl' }),
    );
    expect(await screen.findByRole('img', { name: /模型分層預覽/ })).toBeVisible();

    await user.upload(screen.getByLabelText('選擇 STL 模型'), replacement);

    expect(container.querySelector('[data-preview-mesh]')).toBeNull();
    expect(screen.getByRole('heading', { name: '正在讀取模型' })).toBeVisible();
    await act(async () => {
      replacementRead.resolve(new TextEncoder().encode('malformed').buffer);
      await replacementRead.promise;
    });
    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
    expect(container.querySelector('.material-presentation-preview')).toBeNull();
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
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));

    expect(api.convert).toHaveBeenCalledWith(replacementBytes, expect.any(Object), 0, expect.any(Function));
  });

  it('only exposes profiles classified ready and never starts from pending or blocked material evidence', async () => {
    const user = userEvent.setup();
    const readyReplacement = {
      ...READY_TEST_MATERIAL,
      id: 'plywood-3',
      materialName: '已校準 3 mm 木夾板',
    };
    const api = services({
      materialProfiles: [
        defaultPendingMaterialProfile('cardboard-2')!,
        BLOCKED_TEST_MATERIAL,
        readyReplacement,
      ],
    });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'ready-only.stl'));
    const picker = await screen.findByLabelText('選擇製作材料');

    expect(screen.queryByRole('option', { name: /pending/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /unknown composition/i })).toBeNull();
    expect(within(picker).getAllByRole('option', { name: /3 mm 木夾板|木夾板.*3 mm/ })).toHaveLength(1);
    expect(screen.getByRole('option', { name: /已校準 3 mm 木夾板/ })).toBeVisible();
    expect(api.convert).not.toHaveBeenCalled();

    await user.selectOptions(picker, readyReplacement.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(api.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer), manufacturingGeometryProfile(readyReplacement), 0, expect.any(Function),
    );
  });

  it('deduplicates every ready stored ID and deterministically selects the last ready profile', async () => {
    const user = userEvent.setup();
    const first = {
      ...READY_TEST_MATERIAL,
      id: 'acrylic-6',
      materialName: 'TEST ONLY first duplicate ready profile',
      thicknessMm: 3.1,
    };
    const last = {
      ...READY_TEST_MATERIAL,
      id: first.id,
      materialName: 'TEST ONLY last duplicate ready profile',
      thicknessMm: 3.2,
    };
    const api = services({ materialProfiles: [first, last] });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'duplicate-ready.stl'));
    const picker = await screen.findByLabelText('選擇製作材料');
    const matchingOptions = within(picker).getAllByRole('option').filter(
      (option) => (option as HTMLOptionElement).value === first.id,
    );

    expect(matchingOptions).toHaveLength(1);
    expect(matchingOptions[0]).toHaveTextContent('TEST ONLY last duplicate ready profile (3.2 mm)');

    await user.selectOptions(picker, first.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(api.convert).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      manufacturingGeometryProfile(last),
      0,
      expect.any(Function),
    );
  });

  it.each([
    ['file input', async (file: File) => userEvent.setup().upload(screen.getByLabelText('選擇 STL 模型'), file)],
    ['drag and drop', async (file: File) => fireEvent.drop(screen.getByText('拖放 STL 到這裏').closest('label')!, {
      dataTransfer: { files: [file] },
    })],
  ])('rejects a non-STL filename case-insensitively before read or material selection via %s', async (_label, submit) => {
    const api = services();
    const file = new File(['private'], 'private-model.obj', { type: 'model/stl' });
    const read = vi.fn().mockResolvedValue(new ArrayBuffer(4));
    Object.defineProperty(file, 'arrayBuffer', { value: read });
    render(<OneClickConverter services={api} />);

    await submit(file);

    expect(await screen.findByRole('alert')).toHaveTextContent('只支援 STL 檔案');
    expect(screen.queryByLabelText('選擇製作材料')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(api.convert).not.toHaveBeenCalled();
  });

  it('accepts an uppercase .STL filename and reaches the ready-material chooser', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services()} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File(['mesh'], 'MODEL.STL'));

    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
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

  it('cancels active processing and returns to the material chooser without a failure alert', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    const cancel = vi.fn();
    const api = services({ convert: vi.fn().mockReturnValue(conversion.promise), cancel });
    render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'cancel-me.stl'));
    cancel.mockClear();
    await user.click(screen.getByRole('button', { name: '取消處理' }));

    expect(cancel).toHaveBeenCalledOnce();
    expect(await screen.findByLabelText('選擇製作材料')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    conversion.resolve(result);
  });

  it('starts a fresh monotonic elapsed timer when cancelled processing is retried', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
    const conversions = [deferred<AutomaticOutlineResult>(), deferred<AutomaticOutlineResult>()];
    const reports: Array<((event: AutomaticOutlineProgressEvent) => void) | undefined> = [];
    const api = services({
      convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
        reports.push(onProgress);
        return conversions[reports.length - 1].promise;
      }),
    });
    const file = new File(['mesh'], 'retry-timer.stl');
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    render(<OneClickConverter services={api} />);

    try {
      await act(async () => {
        fireEvent.change(screen.getByLabelText('選擇 STL 模型'), {
          target: { files: [file] },
        });
        await Promise.resolve();
      });
      fireEvent.change(screen.getByLabelText('選擇製作材料'), {
        target: { value: READY_TEST_MATERIAL.id },
      });
      fireEvent.click(screen.getByRole('button', { name: '開始製作' }));
      fireEvent.click(screen.getByRole('button', { name: '取消處理' }));

      act(() => vi.advanceTimersByTime(20_000));
      fireEvent.change(screen.getByLabelText('選擇製作材料'), {
        target: { value: READY_TEST_MATERIAL.id },
      });
      fireEvent.click(screen.getByRole('button', { name: '開始製作' }));
      expect(screen.getByText('已處理 00:00')).toBeVisible();

      act(() => vi.advanceTimersByTime(5_000));
      act(() => reports[1]?.({ stage: 'analyzing' }));
      expect(screen.getByText('已處理 00:05')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the saved material after cancelling canonical regeneration', async () => {
    const user = userEvent.setup();
    const bytes = new TextEncoder().encode('saved cancellation mesh');
    const conversion = deferred<AutomaticOutlineResult>();
    const savedMaterial = manufacturingGeometryProfile(SOURCE_READY_TEST_MATERIAL);
    const savedProject = {
      schemaVersion: 3 as const,
      id: 'one-click-current' as const,
      updatedAt: '2026-08-03T00:00:00.000Z',
      sourceSha256: await sha256Hex(bytes),
      material: savedMaterial,
      launcherFitOffsetMm: 0,
      launcherTemplateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
      launcherTemplateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
      launcherExteriorExpansion: result.assembly.launcher.exteriorExpansion,
      decorationOmissions: result.assembly.decorationOmissions,
      canonicalSourceHash: result.sourceHash,
      status: 'regeneration-required' as const,
    };
    const api = services({
      savedProject,
      convert: vi.fn().mockReturnValue(conversion.promise),
    });
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), new File([bytes], 'saved-cancel.stl'));
    expect(screen.getByRole('option', { name: `${savedMaterial.name} (${savedMaterial.thicknessMm} mm)` })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: '重新產生正式輸出' }));
    expect(api.convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), savedMaterial, 0, expect.any(Function));
    await user.click(screen.getByRole('button', { name: '取消處理' }));

    expect(screen.getByLabelText('選擇製作材料')).toBeDisabled();
    expect(screen.getByLabelText('選擇製作材料')).toHaveValue(savedMaterial.id);
    conversion.resolve(result);
  });

  it('cancels a deferred replacement read back to the retained material selection and ignores late bytes', async () => {
    const user = userEvent.setup();
    const replacementRead = deferred<ArrayBuffer>();
    const selectedBytes = new ArrayBuffer(3);
    const replacementBytes = new ArrayBuffer(4);
    const selected = new File(['old'], 'selected.stl');
    const replacement = new File(['replacement'], 'replacement.stl');
    Object.defineProperty(selected, 'arrayBuffer', { value: vi.fn().mockResolvedValue(selectedBytes) });
    Object.defineProperty(replacement, 'arrayBuffer', { value: vi.fn(() => replacementRead.promise) });
    const api = services();
    render(<OneClickConverter services={api} />);

    await user.upload(screen.getByLabelText('選擇 STL 模型'), selected);
    expect(await screen.findByRole('heading', { name: 'selected.stl' })).toBeVisible();
    await user.upload(screen.getByLabelText('選擇 STL 模型'), replacement);
    expect(screen.getByRole('heading', { name: '正在讀取模型' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '取消處理' }));

    expect(await screen.findByRole('heading', { name: 'selected.stl' })).toBeVisible();
    expect(screen.getByLabelText('選擇製作材料')).toBeVisible();
    await act(async () => {
      replacementRead.resolve(replacementBytes);
      await replacementRead.promise;
    });
    expect(screen.getByRole('heading', { name: 'selected.stl' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'replacement.stl' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('選擇製作材料'), READY_TEST_MATERIAL.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(api.convert).toHaveBeenCalledWith(selectedBytes, expect.any(Object), 0, expect.any(Function));
  });

  it('keeps pre-geometry progress neutral, then announces monotonic stages through the preview status', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => { report = onProgress; return conversion.promise; }) });
    const { container } = render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'busy.stl'));
    expect(screen.getByRole('heading', { name: '正在讀取模型' })).toBeVisible();
    expect(container.querySelector('.processing-loading-panel')).not.toHaveAttribute('role');
    expect(container.querySelector('.processing-loading-panel')).not.toHaveAttribute('aria-live');
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(2);
    expect(container.querySelector('.processing-status-overlay')).toBeNull();
    report?.({ stage: 'simplifying' });
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: '正在讀取模型' })).toBeVisible());
    expect(container.querySelector('.processing-status-overlay')).toBeNull();
    report?.({ stage: 'reading' });
    await vi.waitFor(() => expect(container.querySelector('.processing-status-overlay')).toBeNull());
    report?.({ stage: 'slicing', preview: result.preview });
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: '正在產生切片' })).toBeVisible());
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(2);
    report?.({ stage: 'analyzing', preview: result.preview });
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: '正在產生切片' })).toBeVisible());
    report?.({ stage: 'packaging' });
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: '正在準備下載' })).toBeVisible());
  });

  it('stays neutral until parsed preview data arrives, then uses the real viewport through packaging', async () => {
    const user = userEvent.setup();
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const api = services({ convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => { report = onProgress; return conversion.promise; }) });
    const { container } = render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'preview.stl'));
    expect(container.querySelector('.processing-card')).not.toHaveClass('has-preview');
    const loadingPanel = container.querySelector('.processing-loading-panel');
    expect(loadingPanel).toBeInTheDocument();
    expect(container.querySelector('.processing-status-overlay')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /模型分層預覽/ })).toBeNull();
    expect(container.querySelector('.spinner')).toBeNull();

    report?.({ stage: 'analyzing', preview: result.preview });
    const preview = await screen.findByRole('img', { name: /模型分層預覽/ });
    expect(container.querySelector('.processing-card')).toHaveClass('has-preview');
    expect(container.querySelector('.processing-status-overlay')).toBeInTheDocument();
    expect(container.querySelector('.processing-loading-panel')).toBe(loadingPanel);
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
      convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
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

  it('shows the simplified warning, primary real viewport, five colored artifacts, and launcher coupon', async () => {
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

  it('does not gate a ready download while completion feedback is materialized', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services()} />);
    await uploadAndSelectMaterial(user, new File(['mesh'], 'ready-download.stl'));

    const link = await screen.findByRole('link', { name: '下載 ZIP 製作套件' });
    fireEvent.pointerDown(link, { pointerId: 1 });
    expect(link).toHaveAttribute('data-pressed', 'true');
    expect(link).toHaveAttribute('href', 'blob:zip');
    expect(link).toHaveAttribute('download', 'shapecut-files.zip');
    expect(link).not.toHaveAttribute('aria-disabled', 'true');

    let componentPreventedClick: boolean | undefined;
    const observeClick = (event: MouseEvent) => {
      componentPreventedClick = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', observeClick, { once: true });
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener('click', observeClick);
    }
    expect(componentPreventedClick).toBe(false);
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
    expect(details).toHaveTextContent('cut-and-engrave.svg、cut-and-engrave.dxf、preview.pdf、exploded-view.pdf、launcher-fit-coupon.svg、project.json 及 manifest.json 七項檔案');
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
    expect(screen.getByRole('heading', { name: '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片' })).toBeVisible();
  });

  it('maps an incompatible fixed launcher to a blocking Traditional Chinese failure', async () => {
    const user = userEvent.setup();
    const api = services({
      convert: vi.fn().mockRejectedValue(new AutomaticOutlineError(
        'LAUNCHER_INCOMPATIBLE',
        'internal launcher geometry details',
      )),
    });
    render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'launcher-blocked.stl'));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('官方三爪孔會破壞外框或必要承托結構，已停止所有輸出。');
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
    expect(api.package).not.toHaveBeenCalled();
  });

  it('maps an over-limit launcher exterior expansion to a blocking Traditional Chinese failure', async () => {
    const user = userEvent.setup();
    const api = services({
      convert: vi.fn().mockRejectedValue(new AutomaticOutlineError(
        'LAUNCHER_EXTERIOR_EXPANSION_EXCEEDED',
        'Launcher exterior expansion requires 6.01 mm, exceeding 6.00 mm',
      )),
    });
    render(<OneClickConverter services={api} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'launcher-expansion-blocked.stl'));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('頂部兩層外框需要擴大超過 6.00 mm，已停止所有輸出。');
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
    expect(api.package).not.toHaveBeenCalled();
  });

  it('fails closed without partial links when the launcher coupon URL cannot be prepared', async () => {
    const user = userEvent.setup();
    render(<OneClickConverter services={services({
      package: vi.fn().mockRejectedValue(new OutlineArtifactError('launcher-fit-coupon.svg')),
    })} />);

    await uploadAndSelectMaterial(user, new File(['mesh'], 'coupon-url-failure.stl'));

    expect(await screen.findByRole('alert')).toHaveTextContent('launcher-fit-coupon.svg');
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();
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
    expect(document.querySelector('.failure-card .outline-process-viewport')).toHaveAttribute('data-effect-level', 'static');
    expect(document.querySelector('.failure-retained-preview')).toHaveAttribute('data-settled', 'true');
    expect(screen.getByRole('region', { name: '模型處理提示' })).toHaveTextContent('所有切片未偵測到可靠中央孔');
    expect(screen.queryByRole('link', { name: /下載/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '選擇另一個模型' }));
    expect(screen.getByRole('heading', { name: '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片' })).toBeVisible();
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
    expect(revoke).toHaveBeenCalledTimes(6);
    unmount();
    expect(revoke).toHaveBeenCalledTimes(12);
  });
});
