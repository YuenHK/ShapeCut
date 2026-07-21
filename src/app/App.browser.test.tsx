import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineResult } from '../domain/pipeline/automatic-outline-pipeline';
import { featureEvidenceFingerprint, type ColoredOutlineLayer } from '../domain/outline-features/types';
import { App } from './App';
import type { OneClickConverterServices } from './OneClickConverter';

describe('App real browser one-click flow', () => {
  it('starts from one keyboard-accessible selection and renders the result downloads', async () => {
    const user = userEvent.setup();
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
      sourceHash: 'c'.repeat(32), mode: 'exact', status: 'success', warnings: [], layers: [{
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
      }),
      preview: {
        mesh: {
          positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 5, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
        axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
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
    const services: OneClickConverterServices = {
      cancel: vi.fn(),
      convert: vi.fn().mockResolvedValue(result),
      package: vi.fn().mockResolvedValue({
        zip: { href: 'blob:zip', fileName: 'shape.zip' }, svg: { href: 'blob:svg', fileName: 'shape.svg' },
        dxf: { href: 'blob:dxf', fileName: 'shape.dxf' }, pdf: { href: 'blob:pdf', fileName: 'shape.pdf' },
        json: { href: 'blob:json', fileName: 'shape.json' },
      }),
    };
    render(<App services={services} />);

    const input = screen.getByLabelText('選擇 STL 模型');
    input.focus();
    await user.upload(input, new File(['mesh'], 'keyboard.stl', { type: 'model/stl' }));

    expect(await screen.findByRole('link', { name: '下載 ZIP 製作套件' })).toBeVisible();
    const technicalSummary = screen.getByText('技術資料');
    technicalSummary.focus();
    await user.keyboard('{Enter}');
    expect(technicalSummary.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('img', { name: '實際外形切片預覽' })).toHaveAttribute('viewBox', '0 0 10 5');
    expect(services.convert).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /修復|軸心|下一步|材料|分件/ })).toBeNull();
  });
});
