import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { AxisCandidate } from '../domain/axis/find-axis';
import type { MeshProblemReport, MeshRepairResult, TriangleMesh } from '../domain/mesh/types';
import type { WorkflowStep } from '../domain/types';
import type { GeometryIssue } from '../preview/SpinnerViewport';
import { SpinnerViewport } from '../preview/SpinnerViewport';
import type { ImportRepairAnalysis } from '../workers/geometry-api';
import { createProjectAutosave, type ProjectRepository } from '../persistence/project-repository';
import { createProjectStore, type WizardSettings } from './project-store';
import { AxisStep } from './steps/AxisStep';
import { DecompositionStep } from './steps/DecompositionStep';
import { EngravingStep } from './steps/EngravingStep';
import { ExportStep } from './steps/ExportStep';
import { ImportStep, RepairSummary, type ImportBusyAction, type ImportRepairStage } from './steps/ImportStep';

type IssueResult = { readonly issues: readonly GeometryIssue[] };
type RepairImportResult = ImportRepairAnalysis & { readonly sourceSha256: string };
type AdvancedRepairResult = MeshRepairResult & { readonly candidates?: readonly AxisCandidate[] };

export type WizardServices = {
  inspectAndRepair(file: File): Promise<RepairImportResult>;
  advancedRepair(original: TriangleMesh, safeMesh: TriangleMesh): Promise<AdvancedRepairResult>;
  serializeRepairedSTL(mesh: TriangleMesh, mode: 'safe' | 'advanced'): Promise<ArrayBuffer>;
  downloadRepairedSTL(bytes: ArrayBuffer, originalFileName: string): Promise<void>;
  decompose(settings: WizardSettings): Promise<IssueResult>;
  engrave(settings: WizardSettings): Promise<IssueResult>;
  preflight(settings: WizardSettings): Promise<IssueResult>;
  buildKit(settings: WizardSettings, sourceSha256: string): Promise<Uint8Array>;
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
  const [mesh, setMesh] = useState<TriangleMesh>();
  const [operationError, setOperationError] = useState<string>();

  useEffect(() => {
    if (!repository || !sourceSha256) return;
    const autosave = createProjectAutosave(repository, (message) => store.getState().setPersistenceError(message));
    let lastSnapshot = '';
    const schedule = () => {
      const current = store.getState();
      const snapshotKey = JSON.stringify({ id: current.id, name: current.name, step: current.step, axis: current.axis, settings: current.settings, sourceSha256 });
      if (snapshotKey === lastSnapshot) return;
      lastSnapshot = snapshotKey;
      autosave.schedule({ schemaVersion: 1, id: current.id, name: current.name, step: current.step, axis: current.axis, settings: current.settings, sourceSha256, updatedAt: new Date().toISOString() });
    };
    schedule();
    const unsubscribe = store.subscribe(schedule);
    return () => { unsubscribe(); autosave.dispose(); };
  }, [repository, sourceSha256, store]);

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
  const hasBlocking = (result: IssueResult): boolean => result.issues.some(({ severity }) => severity === 'blocking');

  const selectFile = (nextFile: File | undefined): void => {
    selectionVersion.current += 1;
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
    setMesh(undefined);
    setOperationError(undefined);
    store.setState({ axis: undefined });
    store.getState().goToStep('import');
  };

  const analyzeFile = (): void => {
    const selectedFile = file;
    if (!selectedFile) return;
    void execute('analyze', async (isCurrent) => {
      const result = await services.inspectAndRepair(selectedFile);
      if (!isCurrent()) return;
      setAnalysis(result);
      setAdvancedRepair(undefined);
      setRepairStage('safe');
      setAdvancedConsent(false);
      setCandidates(result.candidates);
      setSourceSha256(result.sourceSha256);
      setIssues(issuesFromReport(result.safeRepair.after));
      if (!result.safeRepair.accepted) {
        setMesh(undefined);
        setFurthestStep(0);
        state.goToStep('import');
        return;
      }
      setMesh(result.safeRepair.mesh);
      setFurthestStep(1);
      state.goToStep('axis');
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
    setCandidates(nextCandidates);
    setIssues(issuesFromReport(currentRepair.after));
    setFurthestStep(1);
    state.goToStep('axis');
  };

  return (
    <div className="wizard">
      {state.persistenceError && <p role="alert">專案儲存失敗：{state.persistenceError}</p>}
      {operationError && <p role="alert">操作失敗：{operationError}</p>}
      {issues.length > 0 && state.step !== 'export' && <div role="alert">{issues.map((issue) => <p key={issue.id}>{issue.label}：{issue.description}</p>)}</div>}
      {(eagerPreview || repairPreview || acceptedPreview) && <SpinnerViewport mesh={state.step === 'import' ? repairPreview : acceptedPreview} meshProblems={currentReport} issues={issues} />}
      <nav aria-label="轉換步驟"><ol>{steps.map(({ id, label }, index) => <li key={id}><button type="button" disabled={index > furthestStep} aria-current={state.step === id ? 'step' : undefined} onClick={() => state.goToStep(id)}>{label}</button></li>)}</ol></nav>
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
      {state.step === 'axis' && <><h2>軸心與尺寸</h2><AxisStep candidates={candidates} confirmedAxis={state.axis} onConfirm={(candidate) => state.setAxis({ ...candidate, confirmed: true })} onNext={() => {
        if (state.goToStep('decomposition')) setFurthestStep((value) => Math.max(value, 2));
      }} /></>}
      {state.step === 'decomposition' && <DecompositionStep settings={state.settings} busy={busyAction !== undefined} onChange={state.updateSettings} onAccept={() => void execute('workflow', async (isCurrent) => {
        const result = await services.decompose(store.getState().settings);
        if (!isCurrent()) return;
        setIssues(result.issues);
        if (!hasBlocking(result) && state.goToStep('engraving')) setFurthestStep((value) => Math.max(value, 3));
      })} />}
      {state.step === 'engraving' && <EngravingStep settings={state.settings} busy={busyAction !== undefined} onChange={state.updateSettings} onGenerate={() => void execute('workflow', async (isCurrent) => {
        const engraving = await services.engrave(store.getState().settings);
        if (!isCurrent()) return;
        setIssues(engraving.issues);
        if (hasBlocking(engraving)) return;
        const preflight = await services.preflight(store.getState().settings);
        if (!isCurrent()) return;
        setIssues(preflight.issues);
        if (state.goToStep('export')) setFurthestStep(4);
      })} />}
      {state.step === 'export' && <ExportStep issues={issues} busy={busyAction !== undefined} onExport={() => void execute('workflow', async (isCurrent) => {
        if (!sourceSha256) throw new Error('缺少原始 STL 指紋');
        const settings = { ...store.getState().settings };
        const acceptedSourceSha256 = sourceSha256;
        const zip = await services.buildKit(settings, acceptedSourceSha256);
        if (!isCurrent() || store.getState().step !== 'export') return;
        await services.downloadKit(zip);
      })} />}
    </div>
  );
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
