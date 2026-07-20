import { findAxisCandidates } from '../axis/find-axis';
import { parseSTL } from '../mesh/parse-stl';
import { analyzeMeshProblems } from '../mesh/problem-report';
import { repairMeshSafe } from '../mesh/repair-mesh';
import type { MeshProblemReport, TriangleMesh } from '../mesh/types';
import { selectOutlineAxis } from '../outline-2.5d/axis';
import {
  ExactContourAmbiguityError,
  extractExactContours,
  extractProjectedContours,
  type OutlineLayer,
} from '../outline-2.5d/extract';
import { scheduleOutlineLayers } from '../outline-2.5d/layer-schedule';
import {
  DEFAULT_OUTLINE_BUDGETS,
  type OutlineAxisSelection,
  type OutlineMode,
  type OutlineResultStatus,
} from '../outline-2.5d/types';

export type AutomaticOutlineProgressStage = 'reading' | 'analyzing' | 'simplifying' | 'slicing' | 'packaging';
export type AutomaticOutlineResult = {
  readonly sourceHash: string;
  readonly mode: OutlineMode;
  readonly status: OutlineResultStatus;
  readonly axis: OutlineAxisSelection;
  readonly layers: readonly OutlineLayer[];
  readonly warnings: readonly string[];
  readonly originalReport: MeshProblemReport;
  readonly repairAccepted: boolean;
  readonly removedComponentCount: number;
};
export type AutomaticOutlineRequest = { readonly bytes: ArrayBuffer };
export type AutomaticOutlineProgress = (stage: AutomaticOutlineProgressStage) => void | Promise<void>;
export type AutomaticOutlineErrorCode = 'INVALID_STL' | 'NO_OUTLINE' | 'RESOURCE_LIMIT' | 'TIME_LIMIT';

export class AutomaticOutlineError extends Error {
  readonly name = 'AutomaticOutlineError';

  constructor(readonly code: AutomaticOutlineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const PROJECTED_WARNINGS = Object.freeze([
  '已簡化模型',
  '原始內部細節、孔洞及細小分離零件已被忽略',
  '不同材料厚度會改變堆疊後高度',
  '輸出不包含雷射功率或速度',
  '正式製作前應先試切少量零件',
]);
const FALLBACK_AXIS_WARNING = '未找到可信旋轉軸，已使用模型最短包圍盒軸';

function sourceHash(input: ArrayBuffer): string {
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  const bytes = new Uint8Array(input);
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let hash = lanes[lane];
    for (const byte of bytes) hash = Math.imul(hash ^ (byte + lane * 131), 16777619 + lane * 2) >>> 0;
    lanes[lane] = hash;
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

function automaticAxis(mesh: TriangleMesh): OutlineAxisSelection {
  try {
    return selectOutlineAxis(mesh, findAxisCandidates(mesh, { sampleCount: 4096 }));
  } catch {
    return selectOutlineAxis(mesh, []);
  }
}

function asAutomaticOutlineError(error: unknown, fallbackCode: AutomaticOutlineErrorCode): AutomaticOutlineError {
  if (error instanceof AutomaticOutlineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/runtime|deadline|time limit|timed out/i.test(message)) {
    return new AutomaticOutlineError('TIME_LIMIT', '模型處理超出時間上限', { cause: error });
  }
  if (/budget|resource|too many|exceeds?.*limit|maximum/i.test(message)) {
    return new AutomaticOutlineError('RESOURCE_LIMIT', '模型超出安全處理資源上限', { cause: error });
  }
  const userMessage = fallbackCode === 'INVALID_STL'
    ? '無法讀取 STL 檔案'
    : '模型沒有足夠的有效投影外形';
  return new AutomaticOutlineError(fallbackCode, userMessage, { cause: error });
}

export async function convertAutomatically(
  request: AutomaticOutlineRequest,
  onProgress?: AutomaticOutlineProgress,
): Promise<AutomaticOutlineResult> {
  const deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs;
  let lastStage = -1;
  const stages: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
  const emit = async (stage: AutomaticOutlineProgressStage): Promise<void> => {
    const index = stages.indexOf(stage);
    if (index <= lastStage) return;
    lastStage = index;
    await onProgress?.(stage);
  };

  await emit('reading');
  const hash = sourceHash(request.bytes);
  let originalMesh: TriangleMesh;
  try {
    originalMesh = parseSTL(request.bytes);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'INVALID_STL');
  }

  await emit('analyzing');
  let originalReport: MeshProblemReport;
  let safeRepair: ReturnType<typeof repairMeshSafe>;
  try {
    originalReport = analyzeMeshProblems(originalMesh);
    safeRepair = repairMeshSafe(originalMesh, { beforeReport: originalReport });
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }

  await emit('simplifying');
  const extractionMesh = safeRepair.accepted ? safeRepair.mesh : originalMesh;
  let axis: OutlineAxisSelection;
  let specs: ReturnType<typeof scheduleOutlineLayers>;
  try {
    axis = automaticAxis(extractionMesh);
    specs = scheduleOutlineLayers(extractionMesh, axis.axis, DEFAULT_OUTLINE_BUDGETS);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
  const axisWarnings = axis.source === 'shortest-bounds' ? [FALLBACK_AXIS_WARNING] : [];

  await emit('slicing');
  if (safeRepair.accepted) {
    let exactExtraction: ReturnType<typeof extractExactContours>;
    try {
      exactExtraction = extractExactContours(extractionMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline);
    } catch (exactError) {
      const mappedExactError = asAutomaticOutlineError(exactError, 'NO_OUTLINE');
      if (mappedExactError.code !== 'NO_OUTLINE' || !(exactError instanceof ExactContourAmbiguityError)) {
        throw mappedExactError;
      }
      let projectedExtraction: ReturnType<typeof extractProjectedContours>;
      try {
        projectedExtraction = extractProjectedContours(
          extractionMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline,
        );
      } catch (projectedError) {
        throw asAutomaticOutlineError(projectedError, 'NO_OUTLINE');
      }
      await emit('packaging');
      return {
        sourceHash: hash,
        mode: 'outline-2.5d',
        status: 'warning',
        axis,
        layers: projectedExtraction.layers,
        warnings: [...PROJECTED_WARNINGS, ...axisWarnings, '精確切片失敗，已改用 2.5D 外形模式'],
        originalReport,
        repairAccepted: true,
        removedComponentCount: projectedExtraction.removedComponentCount,
      };
    }
    await emit('packaging');
    return {
      sourceHash: hash,
      mode: 'exact',
      status: axisWarnings.length === 0 ? 'success' : 'warning',
      axis,
      layers: exactExtraction.layers,
      warnings: axisWarnings,
      originalReport,
      repairAccepted: true,
      removedComponentCount: 0,
    };
  }

  let projectedExtraction: ReturnType<typeof extractProjectedContours>;
  try {
    projectedExtraction = extractProjectedContours(originalMesh, axis, specs, DEFAULT_OUTLINE_BUDGETS, deadline);
  } catch (error) {
    throw asAutomaticOutlineError(error, 'NO_OUTLINE');
  }
  await emit('packaging');
  return {
    sourceHash: hash,
    mode: 'outline-2.5d',
    status: 'warning',
    axis,
    layers: projectedExtraction.layers,
    warnings: [...PROJECTED_WARNINGS, ...axisWarnings],
    originalReport,
    repairAccepted: false,
    removedComponentCount: projectedExtraction.removedComponentCount,
  };
}
