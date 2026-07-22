import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page } from '@vitest/browser/context';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineProgressEvent, AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, type ColoredOutlineLayer } from '../domain/outline-features/types';
import { manufacturingGeometryProfile } from '../domain/materials/manufacturing-profile';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import '../styles.css';
import { App } from './App';
import type { OneClickConverterServices } from './OneClickConverter';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe('App real browser one-click flow', () => {
  it('starts from one keyboard-accessible selection and renders the result downloads', async () => {
    await page.viewport(1024, 768);
    const user = userEvent.setup();
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
      material: manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!),
      assembly: {
        material: manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!),
        launcher: { status: 'omitted', cutCount: 0 },
        fastener: { count: 0, centers: [], finishedDiameterMm: 3, pathDiameterMm: 2.85 },
        topFeatures: { retained: { red: 0, blue: 0 }, omitted: { red: 0, blue: 0 } },
      },
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
        sourceHash: 'c'.repeat(32), mode: 'exact', coloredLayers: [coloredLayer],
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
      convert: vi.fn((_bytes, _material, onProgress) => {
        report = onProgress;
        return conversion.promise;
      }),
      package: vi.fn().mockResolvedValue({
        zip: { href: 'blob:zip', fileName: 'shapecut-files.zip' },
        svg: { href: 'blob:svg', fileName: 'cut-and-engrave.svg' },
        dxf: { href: 'blob:dxf', fileName: 'cut-and-engrave.dxf' },
        previewPdf: { href: 'blob:preview', fileName: 'preview.pdf' },
        explodedPdf: { href: 'blob:exploded', fileName: 'exploded-view.pdf' },
      }),
    };
    render(<App services={services} />);

    const input = screen.getByLabelText('選擇 STL 模型');
    input.focus();
    await user.upload(input, new File(['mesh'], 'keyboard.stl', { type: 'model/stl' }));
    const material = manufacturingGeometryProfile(defaultPendingMaterialProfile('plywood-3')!);

    expect(services.convert).not.toHaveBeenCalled();
    await user.selectOptions(await screen.findByLabelText('選擇製作材料'), material.id);
    expect(services.convert).toHaveBeenCalledWith(expect.any(ArrayBuffer), material, expect.any(Function));

    expect(document.querySelector('.processing-loading-panel')).toBeInTheDocument();
    expect(document.querySelector('.processing-status-overlay')).not.toBeInTheDocument();
    report?.({ stage: 'analyzing', preview: result.preview });
    const processingPreview = await screen.findByRole('img', { name: /模型分層預覽/ });
    const card = document.querySelector<HTMLElement>('.processing-card.has-preview');
    const overlay = document.querySelector<HTMLElement>('.processing-status-overlay');
    expect(card && overlay).toBeTruthy();
    const cardBox = card!.getBoundingClientRect();
    const overlayBox = overlay!.getBoundingClientRect();
    expect(overlayBox.x).toBeLessThan(cardBox.x + cardBox.width / 2);
    expect(overlayBox.y).toBeLessThan(cardBox.y + cardBox.height / 2);
    expect(overlayBox.width * overlayBox.height).toBeLessThan(cardBox.width * cardBox.height * 0.35);
    expect(getComputedStyle(processingPreview).cursor).toBe('auto');

    await page.viewport(390, 844);
    await vi.waitFor(() => expect(window.matchMedia('(max-width: 640px)').matches).toBe(true));
    const mobileCard = document.querySelector<HTMLElement>('.processing-card.has-preview');
    const mobileOverlay = document.querySelector<HTMLElement>('.processing-status-overlay');
    expect(mobileCard && mobileOverlay).toBeTruthy();
    const mobileCardBox = mobileCard!.getBoundingClientRect();
    const mobileOverlayBox = mobileOverlay!.getBoundingClientRect();
    expect(getComputedStyle(mobileOverlay!).top).toBe('10px');
    expect(getComputedStyle(mobileOverlay!).left).toBe('10px');
    expect(mobileOverlayBox.width).toBeCloseTo(mobileCardBox.width - 22, 0);
    expect(mobileOverlayBox.width * mobileOverlayBox.height).toBeLessThan(mobileCardBox.width * mobileCardBox.height * 0.35);
    const changeFile = document.querySelector<HTMLElement>('.processing-card > .change-file-button');
    expect(changeFile).toBeVisible();
    expect(getComputedStyle(changeFile!).zIndex).toBe('3');
    await page.viewport(1024, 768);

    conversion.resolve(result);

    expect(await screen.findByRole('link', { name: '下載 ZIP 製作套件' })).toHaveAttribute('download', 'shapecut-files.zip');
    expect(screen.getByRole('link', { name: /爆炸圖 PDF/ })).toHaveAttribute('download', 'exploded-view.pdf');
    expect(screen.getAllByRole('link', { name: /下載/ })).toHaveLength(5);
    const technicalSummary = screen.getByText('技術資料');
    technicalSummary.focus();
    await user.keyboard('{Enter}');
    expect(technicalSummary.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('img', { name: /模型分層預覽/ })).toHaveAttribute('data-layer-count', '1');
    expect(services.convert).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /修復|軸心|下一步|材料|分件/ })).toBeNull();
  });
});
