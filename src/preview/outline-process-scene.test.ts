import { BufferGeometry, Line, LineBasicMaterial, Material, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutlineAxisBasis } from '../domain/outline-2.5d/raster';
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
    launcherCuts: [], fastenerHoles: [],
    deepFeatures: index === 1 ? [contour('red-1', 'DEEP_RED', 2)] : [],
    lightFeatures: index === 2 ? [contour('blue-2', 'LIGHT_BLUE', 2.5)] : [],
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
  const basis = createOutlineAxisBasis({ origin: [2, 3, 4], direction: [1, 0, 0] });
  return {
    mesh: {
      positions: Float32Array.from([2, 3, 4, 12, 3, 4, 2, 11, 4]),
      indices: Uint32Array.from([0, 1, 2]),
    },
    axis: {
      origin: [2, 3, 4], direction: [1, 0, 0],
      planeX: basis.planeX, planeY: basis.planeY,
    },
    layers: Array.from({ length: layerCount }, (_, index) => layer(index)),
  };
}

function blackOnlyPayload(): OutlinePreviewPayload {
  const source = payload();
  return {
    ...source,
    layers: source.layers.map((item) => ({
      ...item,
      centralHole: undefined,
      launcherCuts: [], fastenerHoles: [],
      deepFeatures: [], lightFeatures: [],
      diagnostics: { ...item.diagnostics, hole: { status: 'omitted' as const } },
    })),
  };
}

function alignedPayload(direction: readonly [number, number, number]): OutlinePreviewPayload {
  const origin = [17, -11, 23] as const;
  const basis = createOutlineAxisBasis({ origin, direction });
  const displayPoints = [[2, 5, 3], [8, 5, 3], [2, 5, 9]] as const;
  const worldPoints = displayPoints.map(([x, y, z]) => [
    origin[0] + basis.planeX[0] * x + basis.axial[0] * y + basis.planeY[0] * z,
    origin[1] + basis.planeX[1] * x + basis.axial[1] * y + basis.planeY[1] * z,
    origin[2] + basis.planeX[2] * x + basis.axial[2] * y + basis.planeY[2] * z,
  ] as const);
  const exterior = {
    id: 'aligned-exterior', role: 'CUT_BLACK' as const,
    outer: displayPoints.map(([x, , z]) => [x, z] as const),
    boundsMm: { minX: 2, minY: 3, maxX: 8, maxY: 9 }, areaMm2: 18,
  };
  return {
    mesh: {
      positions: Float32Array.from(worldPoints.flat()),
      indices: Uint32Array.from([0, 1, 2]),
    },
    axis: { origin, direction, planeX: basis.planeX, planeY: basis.planeY },
    layers: Array.from({ length: 6 }, (_, index) => ({
      id: `aligned-layer-${index}`, index, zStart: 4.5 + index, zEnd: 5.5 + index,
      exterior: { ...exterior, id: `aligned-exterior-${index}` },
      launcherCuts: [], fastenerHoles: [], deepFeatures: [], lightFeatures: [],
      removedComponentCount: 0,
      diagnostics: {
        hole: { status: 'omitted' as const },
        depth: { cellSizeMm: 0, contrastMm: 0, redThresholdMm: 0, blueThresholdMm: 0 },
      },
    })),
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
  it('renders a finite mesh-only analyzing scene before validated layers exist', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    const source = { ...payload(), layers: [] };
    const view = createOutlineProcessScene(document.createElement('div'), source, {
      stage: 'analyzing', reducedMotion: true, createRenderer: renderer,
    });

    expect(view.layerGroups).toHaveLength(0);
    expect(Array.from(view.centralAxis.geometry.getAttribute('position').array)).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(Array.from(view.centralAxis.geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true);
    view.dispose();
  });

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
      0.5 - 2.5 * EXPLODED_LAYER_GAP,
      1.5 - 1.5 * EXPLODED_LAYER_GAP,
      2.5 - 0.5 * EXPLODED_LAYER_GAP,
      3.5 + 0.5 * EXPLODED_LAYER_GAP,
      4.5 + 1.5 * EXPLODED_LAYER_GAP,
      5.5 + 2.5 * EXPLODED_LAYER_GAP,
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

    view.manufacturingTransform.updateMatrixWorld(true);
    const mappedOrigin = view.manufacturingTransform.localToWorld(new Vector3(...source.axis.origin));
    const mappedAxis = view.manufacturingTransform.localToWorld(
      new Vector3(
        source.axis.origin[0] + source.axis.direction[0],
        source.axis.origin[1] + source.axis.direction[1],
        source.axis.origin[2] + source.axis.direction[2],
      ),
    ).sub(mappedOrigin).normalize();
    expect(mappedOrigin.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-6);
    expect(mappedAxis.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
    view.dispose();
  });

  it.each([
    ['X', [1, 0, 0] as const],
    ['Y', [0, 1, 0] as const],
    ['Z', [0, 0, 1] as const],
    ['oblique', [1, 2, 3] as const],
  ])('aligns a translated asymmetric mesh and contour in the same %s extraction basis', (_label, direction) => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    const source = alignedPayload(direction);
    const view = createOutlineProcessScene(document.createElement('div'), source, {
      stage: 'analyzing', reducedMotion: true, createRenderer: renderer,
    });
    view.scene.updateMatrixWorld(true);

    const meshPosition = view.meshGeometry.getAttribute('position');
    const meshWorld = view.wireframe.localToWorld(new Vector3(
      meshPosition.getX(0), meshPosition.getY(0), meshPosition.getZ(0),
    ));
    const contourLineObject = view.layerGroups[0].children[0] as Line<BufferGeometry, LineBasicMaterial>;
    const contourPosition = contourLineObject.geometry.getAttribute('position');
    const contourWorld = contourLineObject.localToWorld(new Vector3(
      contourPosition.getX(0), contourPosition.getY(0), contourPosition.getZ(0),
    ));

    expect(meshWorld.distanceTo(new Vector3(2, 5, 3))).toBeLessThan(1e-5);
    expect(contourWorld.distanceTo(meshWorld)).toBeLessThan(1e-5);
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

  it('dims unselected layers without changing their contour geometry', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    const view = createOutlineProcessScene(document.createElement('div'), payload(), {
      stage: 'packaging', reducedMotion: true, createRenderer: renderer,
    });
    const firstLine = view.layerGroups[0].children[0] as Line<BufferGeometry, LineBasicMaterial>;
    const selectedLine = view.layerGroups[2].children[0] as Line<BufferGeometry, LineBasicMaterial>;
    const firstGeometry = firstLine.geometry;

    view.setHighlightedLayer('layer-2');
    expect(view.layerGroups[2].userData.selected).toBe(true);
    expect(view.layerGroups[0].userData.selected).toBe(false);
    expect(firstLine.geometry).toBe(firstGeometry);
    expect(firstLine.material.opacity).toBeLessThan(selectedLine.material.opacity);

    view.setHighlightedLayer(undefined);
    expect(firstLine.material.opacity).toBe(selectedLine.material.opacity);
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
    const firstFrame = callbacks.values().next().value as FrameRequestCallback;
    callbacks.clear();
    firstFrame(0);
    const secondFrame = callbacks.values().next().value as FrameRequestCallback;
    callbacks.clear();
    secondFrame(64);
    expect(view.rotatingGroup.rotation.y).toBeCloseTo(0.00576);
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

  it('does not animate when IntersectionObserver is unavailable', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const request = vi.spyOn(window, 'requestAnimationFrame');
    const view = createOutlineProcessScene(document.createElement('div'), payload(), {
      stage: 'slicing', reducedMotion: false, createRenderer: renderer,
    });

    expect(request).not.toHaveBeenCalled();
    view.setVisible(true);
    expect(request).not.toHaveBeenCalled();
    view.dispose();
  });

  it('owns only present role materials and disposes construction resources exactly once', () => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;
    const before = new Material();
    const beforeId = (before as Material & { readonly id: number }).id;
    before.dispose();
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const output = renderer();
    output.setSize = vi.fn(() => { throw new Error('resize construction failure'); });

    expect(() => createOutlineProcessScene(document.createElement('div'), blackOnlyPayload(), {
      stage: 'slicing', reducedMotion: true, createRenderer: () => output,
    })).toThrow(/resize construction failure/i);

    const after = new Material();
    expect((after as Material & { readonly id: number }).id - beforeId - 1).toBe(4);
    expect(geometryDispose).toHaveBeenCalledTimes(10);
    expect(materialDispose).toHaveBeenCalledTimes(4);
    expect(output.dispose).toHaveBeenCalledOnce();
    expect(output.forceContextLoss).toHaveBeenCalledOnce();
    after.dispose();
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
