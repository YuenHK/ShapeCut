import { readFile } from 'node:fs/promises';

export type WasmGeometryBenchmarkCase = {
  caseId: 'reference-a' | 'reference-b' | `synthetic-${200000 | 500000 | 1000000}`;
  kind: 'private-reference' | 'synthetic';
  triangleCount: number;
  layerCount: number | null;
  measurementInterval: 'conversion-stage' | 'selection-to-terminal';
  origin: 'wasm' | 'typescript';
  measuredRunIds: string[];
  actualWasmPublications: Array<null | {
    runId: string;
    jobGeneration: number;
    generation: number;
    layerCount: number;
    sliceWorkersCreated: number;
    sliceWorkersTerminated: number;
    activeWorkersAfter: number;
  }>;
  conversionStageMs: number[];
  baselineConversionStageMs?: number[];
  fullOneClickMs?: number[];
};

export type WasmGeometryReleaseEvidence = {
  schemaVersion: 1;
  host: { architecture: 'arm64'; browser: 'chromium'; measuredRuns: 5; warmupRuns: 1 };
  benchmarks: WasmGeometryBenchmarkCase[];
  memory: {
    baselineAttributableLiveBytes: number | null;
    runtimeAttributableLiveBytes: number;
    observationStages: string[];
  };
  responsiveness: {
    longestMainThreadTaskMs: number;
    cancellationVerifiedUnderOneSecond: boolean;
    activeWorkersAfterCancellation: number;
  };
  geometry: {
    differential: boolean;
    launcherFingerprint: boolean;
    launcherRotation: boolean;
    launcherFit: boolean;
    exteriorExpansion: boolean;
    decorationOmissions: boolean;
    layerCanonical: boolean;
    sixOutputsCanonical: boolean;
    zipMembersCanonical: boolean;
  };
  bundle: {
    hashedWasmAssets: number;
    hashedSliceWorkerAssets: number;
    sourceMaps: number;
    absolutePaths: boolean;
    privateTokens: boolean;
  };
  privateAcceptance: 'passed' | 'conditional-skip';
  physicalLauncherCoupon: 'passed' | 'outstanding';
};

type BenchmarkSummary = {
  caseId: WasmGeometryBenchmarkCase['caseId'];
  conversionMedianMs: number;
  fullOneClickMedianMs?: number;
  speedup?: number;
};

export type WasmGeometryReleaseResult = {
  schemaVersion: 1;
  softwareReleaseEligible: boolean;
  productionRolloutEligible: boolean;
  benchmarks: readonly BenchmarkSummary[];
  liveByteReductionPercent: number | null;
  failedGates: readonly string[];
  externalOutstanding: readonly string[];
};

const topKeys = ['schemaVersion', 'host', 'benchmarks', 'memory', 'responsiveness', 'geometry', 'bundle', 'privateAcceptance', 'physicalLauncherCoupon'];
const forbiddenKey = /^(?:file.?name|path|hash|model.?name|account|email)$/i;

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectForbiddenKeys(item); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey.test(key)) throw new TypeError(`Release evidence contains forbidden identifying field ${key}`);
    rejectForbiddenKeys(item);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) throw new TypeError(`${label} fields are not canonical`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a finite non-negative safe integer`);
  }
  return value;
}

function measured(values: unknown, label: string): number[] {
  if (!Array.isArray(values) || values.length !== 5) throw new RangeError(`${label} requires five measured trials`);
  return values.map((value, index) => {
    const duration = finite(value, `${label}[${index}]`);
    if (duration === 0) throw new RangeError(`${label}[${index}] must be positive`);
    return duration;
  });
}

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[2];
}

export function verifyWasmGeometryRelease(input: unknown): WasmGeometryReleaseResult {
  rejectForbiddenKeys(input);
  assertPlainRecord(input, 'Release evidence');
  exactKeys(input, topKeys, 'Release evidence');
  if (input.schemaVersion !== 1) throw new TypeError('Unsupported release evidence schema');
  const evidence = input as unknown as WasmGeometryReleaseEvidence;
  assertPlainRecord(evidence.host, 'Release host');
  exactKeys(evidence.host, ['architecture', 'browser', 'measuredRuns', 'warmupRuns'], 'Release host');
  if (evidence.host?.architecture !== 'arm64') throw new RangeError('Release benchmark host must be Apple Silicon arm64');
  if (evidence.host.browser !== 'chromium') throw new RangeError('Release benchmark browser must be Chromium');
  if (evidence.host.warmupRuns !== 1) throw new RangeError('Release benchmark requires one warmup');
  if (evidence.host.measuredRuns !== 5) throw new RangeError('Release benchmark requires five measured trials');

  const expectedCases = ['reference-a', 'reference-b', 'synthetic-200000', 'synthetic-500000', 'synthetic-1000000'];
  if (!Array.isArray(evidence.benchmarks) || JSON.stringify(evidence.benchmarks.map(({ caseId }) => caseId)) !== JSON.stringify(expectedCases)) {
    throw new RangeError('Release benchmark cases are incomplete or out of canonical order');
  }
  const benchmarks = evidence.benchmarks.map((entry): BenchmarkSummary => {
    assertPlainRecord(entry, 'Benchmark case');
    exactKeys(entry, [
      'caseId', 'kind', 'triangleCount', 'layerCount', 'measurementInterval', 'origin', 'measuredRunIds',
      'actualWasmPublications', 'conversionStageMs',
      ...(entry.baselineConversionStageMs === undefined ? [] : ['baselineConversionStageMs']),
      ...(entry.fullOneClickMs === undefined ? [] : ['fullOneClickMs']),
    ], `${entry.caseId} benchmark`);
    const expectedInterval = entry.kind === 'private-reference'
      ? 'conversion-stage' : 'selection-to-terminal';
    if (entry.measurementInterval !== expectedInterval) throw new RangeError(`${entry.caseId} measurement interval is not canonical`);
    const expected = ({
      'reference-a': ['private-reference', 37_116, 6],
      'reference-b': ['private-reference', 40_100, 6],
      'synthetic-200000': ['synthetic', 200_000, null],
      'synthetic-500000': ['synthetic', 500_000, null],
      'synthetic-1000000': ['synthetic', 1_000_000, null],
    } as const)[entry.caseId];
    if (entry.kind !== expected[0] || entry.triangleCount !== expected[1]
      || (entry.kind === 'private-reference' && entry.layerCount !== expected[2])
      || (entry.kind === 'synthetic' && entry.layerCount !== null && (!Number.isSafeInteger(entry.layerCount) || entry.layerCount! <= 0))) {
      throw new RangeError(`${entry.caseId} kind or geometry counts are not canonical`);
    }
    if (entry.kind === 'private-reference' && entry.fullOneClickMs === undefined) throw new RangeError(`${entry.caseId} requires full one-click measurements`);
    if (entry.kind === 'synthetic' && entry.fullOneClickMs !== undefined) throw new RangeError(`${entry.caseId} cannot claim full one-click measurements`);
    if (!Array.isArray(entry.actualWasmPublications) || entry.actualWasmPublications.length !== 5) throw new RangeError(`${entry.caseId} requires five WASM publication observations`);
    if (!Array.isArray(entry.measuredRunIds) || entry.measuredRunIds.length !== 5
      || entry.measuredRunIds.some((runId) => typeof runId !== 'string' || !/^[a-z0-9-]+$/.test(runId))) throw new RangeError(`${entry.caseId} requires five canonical measured run IDs`);
    for (const [index, publication] of entry.actualWasmPublications.entries()) {
      if (publication === null) continue;
      assertPlainRecord(publication, `${entry.caseId} WASM publication`);
      exactKeys(publication, ['runId', 'jobGeneration', 'generation', 'layerCount', 'sliceWorkersCreated', 'sliceWorkersTerminated', 'activeWorkersAfter'], `${entry.caseId} WASM publication`);
      const created = finite(publication.sliceWorkersCreated, `${entry.caseId} slice workers created`);
      if (finite(publication.jobGeneration, `${entry.caseId} job generation`) !== finite(publication.generation, `${entry.caseId} publication generation`)
        || publication.runId !== entry.measuredRunIds[index]
        || (entry.layerCount !== null && publication.layerCount !== entry.layerCount) || created === 0
        || finite(publication.sliceWorkersTerminated, `${entry.caseId} slice workers terminated`) !== created
        || finite(publication.activeWorkersAfter, `${entry.caseId} active workers`) !== 0) {
        throw new RangeError(`${entry.caseId} WASM publication is not bound to one clean job generation`);
      }
    }
    const publishedGenerations = entry.actualWasmPublications.flatMap((publication) => publication === null ? [] : [publication.jobGeneration]);
    if (new Set(publishedGenerations).size !== publishedGenerations.length) throw new RangeError(`${entry.caseId} reuses a measured job generation`);
    const conversion = measured(entry.conversionStageMs, `${entry.caseId} conversion`);
    const baseline = entry.baselineConversionStageMs === undefined ? undefined : measured(entry.baselineConversionStageMs, `${entry.caseId} baseline`);
    const full = entry.fullOneClickMs === undefined ? undefined : measured(entry.fullOneClickMs, `${entry.caseId} full one-click`);
    finite(entry.triangleCount, `${entry.caseId} triangle count`);
    if (entry.layerCount !== null) finite(entry.layerCount, `${entry.caseId} layer count`);
    return {
      caseId: entry.caseId,
      conversionMedianMs: median(conversion),
      ...(full === undefined ? {} : { fullOneClickMedianMs: median(full) }),
      ...(baseline === undefined ? {} : { speedup: median(baseline) / median(conversion) }),
    };
  });
  const allRunIds = evidence.benchmarks.flatMap(({ measuredRunIds }) => measuredRunIds);
  if (new Set(allRunIds).size !== allRunIds.length) throw new RangeError('Measured run IDs must be globally unique');

  const failedGates: string[] = [];
  const references = benchmarks.slice(0, 2);
  const fastEnough = references.every(({ conversionMedianMs }) => conversionMedianMs <= 15_000)
    || references.every(({ speedup }) => speedup !== undefined && speedup >= 2);
  if (!fastEnough) failedGates.push('knight-performance');
  if (!evidence.benchmarks.slice(0, 2).every(({ origin, actualWasmPublications }) => (
    origin === 'wasm' && actualWasmPublications.every((publication) => publication !== null)
  ))) failedGates.push('knight-actual-wasm');
  if (!evidence.benchmarks.slice(2).every(({ origin, actualWasmPublications }) => (
    origin === 'wasm' && actualWasmPublications.every((publication) => publication !== null)
  ))) failedGates.push('synthetic-actual-wasm');

  assertPlainRecord(evidence.memory, 'Release memory');
  exactKeys(evidence.memory, ['baselineAttributableLiveBytes', 'runtimeAttributableLiveBytes', 'observationStages'], 'Release memory');
  const runtimeBytes = finite(evidence.memory.runtimeAttributableLiveBytes, 'runtime live bytes');
  const baselineBytes = evidence.memory?.baselineAttributableLiveBytes === null
    ? null : finite(evidence.memory?.baselineAttributableLiveBytes, 'baseline live bytes');
  if (baselineBytes === 0) throw new RangeError('Baseline attributable live bytes must be positive');
  const liveByteReductionPercent = baselineBytes === null
    ? null : (baselineBytes - runtimeBytes) / baselineBytes * 100;
  const requiredStages = ['pipeline:stl-received', 'slice-pool:partitions-ready', 'slice-pool:result-merged', 'slice-pool:cleanup'];
  if (baselineBytes === null) failedGates.push('live-byte-baseline');
  else if (!requiredStages.every((stage) => evidence.memory.observationStages.includes(stage)) || liveByteReductionPercent! < 30) failedGates.push('live-byte-reduction');

  assertPlainRecord(evidence.responsiveness, 'Release responsiveness');
  exactKeys(evidence.responsiveness, ['longestMainThreadTaskMs', 'cancellationVerifiedUnderOneSecond', 'activeWorkersAfterCancellation'], 'Release responsiveness');
  if (finite(evidence.responsiveness.longestMainThreadTaskMs, 'longest main task') >= 100) failedGates.push('main-thread-responsiveness');
  if (evidence.responsiveness.cancellationVerifiedUnderOneSecond !== true
    || finite(evidence.responsiveness?.activeWorkersAfterCancellation, 'active workers') !== 0) failedGates.push('cancellation');
  assertPlainRecord(evidence.geometry, 'Release geometry');
  exactKeys(evidence.geometry, ['differential', 'launcherFingerprint', 'launcherRotation', 'launcherFit', 'exteriorExpansion', 'decorationOmissions', 'layerCanonical', 'sixOutputsCanonical', 'zipMembersCanonical'], 'Release geometry');
  if (!Object.values(evidence.geometry ?? {}).every((value) => value === true)) failedGates.push('canonical-geometry');
  assertPlainRecord(evidence.bundle, 'Release bundle');
  exactKeys(evidence.bundle, ['hashedWasmAssets', 'hashedSliceWorkerAssets', 'sourceMaps', 'absolutePaths', 'privateTokens'], 'Release bundle');
  if (evidence.bundle?.hashedWasmAssets !== 1 || evidence.bundle.hashedSliceWorkerAssets !== 1
    || evidence.bundle.sourceMaps !== 0 || evidence.bundle.absolutePaths || evidence.bundle.privateTokens) failedGates.push('production-bundle');
  if (evidence.privateAcceptance !== 'passed') failedGates.push('private-acceptance');

  const externalOutstanding = evidence.physicalLauncherCoupon === 'passed' ? [] : ['physical-launcher-coupon'];
  const softwareReleaseEligible = failedGates.length === 0;
  return Object.freeze({
    schemaVersion: 1,
    softwareReleaseEligible,
    productionRolloutEligible: softwareReleaseEligible && externalOutstanding.length === 0,
    benchmarks: Object.freeze(benchmarks),
    liveByteReductionPercent,
    failedGates: Object.freeze(failedGates),
    externalOutstanding: Object.freeze(externalOutstanding),
  });
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const expectBlocked = arguments_.includes('--expect-blocked');
  const evidencePath = arguments_.find((argument) => argument.endsWith('.json'));
  if (evidencePath === undefined || arguments_.some((argument) => argument !== evidencePath && argument !== '--expect-blocked')) throw new Error('Usage: verify-wasm-geometry-release.ts <evidence.json> [--expect-blocked]');
  const evidence: unknown = JSON.parse(await readFile(evidencePath, 'utf8'));
  const result = verifyWasmGeometryRelease(evidence);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (expectBlocked) {
    const expected = [
      'knight-performance', 'knight-actual-wasm', 'synthetic-actual-wasm',
      'live-byte-baseline', 'main-thread-responsiveness', 'cancellation',
      'canonical-geometry', 'production-bundle', 'private-acceptance',
    ];
    if (JSON.stringify(result.failedGates) !== JSON.stringify(expected)
      || result.softwareReleaseEligible || result.productionRolloutEligible) process.exitCode = 1;
  } else if (!result.softwareReleaseEligible) process.exitCode = 1;
}

if (process.env.VITEST === undefined) await main();
