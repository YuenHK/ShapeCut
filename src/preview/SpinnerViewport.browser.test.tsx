import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BufferGeometry, Material } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { MeshProblemReport } from '../domain/mesh/types';
import { createSceneController, type SceneController } from './scene-controller';
import { SpinnerViewport } from './SpinnerViewport';

function fakeController(): SceneController {
  return {
    setMesh: vi.fn(),
    setParts: vi.fn(),
    setExploded: vi.fn(),
    setEngraving: vi.fn(),
    setMeshProblems: vi.fn(),
    selectPart: vi.fn(),
    focusRegion: vi.fn(),
    dispose: vi.fn(),
  };
}

const thinWallIssue = {
  id: 'thin-wall-1',
  regionId: 'rib-edge-4',
  severity: 'blocking' as const,
  label: '薄壁區域',
  description: '剩餘材料厚度低於安全下限。',
};

const report: MeshProblemReport = {
  inspection: {
    triangleCount: 4,
    boundaryEdgeCount: 1,
    nonManifoldEdgeCount: 1,
    degenerateTriangleCount: 1,
    invertedVolume: false,
  },
  duplicateTriangleCount: 1,
  boundaryEdges: [{ regionId: 'mesh-boundary-edge-0', points: [[0, 0, 0], [1, 0, 0]] }],
  nonManifoldEdges: [{ regionId: 'mesh-non-manifold-edge-0', points: [[0, 0, 0], [0, 1, 0]] }],
  degenerateTriangles: [{ regionId: 'mesh-degenerate-triangle-0', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }],
  duplicateTriangles: [{ regionId: 'mesh-duplicate-triangle-0', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }],
  markersTruncated: {
    boundaryEdges: false,
    nonManifoldEdges: false,
    degenerateTriangles: false,
    duplicateTriangles: false,
  },
};

const truncatedReport: MeshProblemReport = {
  ...report,
  inspection: { ...report.inspection, boundaryEdgeCount: 2_001 },
  markersTruncated: { ...report.markersTruncated, boundaryEdges: true },
};

function issuesFromReport(meshProblems: MeshProblemReport) {
  return meshProblems.nonManifoldEdges.map((marker, index) => ({
    id: `non-manifold-${index}`,
    regionId: marker.regionId,
    severity: 'blocking' as const,
    label: '非流形邊',
    description: '此邊連接超過兩個面。',
  }));
}

describe('SpinnerViewport', () => {
  it('sends problem geometry to the scene and focuses its stable region id', async () => {
    const controller = fakeController();
    render(<SpinnerViewport meshProblems={report} issues={issuesFromReport(report)} createController={() => controller} />);

    expect(controller.setMeshProblems).toHaveBeenCalledWith(report);
    await userEvent.click(screen.getByRole('button', { name: /非流形邊/i }));
    expect(controller.focusRegion).toHaveBeenCalledWith('mesh-non-manifold-edge-0');
  });

  it('announces when marker geometry is truncated', () => {
    render(<SpinnerViewport meshProblems={truncatedReport} issues={[]} createController={() => fakeController()} />);

    expect(screen.getByText(/只顯示首 2,000 個/)).toBeVisible();
  });

  it('disposes every problem overlay geometry and material on update and unmount', () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const host = document.createElement('div');
    document.body.append(host);
    const controller = createSceneController(host);
    try {
      geometryDispose.mockClear();
      materialDispose.mockClear();

      controller.setMeshProblems(report);
      controller.setMeshProblems(undefined);
      expect(geometryDispose).toHaveBeenCalledTimes(4);
      expect(materialDispose).toHaveBeenCalledTimes(4);

      controller.setMeshProblems(report);
      controller.dispose();
      expect(geometryDispose).toHaveBeenCalledTimes(8);
      expect(materialDispose).toHaveBeenCalledTimes(8);
    } finally {
      controller.dispose();
      host.remove();
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
    }
  });

  it('creates and removes the real WebGL canvas', () => {
    const view = render(<SpinnerViewport issues={[]} />);
    expect(view.container.querySelector('canvas')).toBeInTheDocument();

    view.unmount();

    expect(view.container.querySelector('canvas')).not.toBeInTheDocument();
  });

  it('releases the real WebGL canvas across 20 mount cycles', () => {
    for (let index = 0; index < 20; index += 1) {
      const view = render(<SpinnerViewport meshProblems={report} issues={[]} />);
      expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
      view.unmount();
      expect(view.container.querySelectorAll('canvas')).toHaveLength(0);
    }
  });

  it('focuses the referenced geometry issue', async () => {
    const controller = fakeController();
    render(<SpinnerViewport issues={[thinWallIssue]} createController={() => controller} />);

    await userEvent.click(screen.getByRole('button', { name: /薄壁區域/i }));

    expect(controller.focusRegion).toHaveBeenCalledWith(thinWallIssue.regionId);
  });

  it('updates exploded transforms from an accessible range control', async () => {
    const controller = fakeController();
    render(<SpinnerViewport issues={[]} createController={() => controller} />);

    const slider = screen.getByRole('slider', { name: '爆炸圖距離' });
    fireEvent.change(slider, { target: { value: '0.2' } });

    expect(controller.setExploded).toHaveBeenLastCalledWith(0.2);
  });

  it('disposes every scene controller across 20 mount cycles', () => {
    const controllers: SceneController[] = [];
    for (let index = 0; index < 20; index += 1) {
      const controller = fakeController();
      controllers.push(controller);
      const view = render(<SpinnerViewport issues={[]} createController={() => controller} />);
      view.unmount();
    }

    for (const controller of controllers) expect(controller.dispose).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-spinner-viewport]')).toHaveLength(0);
  });
});
