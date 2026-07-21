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
  Matrix4,
  Mesh,
  MeshBasicMaterial,
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
  readonly axialRange: readonly [number, number];
  readonly geometries: ReadonlySet<BufferGeometry>;
  readonly materials: ReadonlySet<Material>;
  disposed: boolean;
};

function disposeOwnedResources(
  root: Group,
  geometries: ReadonlySet<BufferGeometry>,
  materials: ReadonlySet<Material>,
): void {
  root.clear();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function contourLine(
  contour: FeatureContour,
  material: LineBasicMaterial,
  geometries: Set<BufferGeometry>,
): LineLoop {
  const positions = new Float32Array(contour.outer.length * 3);
  contour.outer.forEach(([x, y], index) => positions.set([x, 0, y], index * 3));
  const geometry = new BufferGeometry();
  geometries.add(geometry);
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
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  try {
    const meshGeometry = new BufferGeometry();
    geometries.add(meshGeometry);
    meshGeometry.setAttribute('position', new BufferAttribute(payload.mesh.positions, 3));
    meshGeometry.setIndex(new BufferAttribute(payload.mesh.indices, 1));

    const wireframeMaterial = new LineBasicMaterial({
      color: WIREFRAME_COLOR,
      opacity: 0.34,
      transparent: true,
      depthWrite: false,
    });
    materials.add(wireframeMaterial);
    const wireframeGeometry = new WireframeGeometry(meshGeometry);
    geometries.add(wireframeGeometry);
    const wireframe = new LineSegments(wireframeGeometry, wireframeMaterial);
    wireframe.name = 'actual-mesh-wireframe';

    const manufacturingTransform = new Group();
    manufacturingTransform.name = 'manufacturing-axis-to-display-y';
    const axial = normalizedDirection(payload.axis.direction);
    const planeX = new Vector3(...payload.axis.planeX);
    const planeY = new Vector3(...payload.axis.planeY);
    const origin = new Vector3(...payload.axis.origin);
    manufacturingTransform.matrixAutoUpdate = false;
    manufacturingTransform.matrix.copy(new Matrix4().set(
      planeX.x, planeX.y, planeX.z, -origin.dot(planeX),
      axial.x, axial.y, axial.z, -origin.dot(axial),
      planeY.x, planeY.y, planeY.z, -origin.dot(planeY),
      0, 0, 0, 1,
    ));
    manufacturingTransform.add(wireframe);
    root.add(manufacturingTransform);

    const roleMaterials = new Map<FeatureRole, LineBasicMaterial>();
    const materialForRole = (role: FeatureRole): LineBasicMaterial => {
      const existing = roleMaterials.get(role);
      if (existing) return existing;
      const material = new LineBasicMaterial({
        color: CANONICAL_ROLE_COLORS[role],
        transparent: true,
        opacity: role === 'CUT_BLACK' ? 0.9 : 0.96,
      });
      roleMaterials.set(role, material);
      materials.add(material);
      return material;
    };
    const layerGroups = payload.layers.map((layer, order) => {
      const group = new Group();
      group.name = layer.id;
      group.userData = {
        layerId: layer.id,
        layerIndex: layer.index,
        order,
        baseAxial: (layer.zStart + layer.zEnd) / 2,
      };
      for (const contour of allContours(layer)) {
        group.add(contourLine(contour, materialForRole(contour.role), geometries));
      }
      root.add(group);
      return group;
    });

    const bounds = planarBounds(payload.layers);
    const boundsSize = bounds.isEmpty() ? new Vector3(10, 0, 10) : bounds.getSize(new Vector3());
    const planarSize = Math.max(boundsSize.x, boundsSize.z, 1);

    const scanGeometry = new PlaneGeometry(planarSize * 1.14, planarSize * 1.14);
    geometries.add(scanGeometry);
    const scanMaterial = new MeshBasicMaterial({
      color: SCAN_PLANE_COLOR,
      opacity: 0.16,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    materials.add(scanMaterial);
    const scanPlane = new Mesh(
      scanGeometry,
      scanMaterial,
    );
    scanPlane.name = 'manufacturing-scan-plane';
    scanPlane.rotation.x = -Math.PI / 2;
    root.add(scanPlane);

    const axialMinimum = payload.layers.length > 0
      ? Math.min(...payload.layers.map((layer) => layer.zStart))
      : -planarSize / 2;
    const axialMaximum = payload.layers.length > 0
      ? Math.max(...payload.layers.map((layer) => layer.zEnd))
      : planarSize / 2;
    const explosionMargin = Math.max((payload.layers.length - 1) * EXPLODED_LAYER_GAP / 2, planarSize * 0.1);
    const axisGeometry = new BufferGeometry();
    geometries.add(axisGeometry);
    axisGeometry.setAttribute('position', new BufferAttribute(Float32Array.from([
      0, axialMinimum - explosionMargin, 0,
      0, axialMaximum + explosionMargin, 0,
    ]), 3));
    const axisMaterial = new LineBasicMaterial({
      color: AXIS_COLOR,
      opacity: 0.72,
      transparent: true,
      depthTest: false,
    });
    materials.add(axisMaterial);
    const centralAxis = new Line(axisGeometry, axisMaterial);
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
      axialRange: [axialMinimum, axialMaximum],
      geometries,
      materials,
      disposed: false,
    };
  } catch (error) {
    disposeOwnedResources(root, geometries, materials);
    throw error;
  }
}

function disposePayloadResources(resources: PayloadResources): void {
  if (resources.disposed) return;
  resources.disposed = true;
  disposeOwnedResources(resources.root, resources.geometries, resources.materials);
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
  let intersectionVisible = false;
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
      const baseAxial = typeof group.userData.baseAxial === 'number' ? group.userData.baseAxial : 0;
      group.position.y = baseAxial + (order - middle) * EXPLODED_LAYER_GAP * explosionAmount;
    });
    const [minimum, maximum] = resources.axialRange;
    resources.scanPlane.position.y = minimum + stageProgress(stage) * (maximum - minimum);
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
