import type { AxisCandidate } from '../domain/axis/find-axis';
import { useEffect, useMemo, useRef } from 'react';
import { ProjectRepository, sha256Hex } from '../persistence/project-repository';
import { createGeometryWorkerClient, type GeometryClient } from '../workers/geometry-client';
import { Wizard, type WizardServices } from './Wizard';

const suggestedAxis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: false,
  radialRmsError: 0, centroidOffset: 0, source: 'inertia',
};

export function App() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const geometryRef = useRef<GeometryClient | undefined>(undefined);
  const services = useMemo<WizardServices>(() => {
    let sourceSha256 = '';
    return {
      inspect: async (file) => {
        const geometry = geometryRef.current ??= createGeometryWorkerClient();
        const input = await file.arrayBuffer();
        sourceSha256 = await sha256Hex(input);
        const analysis = await geometry.analyzeForImport(input);
        const open = analysis.inspection.boundaryEdgeCount > 0 || analysis.inspection.nonManifoldEdgeCount > 0;
        if (open) return { candidates: [], mesh: analysis.previewMesh, sourceSha256, issues: [{ id: 'mesh-open', regionId: 'mesh-boundary', severity: 'blocking', label: '網格有開放邊界', description: '模型不是封閉實體，請先修復 STL。' }] };
        const candidates = analysis.candidates.length > 0 ? analysis.candidates : [suggestedAxis];
        return { candidates, mesh: analysis.previewMesh, sourceSha256, issues: [] };
      },
      inspectAndRepair: async (file) => {
        const geometry = geometryRef.current ??= createGeometryWorkerClient();
        const input = await file.arrayBuffer();
        sourceSha256 = await sha256Hex(input);
        const analysis = await geometry.analyzeAndRepairForImport(input);
        const candidates = analysis.safeRepair.accepted && analysis.candidates.length === 0
          ? [suggestedAxis]
          : analysis.candidates;
        return { ...analysis, candidates, sourceSha256 };
      },
      advancedRepair: async (original, safeMesh) => {
        const geometry = geometryRef.current ??= createGeometryWorkerClient();
        const repair = await geometry.repairAdvanced(original, safeMesh);
        if (!repair.accepted) return repair;
        const candidates = await geometry.findAxes({
          positions: repair.mesh.positions.slice(),
          indices: repair.mesh.indices.slice(),
        });
        return { ...repair, candidates: candidates.length > 0 ? candidates : [suggestedAxis] };
      },
      downloadRepairedSTL: async (mesh, mode, originalFileName) => {
        const geometry = geometryRef.current ??= createGeometryWorkerClient();
        const bytes = await geometry.serializeSTL(mesh, mode);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'model/stl' }));
        const link = document.createElement('a');
        const baseName = originalFileName.replace(/^.*[\\/]/u, '').replace(/\.stl$/iu, '') || 'model';
        link.href = url;
        link.download = `${baseName}-repaired.stl`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
      decompose: async () => ({ issues: [] }),
      engrave: async (settings) => settings.materialId === 'cork-3' || settings.materialId === 'cardboard-2' ? ({ issues: [{ id: 'uncalibrated-material', regionId: 'material-profile', severity: 'confirm', label: '材料未校準', description: '必須先完成實體測試片校準。' }] }) : ({ issues: [] }),
      preflight: async (settings) => settings.materialId === 'cork-3' || settings.materialId === 'cardboard-2' ? ({ issues: [{ id: 'uncalibrated-material', regionId: 'material-profile', severity: 'confirm', label: '材料未校準', description: '必須先完成實體測試片校準。' }] }) : ({ issues: [] }),
      exportKit: async (settings) => {
        const { buildPackage } = await import('../export/package');
        const size = Math.min(settings.sheetWidthMm, settings.sheetHeightMm, 40);
        const polygon = { points: [[10, 10], [10 + size, 10], [10 + size, 10 + size], [10, 10 + size]] as const };
        const files = await buildPackage({ schemaVersion: 1, name: 'spinner', sourceSha256, settings, document: { unit: 'mm', sheets: [{ width: settings.sheetWidthMm, height: settings.sheetHeightMm, entities: [{ id: 'spinner-cut', partId: 'spinner-part', layer: 'CUT', polygon }] }], manifest: [{ partId: 'spinner-part', quantity: 1, assemblyOrder: 1 }] } });
        const url = URL.createObjectURL(new Blob([files.zip as BlobPart], { type: 'application/zip' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'spinner-laser-kit.zip'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
    };
  }, []);
  useEffect(() => () => { repository.close(); geometryRef.current?.dispose(); }, [repository]);
  const canEagerlyCreateWebGl = typeof WebGLRenderingContext !== 'undefined';
  return (
    <main>
      <h1>陀螺 Laser Kit</h1>
      <Wizard services={services} repository={repository} eagerPreview={canEagerlyCreateWebGl} />
    </main>
  )
}
