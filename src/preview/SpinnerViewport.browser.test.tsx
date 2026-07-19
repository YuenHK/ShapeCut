import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BufferGeometry, Material } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { describe, expect, it, vi } from 'vitest';
import type { SpinnerKit } from '../domain/decomposition/types';
import type { EngravingMap } from '../domain/engraving/height-field';
import type { MeshProblemReport, TriangleMesh } from '../domain/mesh/types';
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

const sharedBoundaryMaterialReport: MeshProblemReport = {
  ...report,
  inspection: {
    ...report.inspection,
    boundaryEdgeCount: 2,
    nonManifoldEdgeCount: 0,
    degenerateTriangleCount: 0,
  },
  duplicateTriangleCount: 0,
  boundaryEdges: [
    report.boundaryEdges[0],
    { regionId: 'mesh-boundary-edge-1', points: [[0, 1, 0], [1, 1, 0]] },
  ],
  nonManifoldEdges: [],
  degenerateTriangles: [],
  duplicateTriangles: [],
};

const mesh: TriangleMesh = {
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

const parts: SpinnerKit = {
  parts: [],
  instances: [],
  joints: [],
  assembly: [],
  estimatedBalance: {
    kind: 'ideal-static-estimate',
    status: 'pass',
    centroidOffsetMm: 0,
    angularMassError: 0,
    assumptions: [],
  },
};

const engraving: EngravingMap = {
  levels: 3,
  regions: [],
  center: [0, 0],
  depthMode: 'relative',
  levelDepths: [0, 0.1, 0.2, 0.3],
  assumptions: [],
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
  it('rehydrates a replacement controller with every current scene value', () => {
    const first = fakeController();
    const second = fakeController();
    const firstFactory = () => first;
    const secondFactory = () => second;
    const view = render(
      <SpinnerViewport
        mesh={mesh}
        parts={parts}
        engraving={engraving}
        meshProblems={report}
        issues={[]}
        createController={firstFactory}
      />,
    );
    fireEvent.change(screen.getByRole('slider', { name: '爆炸圖距離' }), { target: { value: '0.2' } });

    view.rerender(
      <SpinnerViewport
        mesh={mesh}
        parts={parts}
        engraving={engraving}
        meshProblems={report}
        issues={[]}
        createController={secondFactory}
      />,
    );

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.setMesh).toHaveBeenCalledWith(mesh);
    expect(second.setParts).toHaveBeenCalledWith(parts);
    expect(second.setEngraving).toHaveBeenCalledWith(engraving);
    expect(second.setMeshProblems).toHaveBeenCalledWith(report);
    expect(second.setExploded).toHaveBeenCalledWith(0.2);
  });

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

  it('disposes each marker geometry but a shared category material only once', () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const host = document.createElement('div');
    document.body.append(host);
    const controller = createSceneController(host);
    try {
      geometryDispose.mockClear();
      materialDispose.mockClear();

      controller.setMeshProblems(sharedBoundaryMaterialReport);
      controller.setMeshProblems(undefined);

      expect(geometryDispose).toHaveBeenCalledTimes(2);
      expect(materialDispose).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
      host.remove();
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
    }
  });

  it('finds a real problem overlay and runs its focus framing', () => {
    const controlsUpdate = vi.spyOn(OrbitControls.prototype, 'update');
    const host = document.createElement('div');
    document.body.append(host);
    const controller = createSceneController(host);
    try {
      controller.setMeshProblems(report);
      controlsUpdate.mockClear();

      controller.focusRegion('mesh-non-manifold-edge-0');

      expect(controlsUpdate).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
      host.remove();
      controlsUpdate.mockRestore();
    }
  });

  it('creates and removes the real WebGL canvas', () => {
    const view = render(<SpinnerViewport issues={[]} />);
    expect(view.container.querySelector('canvas')).toBeInTheDocument();

    view.unmount();

    expect(view.container.querySelector('canvas')).not.toBeInTheDocument();
  });

  it('releases the real WebGL canvas across 20 mount cycles', () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    try {
      for (let index = 0; index < 20; index += 1) {
        const view = render(<SpinnerViewport meshProblems={report} issues={[]} />);
        expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
        const geometryCallsBeforeUnmount = geometryDispose.mock.calls.length;
        const materialCallsBeforeUnmount = materialDispose.mock.calls.length;

        view.unmount();

        expect(view.container.querySelectorAll('canvas')).toHaveLength(0);
        expect(geometryDispose.mock.calls.length - geometryCallsBeforeUnmount).toBe(4);
        expect(materialDispose.mock.calls.length - materialCallsBeforeUnmount).toBe(4);
      }
    } finally {
      geometryDispose.mockRestore();
      materialDispose.mockRestore();
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
