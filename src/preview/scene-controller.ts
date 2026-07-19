import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Shape,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SpinnerKit, Polygon2 } from '../domain/decomposition/types';
import type { EngravingMap } from '../domain/engraving/height-field';
import type { EdgeMarker, MeshProblemReport, TriangleMarker, TriangleMesh } from '../domain/mesh/types';
import { engravingLevelColor, PART_COLORS } from './color-map';

export interface SceneController {
  setMesh(mesh: TriangleMesh | undefined): void;
  setParts(parts: SpinnerKit | undefined): void;
  setExploded(amount: number): void;
  setEngraving(map: EngravingMap | undefined): void;
  setMeshProblems(report: MeshProblemReport | undefined): void;
  selectPart(id: string | undefined): void;
  focusRegion(id: string): void;
  dispose(): void;
}

function shapeFromPolygon(polygon: Polygon2): Shape {
  const shape = new Shape();
  polygon.points.forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
  shape.closePath();
  return shape;
}

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
      const objectMaterials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of objectMaterials) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
}

function markerGeometry(points: readonly (readonly [number, number, number])[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points.flatMap((point) => point)), 3));
  return geometry;
}

function addEdgeMarkers(group: Group, markers: readonly EdgeMarker[], material: LineBasicMaterial): void {
  for (const marker of markers) {
    const object = new LineSegments(markerGeometry(marker.points), material);
    object.name = marker.regionId;
    object.userData.regionId = marker.regionId;
    object.renderOrder = 10;
    group.add(object);
  }
}

function addDegenerateMarkers(group: Group, markers: readonly TriangleMarker[], material: LineBasicMaterial): void {
  for (const marker of markers) {
    const [a, b, c] = marker.points;
    const object = new LineSegments(markerGeometry([a, b, b, c, c, a]), material);
    object.name = marker.regionId;
    object.userData.regionId = marker.regionId;
    object.renderOrder = 10;
    group.add(object);
  }
}

function addDuplicateMarkers(group: Group, markers: readonly TriangleMarker[], material: MeshBasicMaterial): void {
  for (const marker of markers) {
    const object = new Mesh(markerGeometry(marker.points), material);
    object.name = marker.regionId;
    object.userData.regionId = marker.regionId;
    object.renderOrder = 10;
    group.add(object);
  }
}

function frame(camera: PerspectiveCamera, controls: OrbitControls, object: Object3D): void {
  const box = new Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3()).length();
  controls.target.copy(center);
  camera.position.copy(center).add(new Vector3(size || 10, size * 0.7 || 7, size || 10));
  camera.near = Math.max(size / 10_000, 0.01);
  camera.far = Math.max(size * 100, 1_000);
  camera.updateProjectionMatrix();
  controls.update();
}

export function createSceneController(host: HTMLElement): SceneController {
  const scene = new Scene();
  scene.background = new Color('#f8fafc');
  const camera = new PerspectiveCamera(45, 1, 0.01, 10_000);
  const renderer = new WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new AmbientLight('#ffffff', 1.4));
  const light = new DirectionalLight('#ffffff', 2.2);
  light.position.set(4, 7, 6);
  scene.add(light);

  const modelGroup = new Group();
  const partGroup = new Group();
  const engravingGroup = new Group();
  const problemGroup = new Group();
  scene.add(modelGroup, partGroup, engravingGroup, problemGroup);
  const warmGeometry = new BufferGeometry();
  warmGeometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0]), 3));
  const warmMaterial = new MeshBasicMaterial({ color: '#94a3b8', side: DoubleSide });
  const warmMesh = new Mesh(warmGeometry, warmMaterial);
  scene.add(warmMesh);
  renderer.compile(scene, camera);
  scene.remove(warmMesh);
  warmGeometry.dispose();
  warmMaterial.dispose();
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let selectedPartId: string | undefined;
  let explodedAmount = 0;
  let disposed = false;

  const applyExploded = (): void => {
    partGroup.children.forEach((object, index) => {
      const baseZ = typeof object.userData.baseZ === 'number' ? object.userData.baseZ : 0;
      const direction = Math.sign(baseZ) || (index % 2 === 0 ? -1 : 1);
      object.position.z = baseZ + direction * explodedAmount * 20;
    });
  };

  const resize = (): void => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  const selectPart = (id: string | undefined): void => {
    selectedPartId = id;
    partGroup.traverse((object) => {
      if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) return;
      object.material.emissive.set(object.userData.partId === id ? '#fbbf24' : '#000000');
    });
  };
  const onPointerDown = (event: PointerEvent): void => {
    const bounds = renderer.domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(partGroup.children, true)[0]?.object;
    selectPart(typeof hit?.userData.partId === 'string' ? hit.userData.partId : undefined);
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  return {
    setMesh(mesh) {
      disposeObject(modelGroup);
      if (!mesh) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
      geometry.setIndex(new BufferAttribute(new Uint32Array(mesh.indices), 1));
      modelGroup.add(new Mesh(geometry, new MeshBasicMaterial({ color: '#94a3b8', side: DoubleSide })));
      frame(camera, controls, modelGroup);
    },
    setParts(kit) {
      disposeObject(partGroup);
      if (!kit) return;
      const parts = new Map(kit.parts.map((part) => [part.id, part]));
      for (const instance of kit.instances) {
        const part = parts.get(instance.partId);
        if (!part) continue;
        const shape = shapeFromPolygon(part.outline);
        for (const hole of part.holes) shape.holes.push(shapeFromPolygon(hole));
        const object = new Mesh(
          new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false }),
          new MeshStandardMaterial({ color: PART_COLORS[part.kind], roughness: 0.7 }),
        );
        object.name = instance.id;
        object.userData = { partId: part.id, baseZ: instance.axialZ, angleRad: instance.angleRad ?? 0 };
        object.position.z = instance.axialZ;
        object.rotation.z = instance.angleRad ?? 0;
        partGroup.add(object);
      }
      selectPart(selectedPartId);
      applyExploded();
      frame(camera, controls, partGroup);
    },
    setExploded(amount) {
      explodedAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
      applyExploded();
    },
    setEngraving(map) {
      disposeObject(engravingGroup);
      if (!map) return;
      for (const [index, region] of map.regions.entries()) {
        const geometry = new ExtrudeGeometry(shapeFromPolygon(region.polygon), { depth: 0.05, bevelEnabled: false });
        const object = new Mesh(geometry, new MeshStandardMaterial({ color: engravingLevelColor(region.level, map.levels), transparent: true, opacity: 0.82 }));
        object.position.z = 1.05;
        object.name = `engraving-region-${index}`;
        object.userData.regionId = object.name;
        engravingGroup.add(object);
      }
    },
    setMeshProblems(report) {
      disposeObject(problemGroup);
      if (!report) return;

      if (report.boundaryEdges.length > 0) {
        addEdgeMarkers(problemGroup, report.boundaryEdges, new LineBasicMaterial({ color: '#ef4444', depthTest: false }));
      }
      if (report.nonManifoldEdges.length > 0) {
        addEdgeMarkers(problemGroup, report.nonManifoldEdges, new LineBasicMaterial({ color: '#d946ef', depthTest: false }));
      }
      if (report.degenerateTriangles.length > 0) {
        addDegenerateMarkers(problemGroup, report.degenerateTriangles, new LineBasicMaterial({ color: '#f97316', depthTest: false }));
      }
      if (report.duplicateTriangles.length > 0) {
        addDuplicateMarkers(problemGroup, report.duplicateTriangles, new MeshBasicMaterial({
          color: '#facc15',
          depthTest: false,
          depthWrite: false,
          opacity: 0.48,
          side: DoubleSide,
          transparent: true,
        }));
      }
    },
    selectPart,
    focusRegion(id) {
      let target = scene.getObjectByName(id);
      if (!target) scene.traverse((object) => {
        if (!target && object.userData.regionId === id) target = object;
      });
      if (target) frame(camera, controls, target);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      resizeObserver.disconnect();
      controls.dispose();
      disposeObject(modelGroup);
      disposeObject(partGroup);
      disposeObject(engravingGroup);
      disposeObject(problemGroup);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
