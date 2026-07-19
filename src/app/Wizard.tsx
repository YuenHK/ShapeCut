import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { AxisCandidate } from '../domain/axis/find-axis';
import type { WorkflowStep } from '../domain/types';
import type { GeometryIssue } from '../preview/SpinnerViewport';
import { SpinnerViewport } from '../preview/SpinnerViewport';
import type { TriangleMesh } from '../domain/mesh/types';
import { createProjectAutosave, type ProjectRepository } from '../persistence/project-repository';
import { createProjectStore, type WizardSettings } from './project-store';
import { AxisStep } from './steps/AxisStep';
import { DecompositionStep } from './steps/DecompositionStep';
import { EngravingStep } from './steps/EngravingStep';
import { ExportStep } from './steps/ExportStep';
import { ImportStep } from './steps/ImportStep';

type IssueResult = { readonly issues: readonly GeometryIssue[] };
export type WizardServices = {
  inspect(file: File): Promise<IssueResult & { readonly candidates: readonly AxisCandidate[]; readonly sourceSha256?: string; readonly mesh?: TriangleMesh }>;
  decompose(settings: WizardSettings): Promise<IssueResult>;
  engrave(settings: WizardSettings): Promise<IssueResult>;
  preflight(settings: WizardSettings): Promise<IssueResult>;
  exportKit(settings: WizardSettings): Promise<void>;
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
  const [file, setFile] = useState<File>();
  const [candidates, setCandidates] = useState<readonly AxisCandidate[]>([]);
  const [issues, setIssues] = useState<readonly GeometryIssue[]>([]);
  const [busy, setBusy] = useState(false);
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

  const execute = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setOperationError(undefined);
    try { await operation(); }
    catch (error) { setOperationError(error instanceof Error ? error.message : '操作失敗'); }
    finally { setBusy(false); }
  };
  const hasBlocking = (result: IssueResult): boolean => result.issues.some(({ severity }) => severity === 'blocking');

  return (
    <div className="wizard">
      {state.persistenceError && <p role="alert">專案儲存失敗：{state.persistenceError}</p>}
      {operationError && <p role="alert">操作失敗：{operationError}</p>}
      {issues.length > 0 && state.step !== 'export' && <div role="alert">{issues.map((issue) => <p key={issue.id}>{issue.label}：{issue.description}</p>)}</div>}
      {(eagerPreview || mesh) && <SpinnerViewport mesh={mesh} issues={issues} />}
      <nav aria-label="轉換步驟"><ol>{steps.map(({ id, label }, index) => <li key={id}><button type="button" disabled={index > furthestStep} aria-current={state.step === id ? 'step' : undefined} onClick={() => state.goToStep(id)}>{label}</button></li>)}</ol></nav>
      {state.step === 'import' && <ImportStep file={file} busy={busy} onFile={setFile} onAnalyze={() => file && void execute(async () => {
        const result = await services.inspect(file);
        setCandidates(result.candidates);
        setIssues(result.issues);
        setSourceSha256(result.sourceSha256);
        setMesh(result.mesh);
        if (!hasBlocking(result)) {
          setFurthestStep((value) => Math.max(value, 1));
          state.goToStep('axis');
        }
      })} />}
      {state.step === 'axis' && <AxisStep candidates={candidates} confirmedAxis={state.axis} onConfirm={(candidate) => state.setAxis({ ...candidate, confirmed: true })} onNext={() => {
        if (state.goToStep('decomposition')) setFurthestStep((value) => Math.max(value, 2));
      }} />}
      {state.step === 'decomposition' && <DecompositionStep settings={state.settings} busy={busy} onChange={state.updateSettings} onAccept={() => void execute(async () => {
        const result = await services.decompose(store.getState().settings);
        setIssues(result.issues);
        if (!hasBlocking(result) && state.goToStep('engraving')) setFurthestStep((value) => Math.max(value, 3));
      })} />}
      {state.step === 'engraving' && <EngravingStep settings={state.settings} busy={busy} onChange={state.updateSettings} onGenerate={() => void execute(async () => {
        const engraving = await services.engrave(store.getState().settings);
        setIssues(engraving.issues);
        if (hasBlocking(engraving)) return;
        const preflight = await services.preflight(store.getState().settings);
        setIssues(preflight.issues);
        if (state.goToStep('export')) setFurthestStep(4);
      })} />}
      {state.step === 'export' && <ExportStep issues={issues} busy={busy} onExport={() => void execute(() => services.exportKit(store.getState().settings))} />}
    </div>
  );
}
