import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineProgressEvent, AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, type ColoredOutlineLayer } from '../domain/outline-features/types';
import { manufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { READY_TEST_MATERIAL as SOURCE_READY_TEST_MATERIAL } from '../test/ready-material';
import {
  OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
  OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
} from '../domain/outline-assembly/launcher-template';
import '../styles.css';
import { App } from './App';
import type { OneClickConverterServices } from './OneClickConverter';
import { sampleModelUrl } from './sample-models';

const READY_TEST_MATERIAL = { ...SOURCE_READY_TEST_MATERIAL, id: 'plywood-3' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe('App real browser one-click flow', () => {
  it('starts from one keyboard-accessible selection and renders the result downloads', async () => {
    await page.viewport(1024, 768);
    const user = userEvent.setup();
    const material = manufacturingGeometryProfile(READY_TEST_MATERIAL);
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
    const result: AutomaticOutlineResult = {
      sourceHash: 'c'.repeat(32), mode: 'exact', status: 'success', warnings: [],
      material,
      assembly: {
        material,
        launcher: {
          status: 'fixed', cutCount: 3,
          templateVersion: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
          templateFingerprint: OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT,
          rotationRad: 0, fitOffsetMm: 0, finishedAllowanceMm: 0.2,
          exteriorExpansion: {
            mode: 'shared-uniform', offsetMm: 0, maxOffsetMm: 6,
            affectedLayerIds: ['layer-0', 'layer-0'],
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
        sourceHash: 'c'.repeat(32), status: 'success', mode: 'exact',
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
      axis: {
        source: 'candidate',
        axis: { origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: true },
      },
      originalReport: {
        inspection: {
          triangleCount: 12,
          boundaryEdgeCount: 0,
          nonManifoldEdgeCount: 0,
          degenerateTriangleCount: 0,
          invertedVolume: false,
        },
        duplicateTriangleCount: 0,
        inconsistentWindingEdgeCount: 0,
        selfIntersectionCount: 0,
        selfIntersectionAnalysisComplete: true,
        boundaryEdges: [],
        nonManifoldEdges: [],
        degenerateTriangles: [],
        duplicateTriangles: [],
        inconsistentWindingEdges: [],
        selfIntersections: [],
        markersTruncated: {
          boundaryEdges: false,
          nonManifoldEdges: false,
          degenerateTriangles: false,
          duplicateTriangles: false,
          inconsistentWindingEdges: false,
          selfIntersections: false,
        },
      },
      repairAccepted: true,
      removedComponentCount: 0,
      removalEvidenceFingerprint: '0'.repeat(32),
      diagnostics: { topology: { triangleCount: 12, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, duplicateTriangleCount: 0, inconsistentWindingEdgeCount: 0, selfIntersectionCount: 0, selfIntersectionAnalysisComplete: true }, repairDecision: 'accepted', rasterCellSizeMm: null, layers: [{ id: 'layer-0', simplificationToleranceMm: 0.01, boundsDriftRatio: 0, areaDriftRatio: 0, areaEvidenceBasis: 'exact-slice-pre-simplification' }] },
    };
    const conversion = deferred<AutomaticOutlineResult>();
    let report: ((event: AutomaticOutlineProgressEvent) => void) | undefined;
    const services: OneClickConverterServices = {
      materialProfiles: [READY_TEST_MATERIAL],
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
      convert: vi.fn((_bytes, _material, _launcherFitOffsetMm, onProgress) => {
        report = onProgress;
        return conversion.promise;
      }),
      package: vi.fn().mockResolvedValue({
        zip: { href: 'blob:zip', fileName: 'shapecut-files.zip' },
        svg: { href: 'blob:svg', fileName: 'cut-and-engrave.svg' },
        dxf: { href: 'blob:dxf', fileName: 'cut-and-engrave.dxf' },
        previewPdf: { href: 'blob:preview', fileName: 'preview.pdf' },
        explodedPdf: { href: 'blob:exploded', fileName: 'exploded-view.pdf' },
        launcherCoupon: { href: 'blob:launcher-coupon', fileName: 'launcher-fit-coupon.svg' },
      }),
    };
    const storedProfile = {
      ...READY_TEST_MATERIAL,
      id: 'browser-catalog-ready',
      materialName: 'TEST ONLY browser catalog ready',
    };
    const catalog = deferred<(typeof storedProfile)[]>();
    const materialRepository = {
      list: vi.fn(() => catalog.promise),
      get: vi.fn(),
      importJson: vi.fn(),
    };
    const projectRepository = {
      load: vi.fn().mockResolvedValue(undefined),
      save: vi.fn(),
      delete: vi.fn(),
    };
    render(
      <App
        services={services}
        materialRepository={materialRepository}
        oneClickProjectRepository={projectRepository}
      />,
    );

    const sampleRegion = await screen.findByRole('region', { name: '範例模型' });
    const sample1 = screen.getByRole('link', { name: '下載 sample1' });
    const sample2 = screen.getByRole('link', { name: '下載 sample2' });
    expect(sampleRegion).toBeVisible();
    expect(sample1).toBeVisible();
    expect(sample2).toBeVisible();
    expect(sampleModelUrl('sample1.stl', '/ShapeCut/')).toBe('/ShapeCut/samples/sample1.stl');
    sample1.focus();
    expect(sample1).toHaveFocus();
    await user.tab();
    expect(sample2).toHaveFocus();

    const input = await screen.findByLabelText('選擇 STL 模型');
    input.focus();
    await user.upload(input, new File(['mesh'], 'keyboard.stl', { type: 'model/stl' }));
    expect(services.convert).not.toHaveBeenCalled();
    const materialSelect = await screen.findByLabelText('選擇製作材料');
    await user.selectOptions(materialSelect, material.id);
    await user.click(screen.getByRole('button', { name: '開始製作' }));
    expect(services.convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), material, 0, expect.any(Function));

    expect(document.querySelector('.processing-loading-panel')).toBeInTheDocument();
    expect(document.querySelector('.processing-status-overlay')).not.toBeInTheDocument();
    report?.({ stage: 'analyzing', preview: result.preview });
    const processingPreview = await screen.findByRole('img', { name: /模型分層預覽/ });
    const card = document.querySelector<HTMLElement>('.processing-card.has-preview');
    const overlay = document.querySelector<HTMLElement>('.processing-status-overlay');
    const viewport = document.querySelector<HTMLElement>('.processing-viewport');
    expect(card && overlay && viewport).toBeTruthy();
    const cardBox = card!.getBoundingClientRect();
    const overlayBox = overlay!.getBoundingClientRect();
    const viewportBox = viewport!.getBoundingClientRect();
    expect(viewportBox.width).toBeGreaterThan(overlayBox.width * 1.5);
    expect(viewportBox.right).toBeLessThan(overlayBox.left);
    expect(overlayBox.x + overlayBox.width / 2).toBeGreaterThan(cardBox.x + cardBox.width / 2);
    expect(overlayBox.top).toBeGreaterThan(cardBox.top);
    expect(overlayBox.bottom).toBeLessThan(cardBox.bottom);
    expect(overlayBox.width * overlayBox.height).toBeLessThan(cardBox.width * cardBox.height * 0.8);
    const orbitBox = document.querySelector<HTMLElement>('.processing-orbit')!.getBoundingClientRect();
    const orbitContents = [
      document.querySelector<HTMLElement>('.processing-message h1')!,
      document.querySelector<HTMLElement>('.processing-message .file-name')!,
      document.querySelector<HTMLElement>('.processing-elapsed')!,
      document.querySelector<HTMLElement>('.processing-cancel-button')!,
    ];
    for (const element of orbitContents) {
      const box = element.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(orbitBox.left + 12);
      expect(box.right).toBeLessThanOrEqual(orbitBox.right - 12);
      expect(box.top).toBeGreaterThanOrEqual(orbitBox.top + 12);
      expect(box.bottom).toBeLessThanOrEqual(orbitBox.bottom - 12);
    }
    expect(getComputedStyle(processingPreview).cursor).toBe('auto');
    await page.screenshot({ path: '../../.superpowers/workbench-processing-1024.png' });

    await page.viewport(390, 844);
    await vi.waitFor(() => expect(window.matchMedia('(max-width: 640px)').matches).toBe(true));
    const mobileCard = document.querySelector<HTMLElement>('.processing-card.has-preview');
    const mobileOverlay = document.querySelector<HTMLElement>('.processing-status-overlay');
    expect(mobileCard && mobileOverlay).toBeTruthy();
    await vi.waitFor(() => {
      const mobileCardBox = mobileCard!.getBoundingClientRect();
      const mobileOverlayBox = mobileOverlay!.getBoundingClientRect();
      expect(mobileOverlayBox.x + mobileOverlayBox.width / 2).toBeCloseTo(mobileCardBox.x + mobileCardBox.width / 2, 0);
      expect(mobileOverlayBox.y + mobileOverlayBox.height / 2).toBeCloseTo(mobileCardBox.y + mobileCardBox.height / 2, 0);
    });
    const mobileCardBox = mobileCard!.getBoundingClientRect();
    const mobileOverlayBox = mobileOverlay!.getBoundingClientRect();
    expect(mobileOverlayBox.width * mobileOverlayBox.height).toBeLessThan(mobileCardBox.width * mobileCardBox.height * 0.8);
    const changeFile = document.querySelector<HTMLElement>('.processing-card > .change-file-button');
    expect(changeFile).toBeVisible();
    expect(getComputedStyle(changeFile!).zIndex).toBe('3');
    expect(changeFile!.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await page.viewport(1024, 768);

    await act(async () => {
      catalog.resolve([storedProfile]);
      await catalog.promise;
    });
    conversion.resolve(result);

    expect(await screen.findByRole(
      'link', { name: '下載 ZIP 製作套件' }, { timeout: 10_000 },
    )).toHaveAttribute('download', 'shapecut-files.zip');
    expect(screen.getByRole('link', { name: /爆炸圖 PDF/ })).toHaveAttribute('download', 'exploded-view.pdf');
    expect(screen.getAllByRole('link', { name: /下載/ })).toHaveLength(6);
    const technicalSummary = screen.getByRole('tab', { name: '技術資料' });
    expect(technicalSummary).toHaveAttribute('aria-selected', 'false');
    technicalSummary.focus();
    await user.keyboard('{Enter}');
    expect(technicalSummary).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('模式');
    expect(screen.getByRole('img', { name: /模型分層預覽/ })).toHaveAttribute('data-layer-count', '1');
    expect(services.convert).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /修復|軸心|下一步|材料|分件/ })).toBeNull();
  });
});
