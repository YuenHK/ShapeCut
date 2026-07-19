import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AxisCandidate } from '../domain/axis/find-axis';
import type { MeshProblemReport, MeshRepairResult, TriangleMesh } from '../domain/mesh/types';
import type {
  ManufacturingArtifacts,
  ManufacturingPipelineInput,
  RepairProvenanceV1,
} from '../domain/pipeline/manufacturing-pipeline';
import type { WorkflowStep } from '../domain/types';
import type { GeometryIssue } from '../preview/SpinnerViewport';
import { SpinnerViewport } from '../preview/SpinnerViewport';
import type { ImportRepairAnalysis } from '../workers/geometry-api';
import {
  createProjectAutosave,
  SourceFingerprintError,
  type ProjectRepository,
  type StoredProjectV1,
} from '../persistence/project-repository';
import type { MaterialCatalogEntry } from './material-catalog';
import { createProjectStore, type WizardSettings } from './project-store';
import { AxisStep } from './steps/AxisStep';
import { DecompositionStep } from './steps/DecompositionStep';
import { EngravingStep } from './steps/EngravingStep';
import { ExportStep } from './steps/ExportStep';
import { ImportStep, RepairSummary, type ImportBusyAction, type ImportRepairStage } from './steps/ImportStep';

type RepairImportResult = ImportRepairAnalysis & {
  readonly sourceSha256: string;
  readonly meshSha256: string;
  readonly repairProvenance: RepairProvenanceV1;
};
type AdvancedRepairResult = MeshRepairResult & {
  readonly candidates?: readonly AxisCandidate[];
  readonly meshSha256: string;
  readonly repairProvenance: RepairProvenanceV1;
};
type ManufacturingArtifactRequest = Omit<ManufacturingPipelineInput, 'material'>;

export type WizardServices = {
  cancelGeometry(): void;
  listMaterials(): Promise<readonly MaterialCatalogEntry[]>;
  saveMaterialJson(source: string): Promise<MaterialCatalogEntry>;
  inspectAndRepair(file: File): Promise<RepairImportResult>;
  advancedRepair(original: TriangleMesh, safeMesh: TriangleMesh): Promise<AdvancedRepairResult>;
  serializeRepairedSTL(mesh: TriangleMesh, mode: 'safe' | 'advanced'): Promise<ArrayBuffer>;
  downloadRepairedSTL(bytes: ArrayBuffer, originalFileName: string): Promise<void>;
  createArtifacts(input: ManufacturingArtifactRequest): Promise<ManufacturingArtifacts>;
  buildKit(artifacts: ManufacturingArtifacts): Promise<Uint8Array>;
  downloadKit(zip: Uint8Array): Promise<void>;
};

const steps: readonly { id: WorkflowStep; label: string }[] = [
  { id: 'import', label: '匯入與修復' },
  { id: 'axis', label: '軸心與尺寸' },
  { id: 'decomposition', label: '自動拆件' },
  { id: 'engraving', label: '紋理與材料' },
  { id: 'export', label: '排版與輸出' },
];

export function Wizard({ services, repository, eagerPreview = false }: { readonly services: WizardServices; readonly repository?: ProjectRepository; readonly eagerPreview?: boolean }) {
  const store = useMemo(createProjectStore, []);
  const state = useStore(store);
  const selectionVersion = useRef(0);
  const [file, setFile] = useState<File>();
  const [analysis, setAnalysis] = useState<RepairImportResult>();
  const [advancedRepair, setAdvancedRepair] = useState<AdvancedRepairResult>();
  const [repairStage, setRepairStage] = useState<ImportRepairStage>('original');
  const [advancedConsent, setAdvancedConsent] = useState(false);
  const [candidates, setCandidates] = useState<readonly AxisCandidate[]>([]);
  const [issues, setIssues] = useState<readonly GeometryIssue[]>([]);
  const [busyAction, setBusyAction] = useState<ImportBusyAction>();
  const [furthestStep, setFurthestStep] = useState(0);
  const [sourceSha256, setSourceSha256] = useState<string>();
  const [meshSha256, setMeshSha256] = useState<string>();
  const [repairProvenance, setRepairProvenance] = useState<RepairProvenanceV1>();
  const [mesh, setMesh] = useState<TriangleMesh>();
  const [artifacts, setArtifacts] = useState<ManufacturingArtifacts>();
  const [operationError, setOperationError] = useState<string>();
  const [savedProjects, setSavedProjects] = useState<readonly StoredProjectV1[]>([]);
  const [selectedSavedProjectId, setSelectedSavedProjectId] = useState('');
  const [pendingProject, setPendingProject] = useState<StoredProjectV1>();
  const [materials, setMaterials] = useState<readonly MaterialCatalogEntry[]>([]);
  const [materialJson, setMaterialJson] = useState('');
  const [materialStatus, setMaterialStatus] = useState<string>();

  useEffect(() => () => services.cancelGeometry(), [services]);

  useEffect(() => {
    let active = true;
    void services.listMaterials().then((entries) => {
      if (active) setMaterials(entries);
    }).catch((error) => {
      if (active) setOperationError(error instanceof Error ? error.message : '無法讀取材料設定檔');
    });
    return () => { active = false; };
  }, [services]);

  useEffect(() => {
    if (!repository) return;
    let active = true;
    void repository.list().then((projects) => {
      if (!active) return;
      setSavedProjects(projects);
      setSelectedSavedProjectId((current) => current || projects[0]?.id || '');
    }).catch((error) => {
      if (active) store.getState().setPersistenceError(error instanceof Error ? error.message : '無法讀取已儲存專案');
    });
    return () => { active = false; };
  }, [repository, store]);

  useEffect(() => {
    if (!repository || !sourceSha256) return;
    const autosave = createProjectAutosave(repository, (message) => store.getState().setPersistenceError(message));
    let lastSnapshot = '';
    const schedule = () => {
      const current = store.getState();
      const repair = meshSha256 && repairProvenance ? { ...repairProvenance, meshSha256 } : undefined;
      if (current.step !== 'import' && !repair) return;
      const snapshotKey = JSON.stringify({ id: current.id, name: current.name, step: current.step, axis: current.axis, settings: current.settings, sourceSha256, repair });
      if (snapshotKey === lastSnapshot) return;
      lastSnapshot = snapshotKey;
      autosave.schedule({ schemaVersion: 1, id: current.id, name: current.name, step: current.step, axis: current.axis, settings: current.settings, sourceSha256, repair, updatedAt: new Date().toISOString() });
    };
    schedule();
    const unsubscribe = store.subscribe(schedule);
    return () => { unsubscribe(); autosave.dispose(); };
  }, [meshSha256, repairProvenance, repository, sourceSha256, store]);

  const execute = async (
    action: ImportBusyAction,
    operation: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> => {
    if (busyAction) return;
    const version = selectionVersion.current;
    const isCurrent = () => selectionVersion.current === version;
    setBusyAction(action);
    setOperationError(undefined);
    try { await operation(isCurrent); }
    catch (error) {
      if (isCurrent()) setOperationError(error instanceof Error ? error.message : '操作失敗');
    }
    finally {
      if (isCurrent()) setBusyAction(undefined);
    }
  };
  const resetGeometryState = (nextFile: File | undefined): void => {
    setFile(nextFile);
    setAnalysis(undefined);
    setAdvancedRepair(undefined);
    setRepairStage('original');
    setAdvancedConsent(false);
    setCandidates([]);
    setIssues([]);
    setBusyAction(undefined);
    setFurthestStep(0);
    setSourceSha256(undefined);
    setMeshSha256(undefined);
    setRepairProvenance(undefined);
    setMesh(undefined);
    setArtifacts(undefined);
    setOperationError(undefined);
    store.setState({ axis: undefined });
    store.getState().goToStep('import');
  };
  const selectFile = (nextFile: File | undefined): void => {
    services.cancelGeometry();
    selectionVersion.current += 1;
    resetGeometryState(nextFile);
  };

  const loadSavedProject = (): void => {
    if (!repository || !selectedSavedProjectId) return;
    services.cancelGeometry();
    const version = ++selectionVersion.current;
    setBusyAction('workflow');
    setOperationError(undefined);
    void repository.get(selectedSavedProjectId).then((project) => {
      if (selectionVersion.current !== version) return;
      if (!project) throw new Error('找不到已儲存專案');
      resetGeometryState(undefined);
      setPendingProject(project);
      store.getState().loadProject(project);
    }).catch((error) => {
      if (selectionVersion.current === version) {
        setOperationError(error instanceof Error ? error.message : '無法開啟已儲存專案');
        setBusyAction(undefined);
      }
    });
  };

  const analyzeFile = (): void => {
    const selectedFile = file;
    if (!selectedFile) return;
    void execute('analyze', async (isCurrent) => {
      const reopening = pendingProject;
      if (reopening) {
        if (!repository) throw new Error('專案資料庫不可用，不能驗證原始 STL');
        try {
          await repository.attachSource(reopening.id, selectedFile);
        } catch (error) {
          if (error instanceof SourceFingerprintError || (error instanceof Error && error.message === 'STL fingerprint mismatch')) {
            throw new Error('原始 STL 指紋不符；專案仍停留在匯入步驟');
          }
          throw error;
        }
        if (!isCurrent()) return;
      }
      const result = await services.inspectAndRepair(selectedFile);
      if (!isCurrent()) return;
      if (reopening && result.sourceSha256 !== reopening.sourceSha256) {
        throw new Error('原始 STL 指紋不符；重新分析結果與專案記錄不一致');
      }

      let acceptedRepair: MeshRepairResult = result.safeRepair;
      let acceptedMeshSha256 = result.meshSha256;
      let acceptedProvenance: RepairProvenanceV1 = result.repairProvenance;
      let acceptedCandidates = result.candidates;
      let acceptedStage: Exclude<ImportRepairStage, 'original'> = 'safe';
      let replayedAdvanced: AdvancedRepairResult | undefined;
      if (reopening?.repair?.mode === 'advanced') {
        replayedAdvanced = await services.advancedRepair(result.originalMesh, result.safeRepair.mesh);
        if (!isCurrent()) return;
        acceptedRepair = replayedAdvanced;
        acceptedMeshSha256 = replayedAdvanced.meshSha256;
        acceptedProvenance = replayedAdvanced.repairProvenance;
        acceptedCandidates = replayedAdvanced.candidates ?? [];
        acceptedStage = 'advanced';
      }
      if (reopening?.repair && (
        !acceptedRepair.accepted
        || acceptedMeshSha256 !== reopening.repair.meshSha256
        || acceptedProvenance.mode !== reopening.repair.mode
        || acceptedProvenance.algorithmVersion !== reopening.repair.algorithmVersion
      )) {
        throw new Error('已儲存的修復結果與重新分析不一致；專案仍停留在匯入步驟');
      }

      setAnalysis(result);
      setAdvancedRepair(replayedAdvanced);
      setRepairStage(acceptedStage);
      setAdvancedConsent(false);
      setCandidates(acceptedCandidates);
      setSourceSha256(result.sourceSha256);
      setIssues(issuesFromReport(acceptedRepair.after));
      if (!acceptedRepair.accepted) {
        setMesh(undefined);
        setMeshSha256(undefined);
        setRepairProvenance(undefined);
        setFurthestStep(0);
        store.getState().goToStep('import');
        return;
      }
      setMesh(acceptedRepair.mesh);
      setMeshSha256(acceptedMeshSha256);
      setRepairProvenance(acceptedProvenance);
      if (reopening?.repair) {
        setPendingProject(undefined);
        const resumedStep = store.getState().resumeVerifiedProject(reopening);
        setFurthestStep(resumedStep === 'decomposition' ? 2 : 1);
        return;
      }
      if (reopening) setPendingProject(undefined);
      setFurthestStep(1);
      store.getState().goToStep('axis');
    });
  };

  const currentRepair = repairStage === 'safe' ? analysis?.safeRepair : repairStage === 'advanced' ? advancedRepair : undefined;
  const currentReport = repairStage === 'original' ? analysis?.originalReport : currentRepair?.after;
  const repairPreview = useMemo(
    () => repairStage === 'original'
      ? analysis?.originalPreview
      : currentRepair ? compactPreview(currentRepair.mesh) : undefined,
    [analysis?.originalPreview, currentRepair, repairStage],
  );
  const acceptedPreview = useMemo(() => mesh ? compactPreview(mesh) : undefined, [mesh]);

  const previewRepair = (stage: Exclude<ImportRepairStage, 'original'>): void => {
    const result = stage === 'safe' ? analysis?.safeRepair : advancedRepair;
    if (!result) return;
    setRepairStage(stage);
    setIssues(issuesFromReport(result.after));
  };

  const restoreOriginal = (): void => {
    if (!analysis) return;
    setRepairStage('original');
    setMesh(undefined);
    setMeshSha256(undefined);
    setRepairProvenance(undefined);
    setArtifacts(undefined);
    setCandidates([]);
    setIssues(issuesFromReport(analysis.originalReport));
    setFurthestStep(0);
    store.setState({ axis: undefined });
    state.goToStep('import');
  };

  const useCurrentRepair = (): void => {
    if (!currentRepair?.accepted || !analysis) return;
    const nextCandidates = repairStage === 'safe' ? analysis.candidates : advancedRepair?.candidates ?? [];
    setMesh(currentRepair.mesh);
    if (repairStage === 'safe') {
      setMeshSha256(analysis.meshSha256);
      setRepairProvenance(analysis.repairProvenance);
    } else if (advancedRepair) {
      setMeshSha256(advancedRepair.meshSha256);
      setRepairProvenance(advancedRepair.repairProvenance);
    }
    setArtifacts(undefined);
    setCandidates(nextCandidates);
    setIssues(issuesFromReport(currentRepair.after));
    setFurthestStep(1);
    state.goToStep('axis');
  };

  const artifactRequest = (): ManufacturingArtifactRequest => {
    const current = store.getState();
    if (!sourceSha256 || !meshSha256 || !repairProvenance || !mesh || !current.axis?.confirmed || !currentRepair?.accepted) {
      throw new Error('缺少已接受網格、修復 provenance 或已確認軸心');
    }
    return {
      sourceSha256,
      meshSha256,
      mesh,
      meshInspection: currentRepair.after.inspection,
      repair: repairProvenance,
      axis: current.axis,
      settings: { ...current.settings },
    };
  };

  const ownsCurrentManufacturingInput = (version: string): boolean => {
    try { return manufacturingRequestVersion(artifactRequest()) === version; }
    catch { return false; }
  };

  const updateSettings = (changes: Partial<WizardSettings>): void => {
    store.getState().updateSettings(changes);
    setArtifacts(undefined);
    setIssues([]);
  };

  const loadSelectedMaterialJson = (): void => {
    const selected = materials.find(({ profile }) => profile.id === store.getState().settings.materialId);
    if (!selected) {
      setOperationError('找不到所選材料設定檔');
      return;
    }
    setOperationError(undefined);
    setMaterialJson(JSON.stringify(selected.profile, null, 2));
    setMaterialStatus(`已載入材料設定檔：${selected.profile.materialName}`);
  };

  const saveMaterialJson = (): void => {
    const source = materialJson;
    void execute('workflow', async (isCurrent) => {
      const saved = await services.saveMaterialJson(source);
      const refreshed = await services.listMaterials();
      if (!isCurrent()) return;
      setMaterials(refreshed);
      updateSettings({ materialId: saved.profile.id });
      setMaterialJson(JSON.stringify(saved.profile, null, 2));
      setMaterialStatus(`已儲存並選取材料設定檔：${saved.profile.materialName}`);
    });
  };

  const navigateToStep = (target: WorkflowStep): void => {
    if (busyAction) {
      if (target !== 'import') return;
      services.cancelGeometry();
      selectionVersion.current += 1;
      setBusyAction(undefined);
      setArtifacts(undefined);
      setIssues([]);
    }
    store.getState().goToStep(target);
  };

  return (
    <div className="wizard">
      {repository && <section aria-labelledby="saved-projects-title">
        <h2 id="saved-projects-title">已儲存專案</h2>
        <label>開啟已儲存專案
          <select value={selectedSavedProjectId} onChange={(event) => setSelectedSavedProjectId(event.currentTarget.value)}>
            <option value="">選擇專案</option>
            {savedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <button type="button" disabled={!selectedSavedProjectId || busyAction !== undefined} onClick={loadSavedProject}>載入專案</button>
        {pendingProject && <p role="status">請重新附加原始 STL 並重新分析。預期 SHA-256：{pendingProject.sourceSha256}。驗證完成前不會復原後續步驟。</p>}
      </section>}
      {state.persistenceError && <p role="alert">專案儲存失敗：{state.persistenceError}</p>}
      {operationError && <p role="alert">操作失敗：{operationError}</p>}
      {issues.length > 0 && state.step !== 'export' && <div role="alert">{issues.map((issue) => <p key={issue.id}>{issue.label}：{issue.description}</p>)}</div>}
      {(eagerPreview || repairPreview || acceptedPreview) && <SpinnerViewport mesh={state.step === 'import' ? repairPreview : acceptedPreview} meshProblems={currentReport} issues={issues} />}
      <nav aria-label="轉換步驟"><ol>{steps.map(({ id, label }, index) => <li key={id}><button type="button" disabled={(busyAction !== undefined && id !== 'import') || index > furthestStep} aria-current={state.step === id ? 'step' : undefined} onClick={() => navigateToStep(id)}>{label}</button></li>)}</ol></nav>
      {state.step !== 'import' && analysis && currentRepair && <RepairSummary stage={repairStage} originalReport={analysis.originalReport} repair={currentRepair} />}
      {state.step === 'import' && <ImportStep
        file={file}
        busyAction={busyAction}
        stage={repairStage}
        originalReport={analysis?.originalReport}
        safeRepair={analysis?.safeRepair}
        advancedRepair={advancedRepair}
        advancedConsent={advancedConsent}
        onFile={selectFile}
        onAnalyze={analyzeFile}
        onAdvancedConsent={setAdvancedConsent}
        onAdvancedRepair={() => {
          if (!analysis || !advancedConsent) return;
          void execute('advanced', async (isCurrent) => {
            const result = await services.advancedRepair(analysis.originalMesh, analysis.safeRepair.mesh);
            if (!isCurrent()) return;
            setAdvancedRepair(result);
            setRepairStage('advanced');
            setAdvancedConsent(false);
            setIssues(issuesFromReport(result.after));
          });
        }}
        onRestore={restoreOriginal}
        onPreview={previewRepair}
        onUseRepair={useCurrentRepair}
        onDownload={() => {
          if (!file || !currentRepair) return;
          void execute('download', async (isCurrent) => {
            const bytes = await services.serializeRepairedSTL(currentRepair.mesh, currentRepair.mode);
            if (!isCurrent()) return;
            await services.downloadRepairedSTL(bytes, file.name);
          });
        }}
      />}
      {state.step === 'axis' && <><h2>軸心與尺寸</h2><AxisStep candidates={candidates} confirmedAxis={state.axis} onConfirm={(candidate) => state.setAxis({ ...candidate, confirmed: true })} onAxisInvalidated={() => store.setState({ axis: undefined })} onNext={() => {
        if (state.goToStep('decomposition')) setFurthestStep((value) => Math.max(value, 2));
      }} /></>}
      {state.step === 'decomposition' && <DecompositionStep settings={state.settings} busy={busyAction !== undefined} onChange={updateSettings} onAccept={() => void execute('workflow', async (isCurrent) => {
        const request = artifactRequest();
        const requestVersion = manufacturingRequestVersion(request);
        const result = await services.createArtifacts(request);
        if (!isCurrent() || !ownsCurrentManufacturingInput(requestVersion)) return;
        assertCoherentArtifacts(result);
        setArtifacts(result);
        setIssues(preflightIssues(result));
        if (state.goToStep('engraving')) setFurthestStep((value) => Math.max(value, 3));
      })} />}
      {state.step === 'engraving' && <EngravingStep
        settings={state.settings}
        busy={busyAction !== undefined}
        materials={materials}
        materialJson={materialJson}
        materialStatus={materialStatus}
        onMaterialJson={setMaterialJson}
        onLoadMaterialJson={loadSelectedMaterialJson}
        onSaveMaterialJson={saveMaterialJson}
        onChange={(changes) => {
          setMaterialStatus(undefined);
          updateSettings(changes);
        }}
        onGenerate={() => void execute('workflow', async (isCurrent) => {
        const request = artifactRequest();
        const requestVersion = manufacturingRequestVersion(request);
        const result = await services.createArtifacts(request);
        if (!isCurrent() || !ownsCurrentManufacturingInput(requestVersion)) return;
        assertCoherentArtifacts(result);
        setArtifacts(result);
        setIssues(preflightIssues(result));
        if (state.goToStep('export')) setFurthestStep(4);
      })} />}
      {state.step === 'export' && <ExportStep issues={issues} busy={busyAction !== undefined} onExport={() => void execute('workflow', async (isCurrent) => {
        if (!artifacts || !artifacts.preflight.value.canExport) throw new Error('當前版本沒有通過真實加工前檢查的製作 artifacts');
        const acceptedArtifacts = artifacts;
        const zip = await services.buildKit(acceptedArtifacts);
        if (!isCurrent() || store.getState().step !== 'export') return;
        await services.downloadKit(zip);
      })} />}
    </div>
  );
}

function manufacturingRequestVersion(input: ManufacturingArtifactRequest): string {
  return JSON.stringify({
    sourceSha256: input.sourceSha256,
    meshSha256: input.meshSha256,
    repair: input.repair,
    axis: input.axis,
    settings: input.settings,
  });
}

function assertCoherentArtifacts(artifacts: ManufacturingArtifacts): void {
  const expected = JSON.stringify(artifacts.provenance);
  const stages = [
    artifacts.profile,
    artifacts.kit,
    artifacts.material,
    artifacts.engraving,
    artifacts.layout,
    artifacts.preflight,
    artifacts.document,
  ];
  if (stages.some((stage) => !stage || JSON.stringify(stage.provenance) !== expected)
    || JSON.stringify(artifacts.document?.value?.provenance) !== expected) {
    throw new Error('製作 artifacts 不屬於同一輸入版本');
  }
}

function preflightIssues(artifacts: ManufacturingArtifacts): readonly GeometryIssue[] {
  return artifacts.preflight.value.issues.map((item) => ({
    id: item.code,
    regionId: item.regionId ?? item.code,
    severity: item.severity,
    label: item.message,
    description: item.message,
  }));
}

function issuesFromReport(report: MeshProblemReport): readonly GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  const add = (count: number, issue: GeometryIssue) => { if (count > 0) issues.push(issue); };
  add(report.inspection.boundaryEdgeCount, {
    id: 'mesh-boundary-edges',
    regionId: report.boundaryEdges[0]?.regionId ?? 'mesh-boundary',
    severity: 'blocking',
    label: '開放邊界',
    description: `偵測到 ${report.inspection.boundaryEdgeCount} 條開放邊界；模型不是封閉實體。`,
  });
  add(report.inspection.nonManifoldEdgeCount, {
    id: 'mesh-non-manifold-edges',
    regionId: report.nonManifoldEdges[0]?.regionId ?? 'mesh-non-manifold',
    severity: 'blocking',
    label: '非流形邊',
    description: `偵測到 ${report.inspection.nonManifoldEdgeCount} 條非流形邊；邊的三角面連接關係無法形成封閉實體。`,
  });
  add(report.inspection.degenerateTriangleCount, {
    id: 'mesh-degenerate-triangles',
    regionId: report.degenerateTriangles[0]?.regionId ?? 'mesh-degenerate',
    severity: 'blocking',
    label: '退化三角形',
    description: `偵測到 ${report.inspection.degenerateTriangleCount} 個面積為零或過小的三角形。`,
  });
  add(report.duplicateTriangleCount, {
    id: 'mesh-duplicate-triangles',
    regionId: report.duplicateTriangles[0]?.regionId ?? 'mesh-duplicate',
    severity: 'blocking',
    label: '重複三角形',
    description: `偵測到 ${report.duplicateTriangleCount} 個重複三角形。`,
  });
  add(report.inconsistentWindingEdgeCount, {
    id: 'mesh-inconsistent-winding',
    regionId: report.inconsistentWindingEdges[0]?.regionId ?? 'mesh-winding',
    severity: 'blocking',
    label: '面方向不一致',
    description: `偵測到 ${report.inconsistentWindingEdgeCount} 條相鄰面方向不一致的邊。`,
  });
  add(report.selfIntersectionCount, {
    id: 'mesh-self-intersections',
    regionId: report.selfIntersections[0]?.regionId ?? 'mesh-self-intersection',
    severity: 'blocking',
    label: '三維自相交',
    description: `偵測到 ${report.selfIntersectionCount} 對相交三角形。`,
  });
  if (!report.selfIntersectionAnalysisComplete) issues.push({
    id: 'mesh-self-intersection-analysis-incomplete',
    regionId: 'mesh-self-intersection-analysis',
    severity: 'blocking',
    label: '三維自相交分析未完整',
    description: '分析超出安全工作上限；在完整驗證前不得繼續。',
  });
  return issues;
}

function compactPreview(mesh: TriangleMesh, maximumTriangles = 2_000): TriangleMesh {
  const indexLimit = Math.min(mesh.indices.length, maximumTriangles * 3);
  if (indexLimit === mesh.indices.length) return mesh;
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(indexLimit);
  for (let offset = 0; offset < indexLimit; offset += 1) {
    const source = mesh.indices[offset];
    let target = remap.get(source);
    if (target === undefined) {
      target = remap.size;
      remap.set(source, target);
      positions.push(
        mesh.positions[source * 3],
        mesh.positions[source * 3 + 1],
        mesh.positions[source * 3 + 2],
      );
    }
    indices[offset] = target;
  }
  return { positions: new Float64Array(positions), indices };
}
