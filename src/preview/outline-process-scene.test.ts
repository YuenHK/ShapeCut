import { BufferGeometry, Line, LineBasicMaterial, Material, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColoredOutlineLayer, FeatureContour, OutlinePreviewPayload } from '../domain/outline-features/types';
import {
  CANONICAL_ROLE_COLORS,
  EXPLODED_LAYER_GAP,
  createOutlineProcessScene,
  type OutlineProcessRenderer,
} from './outline-process-scene';

function contour(id: string, role: FeatureContour['role'], inset = 0): FeatureContour {
  const outer = [
    [inset, inset], [10 - inset, inset], [10 - inset, 8 - inset], [inset, 8 - inset],
  ] as const;
  return {
    id,
    role,
    outer,
    boundsMm: { minX: inset, minY: inset, maxX: 10 - inset, maxY: 8 - inset },
    areaMm2: (10 - inset * 2) * (8 - inset * 2),
  };
}

function layer(index: number): ColoredOutlineLayer {
  return {
    id: `layer-${index}`,
    index,
    zStart: index,
    zEnd: index + 1,
    exterior: contour(`exterior-${index}`, 'CUT_BLACK'),
    centralHole: index === 0 ? contour('hole-0', 'CUT_BLACK', 3) : undefined,
    deepFeature: index === 1 ? contour('red-1', 'DEEP_RED', 2) : undefined,
    lightFeature: index === 2 ? contour('blue-2', 'LIGHT_BLUE', 2.5) : undefined,
    removedComponentCount: 0,
    diagnostics: {
      hole: index === 0
        ? { status: 'retained', equivalentDiameterMm: 2, axisDistanceMm: 0 }
        : { status: 'omitted' },
      depth: { cellSizeMm: 0.25, contrastMm: 1, redThresholdMm: 0.75, blueThresholdMm: 0.4 },
    },
  };
}

function payload(layerCount = 6): OutlinePreviewPayload {
  return {
    mesh: {
      positions: Float32Array.from([2, 3, 4, 12, 3, 4, 2, 11, 4]),
      indices: Uint32Array.from([0, 1, 2]),
    },
    axis: { origin: [2, 3, 4], direction: [1, 0, 0] },
    layers: Array.from({ length: layerCount }, (_, index) => layer(index)),
  };
}

function renderer(): OutlineProcessRenderer {
  return {
    domElement: document.createElement('canvas'),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: vi.fn(),
  };
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) { ResizeObserverStub.instances.push(this); }
  unobserve() {}
}

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: IntersectionObserverCallback) { IntersectionObserverStub.instances.push(this); }
  unobserve() {}
  takeRecords() { return []; }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalIntersectionObserver = globalThis.IntersectionObserver;

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  ResizeObserverStub.instances = [];
  IntersectionObserverStub.instances = [];
  vi.restoreAllMocks();
});

describe('OutlineProcessScene', () => {
  it('builds the wireframe and role lines from the transferred mesh and layer geometry', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
    const source = payload();
    const view = createOutlineProcessScene(document.createElement('div'), source, {
      stage: 'slicing', reducedMotion: true, createRenderer: renderer,
    });

    expect(view.meshGeometry.getAttribute('position').array).toBe(source.mesh.positions);
    expect(view.meshGeometry.getIndex()?.array).toBe(source.mesh.indices);
    expect(view.wireframe.material).toMatchObject({ transparent: true, opacity: expect.any(Number) });
    expect(view.wireframe.material.opacity).toBeLessThan(1);
    expect(view.scanPlane.material).toMatchObject({ transparent: true });
    expect(view.layerGroups).toHaveLength(6);
    expect(view.layerGroups.map((group) => group.position.y)).toEqual([
      -2.5 * EXPLODED_LAYER_GAP,
      -1.5 * EXPLODED_LAYER_GAP,
      -0.5 * EXPLODED_LAYER_GAP,
      0.5 * EXPLODED_LAYER_GAP,
      1.5 * EXPLODED_LAYER_GAP,
      2.5 * EXPLODED_LAYER_GAP,
    ]);

    const roleColors = new Map<string, string>();
    for (const group of view.layerGroups) {
      group.traverse((object) => {
        if (!(object instanceof Line) || !(object.material instanceof LineBasicMaterial)) return;
        roleColors.set(String(object.userData.role), `#${object.material.color.getHexString().toUpperCase()}`);
      });
    }
    expect(roleColors).toEqual(new Map([
      ['CUT_BLACK', CANONICAL_ROLE_COLORS.CUT_BLACK],
      ['DEEP_RED', CANONICAL_ROLE_COLORS.DEEP_RED],
      ['LIGHT_BLUE', CANONICAL_ROLE_COLORS.LIGHT_BLUE],
    ]));

    const mappedAxis = new Vector3(...source.axis.direction)
      .applyQuaternion(view.manufacturingTransform.quaternion)
      .normalize();
    expect(mappedAxis.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
    view.dispose();
  });

  it('rotates only around display Y and restores rotation and zoom', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    const view = createOutlineProcessScene(document.createElement('div'), payload(), {
      stage: 'packaging', reducedMotion: true, createRenderer: renderer,
    });

    const x = view.rotatingGroup.rotation.x, z = view.rotatingGroup.rotation.z;
    view.rotateBy(0.7);
    view.zoomBy(0.6);
    expect(view.rotatingGroup.rotation.y).toBeCloseTo(0.7);
    expect(view.rotatingGroup.rotation.x).toBe(x);
    expect(view.rotatingGroup.rotation.z).toBe(z);
    expect(view.camera.zoom).toBeGreaterThan(1);

    view.resetView();
    expect(view.rotatingGroup.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(view.camera.zoom).toBe(1);
    view.dispose();
  });

  it('runs animation frames only while visible and motion is allowed', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
    let nextFrame = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { callbacks.delete(id); });
    const host = document.createElement('div');
    const view = createOutlineProcessScene(host, payload(), {
      stage: 'slicing', reducedMotion: false, createRenderer: renderer,
    });

    expect(callbacks.size).toBe(0);
    const observer = IntersectionObserverStub.instances[0];
    observer.callback([
      { target: host, isIntersecting: true } as unknown as IntersectionObserverEntry,
    ], observer as unknown as IntersectionObserver);
    expect(callbacks.size).toBe(1);
    view.setVisible(false);
    expect(callbacks.size).toBe(0);
    expect(cancel).toHaveBeenCalled();
    view.setVisible(true);
    expect(callbacks.size).toBe(1);
    view.setReducedMotion(true);
    expect(callbacks.size).toBe(0);
    view.setReducedMotion(false);
    expect(callbacks.size).toBe(1);
    view.dispose();
    expect(callbacks.size).toBe(0);
  });

  it('disposes replaced and unmounted resources, renderer, observers, RAF, and canvas', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 41);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const host = document.createElement('div');
    const output = renderer();
    const view = createOutlineProcessScene(host, payload(), {
      stage: 'slicing', reducedMotion: false, createRenderer: () => output,
    });
    const observer = IntersectionObserverStub.instances[0];
    observer.callback([
      { target: host, isIntersecting: true } as unknown as IntersectionObserverEntry,
    ], observer as unknown as IntersectionObserver);
    const oldGeometry = view.meshGeometry;

    view.setPayload(payload(7));
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(view.meshGeometry).not.toBe(oldGeometry);
    expect(view.layerGroups).toHaveLength(7);

    view.dispose();
    expect(output.dispose).toHaveBeenCalledOnce();
    expect(output.forceContextLoss).toHaveBeenCalledOnce();
    expect(ResizeObserverStub.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(IntersectionObserverStub.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(41);
    expect(output.domElement).not.toBeInTheDocument();
  });
});
