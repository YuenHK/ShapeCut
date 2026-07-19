import type { AxisCandidate } from '../domain/axis/find-axis';
import { useEffect, useMemo, useRef } from 'react';
import { ProjectRepository, sha256Hex } from '../persistence/project-repository';
import { createGeometryWorkerClient, type GeometryClient } from '../workers/geometry-client';
import { Wizard, type WizardServices } from './Wizard';

const suggestedAxis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: false,
  radialRmsError: 0, centroidOffset: 0, source: 'inertia',
};

type AppGeometryClient = Pick<GeometryClient,
  'analyzeAndRepairForImport' | 'repairAdvanced' | 'serializeSTL' | 'findAxes'
>;
type PackageBuilder = (typeof import('../export/package'))['buildPackage'];

export type AppServiceDependencies = {
  readonly getGeometry: () => AppGeometryClient;
  readonly fingerprint?: typeof sha256Hex;
  readonly packageBuilder?: PackageBuilder;
};

export function createAppServices({
  getGeometry,
  fingerprint = sha256Hex,
  packageBuilder = async (project) => {
    const { buildPackage } = await import('../export/package');
    return buildPackage(project);
  },
}: AppServiceDependencies): WizardServices {
  let latestImportRequest = 0;
  return {
    inspectAndRepair: async (file) => {
      const request = ++latestImportRequest;
      const input = await file.arrayBuffer();
      if (request !== latestImportRequest) throw new Error('Import request was superseded');

      // Start hashing and the worker job without awaiting either. Worker submission
      // therefore follows file-selection order, never fingerprint completion order.
      const fingerprintPromise = fingerprint(input);
      const analysisPromise = getGeometry().analyzeAndRepairForImport(input);
      const [sourceSha256, analysis] = await Promise.all([fingerprintPromise, analysisPromise]);
      const candidates = analysis.safeRepair.accepted && analysis.candidates.length === 0
        ? [suggestedAxis]
        : analysis.candidates;
      return { ...analysis, candidates, sourceSha256 };
    },
    advancedRepair: async (original, safeMesh) => {
      const geometry = getGeometry();
      const repair = await geometry.repairAdvanced(original, safeMesh);
      if (!repair.accepted) return repair;
      const candidates = await geometry.findAxes({
        positions: repair.mesh.positions.slice(),
        indices: repair.mesh.indices.slice(),
      });
      return { ...repair, candidates: candidates.length > 0 ? candidates : [suggestedAxis] };
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
    decompose: async () => ({ issues: [] }),
    engrave: async (settings) => settings.materialId === 'cork-3' || settings.materialId === 'cardboard-2' ? ({ issues: [{ id: 'uncalibrated-material', regionId: 'material-profile', severity: 'confirm', label: '材料未校準', description: '必須先完成實體測試片校準。' }] }) : ({ issues: [] }),
    preflight: async (settings) => settings.materialId === 'cork-3' || settings.materialId === 'cardboard-2' ? ({ issues: [{ id: 'uncalibrated-material', regionId: 'material-profile', severity: 'confirm', label: '材料未校準', description: '必須先完成實體測試片校準。' }] }) : ({ issues: [] }),
    exportKit: async (settings, sourceSha256) => {
      const size = Math.min(settings.sheetWidthMm, settings.sheetHeightMm, 40);
      const polygon = { points: [[10, 10], [10 + size, 10], [10 + size, 10 + size], [10, 10 + size]] as const };
      const files = await packageBuilder({ schemaVersion: 1, name: 'spinner', sourceSha256, settings, document: { unit: 'mm', sheets: [{ width: settings.sheetWidthMm, height: settings.sheetHeightMm, entities: [{ id: 'spinner-cut', partId: 'spinner-part', layer: 'CUT', polygon }] }], manifest: [{ partId: 'spinner-part', quantity: 1, assemblyOrder: 1 }] } });
      const url = URL.createObjectURL(new Blob([files.zip as BlobPart], { type: 'application/zip' }));
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
