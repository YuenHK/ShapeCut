import type { AxisCandidate } from '../domain/axis/find-axis';
import { useEffect, useMemo, useRef } from 'react';
import { defaultPendingMaterialProfile } from '../domain/materials/default-profiles';
import type { MaterialProfileV1 } from '../domain/materials/schema';
import { createManufacturingArtifacts } from '../domain/pipeline/manufacturing-pipeline';
import { ProjectRepository, sha256Hex } from '../persistence/project-repository';
import { createGeometryWorkerClient, type GeometryClient } from '../workers/geometry-client';
import { Wizard, type WizardServices } from './Wizard';

const suggestedAxis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: false,
  radialRmsError: 0, centroidOffset: 0, source: 'inertia',
};

type AppGeometryClient = Pick<GeometryClient,
  'analyzeAndRepairForImport' | 'repairAdvanced' | 'serializeSTL' | 'findAxes' | 'decompose' | 'engrave'
>;
type PackageBuilder = (typeof import('../export/package'))['buildPackage'];

export type AppServiceDependencies = {
  readonly getGeometry: () => AppGeometryClient;
  readonly fingerprint?: typeof sha256Hex;
  readonly packageBuilder?: PackageBuilder;
  readonly getMaterial?: (id: string) => Promise<MaterialProfileV1 | undefined>;
};

export function createAppServices({
  getGeometry,
  fingerprint = sha256Hex,
  packageBuilder = async (project) => {
    const { buildPackage } = await import('../export/package');
    return buildPackage(project);
  },
  getMaterial = async (id) => defaultPendingMaterialProfile(id),
}: AppServiceDependencies): WizardServices {
  let latestImportRequest = 0;
  return {
    inspectAndRepair: async (file) => {
      const request = ++latestImportRequest;
      const geometry = getGeometry();
      const input = await file.arrayBuffer();
      if (request !== latestImportRequest) throw new Error('Import request was superseded');

      // Start hashing and the worker job without awaiting either. Worker submission
      // therefore follows file-selection order, never fingerprint completion order.
      const fingerprintPromise = fingerprint(input);
      const analysisPromise = geometry.analyzeAndRepairForImport(input);
      const [sourceSha256, analysis] = await Promise.all([fingerprintPromise, analysisPromise]);
      const meshSha256 = await fingerprintMesh(analysis.safeRepair.mesh, fingerprint);
      const candidates = analysis.safeRepair.accepted && analysis.candidates.length === 0
        ? [suggestedAxis]
        : analysis.candidates;
      return {
        ...analysis,
        candidates,
        sourceSha256,
        meshSha256,
        repairProvenance: { mode: 'safe', algorithmVersion: 'safe-repair-v1' },
      };
    },
    advancedRepair: async (original, safeMesh) => {
      const geometry = getGeometry();
      const repair = await geometry.repairAdvanced(original, safeMesh);
      const meshSha256 = await fingerprintMesh(repair.mesh, fingerprint);
      const repairProvenance = { mode: 'advanced' as const, algorithmVersion: 'advanced-repair-v1' };
      if (!repair.accepted) return { ...repair, meshSha256, repairProvenance };
      const candidates = await geometry.findAxes({
        positions: repair.mesh.positions.slice(),
        indices: repair.mesh.indices.slice(),
      });
      return { ...repair, candidates: candidates.length > 0 ? candidates : [suggestedAxis], meshSha256, repairProvenance };
    },
    serializeRepairedSTL: (mesh, mode) => getGeometry().serializeSTL(mesh, mode),
    downloadRepairedSTL: async (bytes, originalFileName) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'model/stl' }));
      try {
        const link = document.createElement('a');
        const baseName = originalFileName.replace(/^.*[\\/]/u, '').replace(/\.stl$/iu, '') || 'model';
        link.href = url;
        link.download = `${baseName}-repaired.stl`;
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    },
    createArtifacts: async (input) => {
      const material = await getMaterial(input.settings.materialId);
      if (!material) throw new Error(`找不到完整材料設定檔：${input.settings.materialId}`);
      return createManufacturingArtifacts({ ...input, material }, getGeometry());
    },
    buildKit: async (artifacts) => {
      if (!artifacts.preflight.value.canExport) throw new Error('真實加工前檢查未通過，不能建立 production 製作套件');
      const stages = [artifacts.profile, artifacts.kit, artifacts.material, artifacts.engraving, artifacts.layout, artifacts.preflight, artifacts.document];
      if (stages.some((stage) => stage.provenance.inputFingerprint !== artifacts.provenance.inputFingerprint)
        || artifacts.document.value.provenance.inputFingerprint !== artifacts.provenance.inputFingerprint) {
        throw new Error('製作 artifacts 與當前 pipeline 版本不一致');
      }
      const files = await packageBuilder({
        schemaVersion: 1,
        name: 'spinner',
        sourceSha256: artifacts.provenance.sourceSha256,
        provenance: { inputFingerprint: artifacts.provenance.inputFingerprint },
        preflight: {
          inputFingerprint: artifacts.provenance.inputFingerprint,
          canExport: artifacts.preflight.value.canExport,
          issues: artifacts.preflight.value.issues.map(({ code, severity, message }) => ({ code, severity, message })),
          acceptedConfirmations: [],
          materialReadiness: artifacts.material.value.readiness,
          materialProfile: artifacts.material.value.profile,
          physicalApproval: artifacts.material.value.readiness.status === 'ready' ? 'approved' : 'pending',
        },
        settings: {
          inputFingerprint: artifacts.provenance.inputFingerprint,
          materialFingerprint: artifacts.provenance.materialFingerprint,
          repair: artifacts.provenance.repair,
        },
        document: artifacts.document.value,
      });
      return files.zip;
    },
    downloadKit: async (zip) => {
      const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = 'spinner-laser-kit.zip';
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    },
  };
}

async function fingerprintMesh(mesh: { readonly positions: Float64Array; readonly indices: Uint32Array }, fingerprint: typeof sha256Hex): Promise<string> {
  const [positionsHash, indicesHash] = await Promise.all([fingerprint(mesh.positions), fingerprint(mesh.indices)]);
  return fingerprint(new TextEncoder().encode(`${positionsHash}:${indicesHash}`));
}

export function App() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const geometryRef = useRef<GeometryClient | undefined>(undefined);
  const services = useMemo<WizardServices>(() => createAppServices({
    getGeometry: () => geometryRef.current ??= createGeometryWorkerClient(),
  }), []);
  useEffect(() => () => { repository.close(); geometryRef.current?.dispose(); }, [repository]);
  const canEagerlyCreateWebGl = typeof WebGLRenderingContext !== 'undefined';
  return (
    <main>
      <h1>陀螺 Laser Kit</h1>
      <Wizard services={services} repository={repository} eagerPreview={canEagerlyCreateWebGl} />
    </main>
  );
}
