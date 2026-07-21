import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
} from 'three';
import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import type {
  ColoredOutlineLayer,
  FeatureContour,
  FeatureRole,
  OutlinePreviewPayload,
} from '../domain/outline-features/types';

export const CANONICAL_ROLE_COLORS = Object.freeze({
  CUT_BLACK: '#000000',
  DEEP_RED: '#E5484D',
  LIGHT_BLUE: '#3A78D4',
} satisfies Record<FeatureRole, string>);

export const EXPLODED_LAYER_GAP = 6;
const WIREFRAME_COLOR = '#22A77D';
const SCAN_PLANE_COLOR = '#87DFBE';
const AXIS_COLOR = '#08745A';
const ROTATION_SPEED_RADIANS_PER_MS = 0.00018;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.4;

export interface OutlineProcessRenderer {
  readonly domElement: HTMLCanvasElement;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  dispose(): void;
  forceContextLoss?(): void;
}

export type OutlineWebGLFactory = () => OutlineProcessRenderer;

export type OutlineProcessSceneOptions = {
  readonly stage?: AutomaticOutlineProgressStage;
  readonly reducedMotion?: boolean;
  readonly createRenderer?: OutlineWebGLFactory;
};

export interface OutlineProcessScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly rotatingGroup: Group;
  readonly manufacturingTransform: Group;
  readonly layerGroups: readonly Group[];
  readonly meshGeometry: BufferGeometry;
  readonly wireframe: LineSegments<WireframeGeometry, LineBasicMaterial>;
  readonly scanPlane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly centralAxis: Line<BufferGeometry, LineBasicMaterial>;
  setPayload(payload: OutlinePreviewPayload): void;
  setStage(stage: AutomaticOutlineProgressStage): void;
  setReducedMotion(reduced: boolean): void;
  setVisible(visible: boolean): void;
  rotateBy(radians: number): void;
  zoomBy(amount: number): void;
  resetView(): void;
  dispose(): void;
}

type PayloadResources = {
  readonly root: Group;
  readonly manufacturingTransform: Group;
  readonly layerGroups: readonly Group[];
  readonly meshGeometry: BufferGeometry;
  readonly wireframe: LineSegments<WireframeGeometry, LineBasicMaterial>;
  readonly scanPlane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly centralAxis: Line<BufferGeometry, LineBasicMaterial>;
};

function disposeObject(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    const renderable = object as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | readonly Material[];
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    if (renderable.material) {
      const values = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of values) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
}

function contourLine(contour: FeatureContour, material: LineBasicMaterial): LineLoop {
  const positions = new Float32Array(contour.outer.length * 3);
  contour.outer.forEach(([x, y], index) => positions.set([x, 0, y], index * 3));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const line = new LineLoop(geometry, material);
  line.name = contour.id;
  line.userData = { featureId: contour.id, role: contour.role };
  return line;
}

function allContours(layer: ColoredOutlineLayer): readonly FeatureContour[] {
  return [layer.exterior, layer.centralHole, layer.deepFeature, layer.lightFeature]
    .filter((contour): contour is FeatureContour => contour !== undefined);
}

function stageProgress(stage: AutomaticOutlineProgressStage): number {
  switch (stage) {
    case 'reading': return 0;
    case 'analyzing': return 0.12;
    case 'simplifying': return 0.38;
    case 'slicing': return 0.76;
    case 'packaging': return 1;
  }
}

function explosionForStage(stage: AutomaticOutlineProgressStage): number {
  return stage === 'slicing' || stage === 'packaging' ? 1 : 0;
}

function normalizedDirection(direction: readonly [number, number, number]): Vector3 {
  const vector = new Vector3(...direction);
  return vector.lengthSq() > 0 && Number.isFinite(vector.lengthSq())
    ? vector.normalize()
    : new Vector3(0, 1, 0);
}

function planarBounds(layers: readonly ColoredOutlineLayer[]): Box3 {
  const bounds = new Box3();
  for (const layer of layers) {
    for (const contour of allContours(layer)) {
      for (const [x, y] of contour.outer) bounds.expandByPoint(new Vector3(x, 0, y));
    }
  }
  return bounds;
}

function createPayloadResources(payload: OutlinePreviewPayload): PayloadResources {
  const root = new Group();
  root.name = 'outline-process-payload';
  let meshGeometry: BufferGeometry | undefined;
  try {
    meshGeometry = new BufferGeometry();
    meshGeometry.setAttribute('position', new BufferAttribute(payload.mesh.positions, 3));
    meshGeometry.setIndex(new BufferAttribute(payload.mesh.indices, 1));

    const wireframeMaterial = new LineBasicMaterial({
      color: WIREFRAME_COLOR,
      opacity: 0.34,
      transparent: true,
      depthWrite: false,
    });
    const wireframe = new LineSegments(new WireframeGeometry(meshGeometry), wireframeMaterial);
    wireframe.name = 'actual-mesh-wireframe';

    const manufacturingTransform = new Group();
    manufacturingTransform.name = 'manufacturing-axis-to-display-y';
    manufacturingTransform.quaternion.setFromUnitVectors(
      normalizedDirection(payload.axis.direction),
      new Vector3(0, 1, 0),
    );
    wireframe.position.set(...payload.axis.origin).multiplyScalar(-1);
    manufacturingTransform.add(wireframe);
    root.add(manufacturingTransform);

    const materials = new Map<FeatureRole, LineBasicMaterial>(
      (Object.entries(CANONICAL_ROLE_COLORS) as [FeatureRole, string][]).map(([role, color]) => [
        role,
        new LineBasicMaterial({ color, transparent: true, opacity: role === 'CUT_BLACK' ? 0.9 : 0.96 }),
      ]),
    );
    const layerGroups = payload.layers.map((layer, order) => {
      const group = new Group();
      group.name = layer.id;
      group.userData = { layerId: layer.id, layerIndex: layer.index, order };
      for (const contour of allContours(layer)) group.add(contourLine(contour, materials.get(contour.role)!));
      root.add(group);
      return group;
    });

    const bounds = planarBounds(payload.layers);
    const boundsCenter = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3());
    const boundsSize = bounds.isEmpty() ? new Vector3(10, 0, 10) : bounds.getSize(new Vector3());
    for (const group of layerGroups) {
      group.position.x = -boundsCenter.x;
      group.position.z = -boundsCenter.z;
    }
    const planarSize = Math.max(boundsSize.x, boundsSize.z, 1);

    const scanPlane = new Mesh(
      new PlaneGeometry(planarSize * 1.14, planarSize * 1.14),
      new MeshBasicMaterial({
        color: SCAN_PLANE_COLOR,
        opacity: 0.16,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    scanPlane.name = 'manufacturing-scan-plane';
    scanPlane.rotation.x = -Math.PI / 2;
    root.add(scanPlane);

    const axisHalfLength = Math.max((payload.layers.length + 1) * EXPLODED_LAYER_GAP / 2, planarSize * 0.55);
    const axisGeometry = new BufferGeometry();
    axisGeometry.setAttribute('position', new BufferAttribute(Float32Array.from([
      0, -axisHalfLength, 0,
      0, axisHalfLength, 0,
    ]), 3));
    const centralAxis = new Line(axisGeometry, new LineBasicMaterial({
      color: AXIS_COLOR,
      opacity: 0.72,
      transparent: true,
      depthTest: false,
    }));
    centralAxis.name = 'selected-manufacturing-axis';
    root.add(centralAxis);

    return {
      root,
      manufacturingTransform,
      layerGroups,
      meshGeometry,
      wireframe,
      scanPlane,
      centralAxis,
    };
  } catch (error) {
    disposeObject(root);
    meshGeometry?.dispose();
    throw error;
  }
}

function disposePayloadResources(resources: PayloadResources): void {
  disposeObject(resources.root);
  resources.meshGeometry.dispose();
}

export function createOutlineProcessScene(
  host: HTMLElement,
  initialPayload: OutlinePreviewPayload,
  options: OutlineProcessSceneOptions = {},
): OutlineProcessScene {
  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.01, 100_000);
  const rotatingGroup = new Group();
  rotatingGroup.name = 'display-y-rotation';
  scene.add(rotatingGroup);
  scene.add(new AmbientLight('#FFFFFF', 1.3));
  const light = new DirectionalLight('#FFFFFF', 1.5);
  light.position.set(5, 8, 7);
  scene.add(light);

  let renderer: OutlineProcessRenderer | undefined;
  let resources: PayloadResources | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let removeResizeFallback: (() => void) | undefined;
  let rafId: number | undefined;
  let disposed = false;
  let reducedMotion = options.reducedMotion ?? false;
  let manualVisible = true;
  let intersectionVisible = typeof IntersectionObserver !== 'function';
  let stage = options.stage ?? 'analyzing';
  let explosionAmount = reducedMotion ? explosionForStage(stage) : 0;
  let lastFrameTime: number | undefined;

  const render = (): void => renderer?.render(scene, camera);
  const shouldAnimate = (): boolean => !disposed
    && !reducedMotion
    && manualVisible
    && intersectionVisible
    && !document.hidden;
  const applyProcessState = (): void => {
    if (!resources) return;
    const middle = (resources.layerGroups.length - 1) / 2;
    resources.layerGroups.forEach((group, order) => {
      group.position.y = (order - middle) * EXPLODED_LAYER_GAP * explosionAmount;
    });
    const scanRange = Math.max(resources.layerGroups.length - 1, 1) * EXPLODED_LAYER_GAP;
    resources.scanPlane.position.y = (stageProgress(stage) - 0.5) * scanRange;
  };
  const frame = (): void => {
    if (!resources) return;
    applyProcessState();
    const bounds = new Box3().setFromObject(resources.root);
    const size = bounds.isEmpty() ? 10 : Math.max(bounds.getSize(new Vector3()).length(), 1);
    camera.position.set(size * 0.78, size * 0.62, size * 1.18);
    camera.near = Math.max(size / 10_000, 0.01);
    camera.far = Math.max(size * 100, 1_000);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };
  const scheduleFrame = (): void => {
    if (!shouldAnimate() || rafId !== undefined || typeof window.requestAnimationFrame !== 'function') return;
    rafId = window.requestAnimationFrame(tick);
  };
  function tick(time: number): void {
    rafId = undefined;
    if (!shouldAnimate()) return;
    const elapsed = lastFrameTime === undefined ? 0 : Math.min(Math.max(time - lastFrameTime, 0), 64);
    lastFrameTime = time;
    rotatingGroup.rotation.y += elapsed * ROTATION_SPEED_RADIANS_PER_MS;
    const targetExplosion = explosionForStage(stage);
    explosionAmount += (targetExplosion - explosionAmount) * Math.min(elapsed / 180, 1);
    applyProcessState();
    render();
    scheduleFrame();
  }
  const stopFrames = (): void => {
    if (rafId !== undefined) window.cancelAnimationFrame(rafId);
    rafId = undefined;
    lastFrameTime = undefined;
  };
  const refreshAnimation = (): void => {
    if (shouldAnimate()) scheduleFrame();
    else stopFrames();
  };
  const resize = (): void => {
    if (!renderer) return;
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const onVisibilityChange = (): void => refreshAnimation();

  try {
    renderer = options.createRenderer?.() ?? new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.classList.add('outline-process-canvas');
    host.append(renderer.domElement);

    resources = createPayloadResources(initialPayload);
    rotatingGroup.add(resources.root);
    frame();
    resize();

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    } else {
      window.addEventListener('resize', resize);
      removeResizeFallback = () => window.removeEventListener('resize', resize);
    }
    if (typeof IntersectionObserver === 'function') {
      intersectionObserver = new IntersectionObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === host) ?? entries[0];
        if (!entry) return;
        intersectionVisible = entry.isIntersecting;
        refreshAnimation();
      });
      intersectionObserver.observe(host);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    render();
    refreshAnimation();
  } catch (error) {
    stopFrames();
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    removeResizeFallback?.();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (resources) disposePayloadResources(resources);
    renderer?.dispose();
    renderer?.forceContextLoss?.();
    renderer?.domElement.remove();
    throw error;
  }

  const controller: OutlineProcessScene = {
    scene,
    camera,
    rotatingGroup,
    get manufacturingTransform() { return resources!.manufacturingTransform; },
    get layerGroups() { return resources!.layerGroups; },
    get meshGeometry() { return resources!.meshGeometry; },
    get wireframe() { return resources!.wireframe; },
    get scanPlane() { return resources!.scanPlane; },
    get centralAxis() { return resources!.centralAxis; },
    setPayload(payload) {
      if (disposed) return;
      const replacement = createPayloadResources(payload);
      const previous = resources!;
      rotatingGroup.remove(previous.root);
      resources = replacement;
      rotatingGroup.add(replacement.root);
      disposePayloadResources(previous);
      explosionAmount = reducedMotion ? explosionForStage(stage) : 0;
      frame();
      render();
    },
    setStage(nextStage) {
      if (disposed) return;
      stage = nextStage;
      if (reducedMotion) explosionAmount = explosionForStage(stage);
      applyProcessState();
      render();
      refreshAnimation();
    },
    setReducedMotion(reduced) {
      if (disposed) return;
      reducedMotion = reduced;
      if (reducedMotion) explosionAmount = explosionForStage(stage);
      applyProcessState();
      render();
      refreshAnimation();
    },
    setVisible(visible) {
      if (disposed) return;
      manualVisible = visible;
      refreshAnimation();
      if (visible) render();
    },
    rotateBy(radians) {
      if (disposed || !Number.isFinite(radians)) return;
      rotatingGroup.rotation.y += radians;
      render();
    },
    zoomBy(amount) {
      if (disposed || !Number.isFinite(amount)) return;
      camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom + amount));
      camera.updateProjectionMatrix();
      render();
    },
    resetView() {
      if (disposed) return;
      rotatingGroup.rotation.set(0, 0, 0);
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopFrames();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      removeResizeFallback?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (resources) {
        rotatingGroup.remove(resources.root);
        disposePayloadResources(resources);
      }
      renderer?.dispose();
      renderer?.forceContextLoss?.();
      renderer?.domElement.remove();
    },
  };
  return controller;
}
