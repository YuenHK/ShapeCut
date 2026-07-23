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
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
} from 'three';
import type { EffectLevel } from '../app/effect-level';
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
const ROTATION_SPEED_RADIANS_PER_MS = 0.00009;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.4;
const MAX_PIXEL_RATIO = 2;
const PREWARM_MAX_CSS_WIDTH = 1_280;
const PREWARM_MAX_CSS_HEIGHT = 720;
const MAX_RETAINED_PHYSICAL_PIXELS = 2_560 * 1_440;
const FULL_PARTICLE_LIMIT = 240;
const SAVING_PARTICLE_LIMIT = 72;
const PLATFORM_OPACITY = 0.14;

let availableRenderer: WebGLRenderer | undefined;
let poolLifecycleInstalled = false;
let rendererPoolShuttingDown = false;
const defaultRendererState = new WeakMap<WebGLRenderer, { pixelRatio: number; cssWidth: number; cssHeight: number }>();

function disposeDefaultRenderer(renderer: WebGLRenderer): void {
  defaultRendererState.delete(renderer);
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}

function defaultRendererIsUsable(renderer: WebGLRenderer): boolean {
  try {
    return !renderer.getContext().isContextLost();
  } catch {
    return false;
  }
}

function defaultPixelRatio(): number {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_PIXEL_RATIO);
}

function sizeDefaultRenderer(renderer: WebGLRenderer, width: number, height: number): void {
  const state = defaultRendererState.get(renderer);
  const pixelRatio = state?.pixelRatio ?? defaultPixelRatio();
  const cssWidth = Math.max(Math.round(width), 1), cssHeight = Math.max(Math.round(height), 1);
  if (!state) renderer.setPixelRatio(pixelRatio);
  if (!state || state.cssWidth !== cssWidth || state.cssHeight !== cssHeight) renderer.setSize(cssWidth, cssHeight, false);
  defaultRendererState.set(renderer, { pixelRatio, cssWidth, cssHeight });
}

function createDefaultRenderer(): WebGLRenderer {
  const canvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, canvas });
  sizeDefaultRenderer(
    renderer,
    Math.min(Math.max(window.innerWidth, 1), PREWARM_MAX_CSS_WIDTH),
    Math.min(Math.max(window.innerHeight, 1), PREWARM_MAX_CSS_HEIGHT),
  );
  return renderer;
}

function acquireDefaultRenderer(): WebGLRenderer {
  installRendererPoolLifecycle();
  rendererPoolShuttingDown = false;
  const cached = availableRenderer;
  availableRenderer = undefined;
  if (!cached) return createDefaultRenderer();
  if (defaultRendererIsUsable(cached)) return cached;
  disposeDefaultRenderer(cached);
  return createDefaultRenderer();
}

function releaseDefaultRenderer(renderer: WebGLRenderer): void {
  renderer.domElement.remove();
  if (rendererPoolShuttingDown || !defaultRendererIsUsable(renderer)) {
    disposeDefaultRenderer(renderer);
    return;
  }
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.resetState();
  if (renderer.domElement.width * renderer.domElement.height > MAX_RETAINED_PHYSICAL_PIXELS) {
    const state = defaultRendererState.get(renderer);
    const ratio = state?.pixelRatio ?? defaultPixelRatio();
    const scale = Math.sqrt(MAX_RETAINED_PHYSICAL_PIXELS / (renderer.domElement.width * renderer.domElement.height));
    sizeDefaultRenderer(
      renderer,
      Math.max(1, Math.floor(renderer.domElement.width * scale / ratio)),
      Math.max(1, Math.floor(renderer.domElement.height * scale / ratio)),
    );
  }
  if (!availableRenderer) {
    availableRenderer = renderer;
    return;
  }
  disposeDefaultRenderer(renderer);
}

export function disposeOutlineProcessRendererPool(): void {
  if (!availableRenderer) return;
  const renderer = availableRenderer;
  availableRenderer = undefined;
  disposeDefaultRenderer(renderer);
}

export function shutdownOutlineProcessRendererPool(): void {
  rendererPoolShuttingDown = true;
  disposeOutlineProcessRendererPool();
}

function installRendererPoolLifecycle(): void {
  if (poolLifecycleInstalled) return;
  window.addEventListener('pagehide', shutdownOutlineProcessRendererPool);
  poolLifecycleInstalled = true;
}

export function warmOutlineProcessRenderer(createRenderer: () => WebGLRenderer = createDefaultRenderer): void {
  installRendererPoolLifecycle();
  rendererPoolShuttingDown = false;
  if (availableRenderer || typeof window.WebGLRenderingContext === 'undefined') return;
  let renderer: WebGLRenderer | undefined;
  const lineGeometry = new BufferGeometry();
  const planeGeometry = new PlaneGeometry(2, 2);
  const lineMaterials: LineBasicMaterial[] = [];
  let planeMaterial: MeshBasicMaterial | undefined;
  try {
    renderer = createRenderer();
    if (!defaultRendererState.has(renderer)) sizeDefaultRenderer(
      renderer,
      Math.min(Math.max(window.innerWidth, 1), PREWARM_MAX_CSS_WIDTH),
      Math.min(Math.max(window.innerHeight, 1), PREWARM_MAX_CSS_HEIGHT),
    );
    const scene = new Scene();
    const camera = new PerspectiveCamera(42, renderer.domElement.width / renderer.domElement.height, 0.01, 100);
    camera.position.set(2, 2, 3);
    camera.lookAt(0, 0, 0);
    lineGeometry.setAttribute('position', new BufferAttribute(Float32Array.from([
      -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1,
    ]), 3));
    lineMaterials.push(...Object.values(CANONICAL_ROLE_COLORS).map((color) => new LineBasicMaterial({
      color, transparent: true, opacity: 0.9,
    })));
    lineMaterials.forEach((material, index) => {
      const line = new LineLoop(lineGeometry, material);
      line.position.y = index * 0.1;
      scene.add(line);
    });
    planeMaterial = new MeshBasicMaterial({
      color: SCAN_PLANE_COLOR, opacity: 0.16, transparent: true, depthWrite: false, side: DoubleSide,
    });
    const plane = new Mesh(planeGeometry, planeMaterial);
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);
    renderer.render(scene, camera);
    renderer.getContext().finish();
    availableRenderer = renderer;
  } catch {
    if (renderer) disposeDefaultRenderer(renderer);
  } finally {
    lineGeometry.dispose();
    planeGeometry.dispose();
    lineMaterials.forEach((material) => material.dispose());
    planeMaterial?.dispose();
  }
}

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
  readonly effectLevel?: EffectLevel;
  readonly reducedMotion?: boolean;
  readonly createRenderer?: OutlineWebGLFactory;
  readonly onDegrade?: () => void;
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
  setEffectLevel(level: EffectLevel): void;
  setReducedMotion(reduced: boolean): void;
  setVisible(visible: boolean): void;
  setHighlightedLayer(layerId: string | undefined): void;
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
  readonly platform: Mesh<RingGeometry, MeshBasicMaterial>;
  readonly particles: Points<BufferGeometry, PointsMaterial> | undefined;
  readonly particlePositions: Readonly<{
    full: Float32Array;
    saving: Float32Array;
  }>;
  readonly roleTraceGroups: readonly Group[];
  readonly traceMaterials: ReadonlyMap<FeatureRole, LineBasicMaterial>;
  readonly axialRange: readonly [number, number];
  readonly geometries: ReadonlySet<BufferGeometry>;
  readonly materials: Set<Material>;
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
  return [
    layer.exterior,
    ...(layer.centralHole ? [layer.centralHole] : []),
    ...layer.launcherCuts,
    ...layer.fastenerHoles,
    ...layer.deepFeatures,
    ...layer.lightFeatures,
  ];
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

function wireframeOpacityForStage(stage: AutomaticOutlineProgressStage): number {
  switch (stage) {
    case 'reading': return 0.48;
    case 'analyzing': return 0.72;
    case 'simplifying': return 0.42;
    case 'slicing': return 0.26;
    case 'packaging': return 0.2;
  }
}

function contourOpacityForStage(stage: AutomaticOutlineProgressStage): number {
  switch (stage) {
    case 'reading': return 0.14;
    case 'analyzing': return 0.24;
    case 'simplifying': return 0.68;
    case 'slicing': return 0.88;
    case 'packaging': return 0.96;
  }
}

function traceOpacityForStage(stage: AutomaticOutlineProgressStage): number {
  switch (stage) {
    case 'reading': return 0.03;
    case 'analyzing': return 0.08;
    case 'simplifying': return 0.18;
    case 'slicing': return 0.4;
    case 'packaging': return 0.58;
  }
}

function effectOpacityMultiplier(effectLevel: EffectLevel): number {
  switch (effectLevel) {
    case 'full': return 1;
    case 'energy-saving': return 0.62;
    case 'static': return 0.44;
  }
}

function sampledParticlePositions(
  payload: OutlinePreviewPayload,
  limit: number,
): Float32Array {
  const total = payload.layers.reduce((sum, layer) =>
    sum + allContours(layer).reduce((layerSum, contour) => layerSum + contour.outer.length, 0), 0);
  const count = Math.min(total, limit);
  const positions = new Float32Array(count * 3);
  if (count === 0) return positions;
  const stride = total / count;
  let sourceIndex = 0;
  let sampledIndex = 0;
  let nextSample = 0;
  for (const layer of payload.layers) {
    const axial = (layer.zStart + layer.zEnd) / 2;
    for (const contour of allContours(layer)) {
      for (const [x, y] of contour.outer) {
        if (sourceIndex === Math.floor(nextSample)) {
          positions.set([x, axial, y], sampledIndex * 3);
          sampledIndex += 1;
          nextSample = sampledIndex * stride;
        }
        sourceIndex += 1;
      }
    }
  }
  return positions;
}

function updateParticleBudget(resources: PayloadResources, effectLevel: EffectLevel): void {
  if (!resources.particles) return;
  const positions = effectLevel === 'full'
    ? resources.particlePositions.full
    : resources.particlePositions.saving;
  const attribute = resources.particles.geometry.getAttribute('position') as BufferAttribute;
  const array = attribute.array as Float32Array;
  array.fill(0);
  array.set(positions);
  attribute.needsUpdate = true;
  resources.particles.geometry.setDrawRange(0, positions.length / 3);
  resources.particles.userData.count = positions.length / 3;
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

function createPayloadResources(payload: OutlinePreviewPayload, effectLevel: EffectLevel): PayloadResources {
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
    const traceMaterials = new Map<FeatureRole, LineBasicMaterial>();
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
    const traceMaterialForRole = (role: FeatureRole): LineBasicMaterial => {
      const existing = traceMaterials.get(role);
      if (existing) return existing;
      const material = new LineBasicMaterial({
        color: CANONICAL_ROLE_COLORS[role],
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        linewidth: 2,
      });
      traceMaterials.set(role, material);
      materials.add(material);
      return material;
    };
    const roleTraceRoot = new Group();
    roleTraceRoot.name = 'role-traces';
    const layerGroups = payload.layers.map((layer, order) => {
      const group = new Group();
      group.name = layer.id;
      group.userData = {
        layerId: layer.id,
        layerIndex: layer.index,
        order,
        baseAxial: (layer.zStart + layer.zEnd) / 2,
      };
      const traceGroup = new Group();
      traceGroup.name = `role-traces:${layer.id}`;
      traceGroup.userData = {
        layerId: layer.id,
        order,
        baseAxial: group.userData.baseAxial,
      };
      for (const contour of allContours(layer)) {
        const line = contourLine(contour, materialForRole(contour.role), geometries);
        group.add(line);
        const trace = new LineLoop(line.geometry, traceMaterialForRole(contour.role));
        trace.name = `role-trace:${contour.id}`;
        trace.userData = {
          featureId: contour.id,
          role: contour.role,
          presentationTrace: true,
        };
        trace.renderOrder = 2;
        traceGroup.add(trace);
      }
      root.add(group);
      roleTraceRoot.add(traceGroup);
      return group;
    });
    const roleTraceGroups = [...roleTraceRoot.children] as Group[];
    root.add(roleTraceRoot);

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

    const platformGeometry = new RingGeometry(planarSize * 0.62, planarSize * 0.76, 64);
    geometries.add(platformGeometry);
    const platformMaterial = new MeshBasicMaterial({
      color: SCAN_PLANE_COLOR,
      opacity: PLATFORM_OPACITY,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    materials.add(platformMaterial);
    const platform = new Mesh(platformGeometry, platformMaterial);
    platform.name = 'workbench-platform';
    platform.rotation.x = -Math.PI / 2;
    platform.position.y = axialMinimum - explosionMargin;
    root.add(platform);

    const particlePositions = {
      full: sampledParticlePositions(payload, FULL_PARTICLE_LIMIT),
      saving: sampledParticlePositions(payload, SAVING_PARTICLE_LIMIT),
    };
    let particles: Points<BufferGeometry, PointsMaterial> | undefined;
    if (particlePositions.full.length > 0) {
      const particleGeometry = new BufferGeometry();
      geometries.add(particleGeometry);
      particleGeometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(particlePositions.full.length), 3),
      );
      const particleMaterial = new PointsMaterial({
        color: SCAN_PLANE_COLOR,
        opacity: 0.5,
        transparent: true,
        depthWrite: false,
        size: Math.max(planarSize * 0.012, 0.08),
        sizeAttenuation: true,
      });
      materials.add(particleMaterial);
      particles = new Points(particleGeometry, particleMaterial);
      particles.name = 'contour-particles';
      root.add(particles);
    }

    const resources: PayloadResources = {
      root,
      manufacturingTransform,
      layerGroups,
      meshGeometry,
      wireframe,
      scanPlane,
      centralAxis,
      platform,
      particles,
      particlePositions,
      roleTraceGroups,
      traceMaterials,
      axialRange: [axialMinimum, axialMaximum],
      geometries,
      materials,
      disposed: false,
    };
    updateParticleBudget(resources, effectLevel);
    return resources;
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

function applyLayerHighlight(resources: PayloadResources, selectedLayerId: string | undefined): void {
  for (const traceGroup of resources.roleTraceGroups) {
    traceGroup.visible = selectedLayerId === undefined || traceGroup.userData.layerId === selectedLayerId;
  }
  for (const group of resources.layerGroups) {
    if (selectedLayerId === undefined) {
      group.userData.selected = false;
      group.traverse((object) => {
        if (!(object instanceof Line) || !(object.material instanceof LineBasicMaterial)) return;
        const baseOpacity = object.userData.baseOpacity;
        if (typeof baseOpacity === 'number') object.material.opacity = baseOpacity;
      });
      continue;
    }
    const selected = selectedLayerId === undefined || group.name === selectedLayerId;
    group.userData.selected = selectedLayerId !== undefined && selected;
    group.traverse((object) => {
      if (!(object instanceof Line) || !(object.material instanceof LineBasicMaterial)) return;
      const line = object as Line<BufferGeometry, LineBasicMaterial>;
      let material = line.userData.highlightMaterial as LineBasicMaterial | undefined;
      if (!material) {
        material = line.material.clone();
        line.userData.highlightMaterial = material;
        line.userData.baseOpacity = line.material.opacity;
        line.material = material;
        resources.materials.add(material);
      }
      const baseOpacity = typeof line.userData.baseOpacity === 'number' ? line.userData.baseOpacity : material.opacity;
      material.opacity = selected ? baseOpacity : Math.min(baseOpacity, 0.18);
    });
  }
}

export function createOutlineProcessScene(
  host: HTMLElement,
  initialPayload: OutlinePreviewPayload,
  options: OutlineProcessSceneOptions = {},
): OutlineProcessScene {
  const scene = new Scene();
  let effectLevel = options.effectLevel ?? (options.reducedMotion ? 'static' : 'full');
  scene.userData.effectLevel = effectLevel;
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
  let degraded = false;
  let runtimeReady = false;
  let reducedMotion = options.reducedMotion ?? false;
  let manualVisible = true;
  let intersectionVisible = false;
  let stage = options.stage ?? 'analyzing';
  let explosionAmount = reducedMotion || effectLevel === 'static' ? explosionForStage(stage) : 0;
  let lastFrameTime: number | undefined;
  let selectedLayerId: string | undefined;
  const usesDefaultRenderer = options.createRenderer === undefined;

  const stopFrames = (): void => {
    if (rafId !== undefined) window.cancelAnimationFrame(rafId);
    rafId = undefined;
    lastFrameTime = undefined;
  };
  const degrade = (): void => {
    if (disposed || degraded) return;
    degraded = true;
    stopFrames();
    options.onDegrade?.();
  };
  const render = (): void => {
    try {
      renderer?.render(scene, camera);
    } catch (error) {
      if (!runtimeReady) throw error;
      degrade();
    }
  };
  const shouldAnimate = (): boolean => !disposed
    && !degraded
    && !reducedMotion
    && effectLevel !== 'static'
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
    resources.roleTraceGroups.forEach((group, order) => {
      const baseAxial = typeof group.userData.baseAxial === 'number' ? group.userData.baseAxial : 0;
      group.position.y = baseAxial + (order - middle) * EXPLODED_LAYER_GAP * explosionAmount;
    });
    const [minimum, maximum] = resources.axialRange;
    resources.scanPlane.position.y = minimum + stageProgress(stage) * (maximum - minimum);
    resources.scanPlane.visible = stage === 'analyzing' || stage === 'simplifying';
    resources.scanPlane.material.opacity = stage === 'analyzing' ? 0.16 : stage === 'simplifying' ? 0.07 : 0;
    resources.wireframe.material.opacity = wireframeOpacityForStage(stage);
    const contourOpacity = contourOpacityForStage(stage);
    for (const group of resources.layerGroups) {
      group.traverse((object) => {
        if (!(object instanceof Line) || !(object.material instanceof LineBasicMaterial)) return;
        object.userData.baseOpacity = contourOpacity;
        object.material.opacity = selectedLayerId !== undefined && group.name !== selectedLayerId
          ? Math.min(contourOpacity, 0.18)
          : contourOpacity;
      });
    }
    const traceOpacity = traceOpacityForStage(stage) * effectOpacityMultiplier(effectLevel);
    for (const material of resources.traceMaterials.values()) material.opacity = traceOpacity;
    resources.platform.scale.setScalar(1);
    resources.platform.material.opacity = effectLevel === 'full'
      ? PLATFORM_OPACITY
      : effectLevel === 'energy-saving' ? PLATFORM_OPACITY * 0.72 : PLATFORM_OPACITY * 0.54;
    if (resources.particles) {
      resources.particles.material.opacity = effectLevel === 'full' ? 0.5 : effectLevel === 'energy-saving' ? 0.32 : 0.24;
    }
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
    if (!shouldAnimate() || !resources) return;
    const elapsed = lastFrameTime === undefined ? 0 : Math.min(Math.max(time - lastFrameTime, 0), 64);
    lastFrameTime = time;
    const rotationMultiplier = effectLevel === 'full' ? 1 : 0.45;
    rotatingGroup.rotation.y += elapsed * ROTATION_SPEED_RADIANS_PER_MS * rotationMultiplier;
    const targetExplosion = explosionForStage(stage);
    explosionAmount += (targetExplosion - explosionAmount) * Math.min(elapsed / 180, 1);
    applyProcessState();
    if (effectLevel === 'full') {
      const pulse = Math.sin(time * 0.0018);
      resources.platform.scale.setScalar(1 + pulse * 0.018);
      resources.platform.material.opacity = PLATFORM_OPACITY + pulse * 0.025;
    }
    render();
    scheduleFrame();
  }
  const refreshAnimation = (): void => {
    if (shouldAnimate()) scheduleFrame();
    else stopFrames();
  };
  const resize = (): void => {
    if (!renderer) return;
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    if (!usesDefaultRenderer) renderer.setSize(width, height, false);
    else sizeDefaultRenderer(renderer as WebGLRenderer, width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const onVisibilityChange = (): void => refreshAnimation();
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (runtimeReady) degrade();
  };

  try {
    renderer = options.createRenderer?.() ?? acquireDefaultRenderer();
    if (!usesDefaultRenderer) renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.classList.add('outline-process-canvas');
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    host.append(renderer.domElement);

    resources = createPayloadResources(initialPayload, effectLevel);
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
    runtimeReady = true;
  } catch (error) {
    stopFrames();
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    removeResizeFallback?.();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    renderer?.domElement.removeEventListener('webglcontextlost', onContextLost);
    if (resources) disposePayloadResources(resources);
    if (renderer && usesDefaultRenderer) releaseDefaultRenderer(renderer as WebGLRenderer);
    else {
      renderer?.dispose();
      renderer?.forceContextLoss?.();
      renderer?.domElement.remove();
    }
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
      const replacement = createPayloadResources(payload, effectLevel);
      const previous = resources!;
      rotatingGroup.remove(previous.root);
      resources = replacement;
      rotatingGroup.add(replacement.root);
      disposePayloadResources(previous);
      if (selectedLayerId && !replacement.layerGroups.some((group) => group.name === selectedLayerId)) {
        selectedLayerId = undefined;
      }
      applyLayerHighlight(replacement, selectedLayerId);
      explosionAmount = reducedMotion || effectLevel === 'static' ? explosionForStage(stage) : 0;
      frame();
      render();
    },
    setStage(nextStage) {
      if (disposed) return;
      stage = nextStage;
      if (reducedMotion || effectLevel === 'static') explosionAmount = explosionForStage(stage);
      applyProcessState();
      render();
      refreshAnimation();
    },
    setEffectLevel(level) {
      if (disposed) return;
      effectLevel = level;
      scene.userData.effectLevel = level;
      updateParticleBudget(resources!, effectLevel);
      if (effectLevel === 'static') explosionAmount = explosionForStage(stage);
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
    setHighlightedLayer(layerId) {
      if (disposed) return;
      selectedLayerId = layerId && resources!.layerGroups.some((group) => group.name === layerId)
        ? layerId
        : undefined;
      applyLayerHighlight(resources!, selectedLayerId);
      render();
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
      renderer?.domElement.removeEventListener('webglcontextlost', onContextLost);
      if (resources) {
        rotatingGroup.remove(resources.root);
        disposePayloadResources(resources);
      }
      if (renderer && usesDefaultRenderer) {
        if (degraded) disposeDefaultRenderer(renderer as WebGLRenderer);
        else releaseDefaultRenderer(renderer as WebGLRenderer);
      }
      else {
        renderer?.dispose();
        renderer?.forceContextLoss?.();
        renderer?.domElement.remove();
      }
    },
  };
  return controller;
}
