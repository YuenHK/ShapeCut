import { readFile } from 'node:fs/promises';

export type WasmGeometryBenchmarkCase = {
  caseId: 'reference-a' | 'reference-b' | `synthetic-${200000 | 500000 | 1000000}`;
  kind: 'private-reference' | 'synthetic';
  triangleCount: number;
  layerCount: number;
  measurementInterval: 'conversion-stage' | 'selection-to-cancel-cleanup';
  origin: 'wasm' | 'typescript';
  actualWasmPartitionsObserved: boolean;
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
  return values.map((value, index) => finite(value, `${label}[${index}]`));
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
      'caseId', 'kind', 'triangleCount', 'layerCount', 'measurementInterval', 'origin',
      'actualWasmPartitionsObserved', 'conversionStageMs',
      ...(entry.baselineConversionStageMs === undefined ? [] : ['baselineConversionStageMs']),
      ...(entry.fullOneClickMs === undefined ? [] : ['fullOneClickMs']),
    ], `${entry.caseId} benchmark`);
    const expectedInterval = entry.kind === 'private-reference'
      ? 'conversion-stage' : 'selection-to-cancel-cleanup';
    if (entry.measurementInterval !== expectedInterval) throw new RangeError(`${entry.caseId} measurement interval is not canonical`);
    const conversion = measured(entry.conversionStageMs, `${entry.caseId} conversion`);
    const baseline = entry.baselineConversionStageMs === undefined ? undefined : measured(entry.baselineConversionStageMs, `${entry.caseId} baseline`);
    const full = entry.fullOneClickMs === undefined ? undefined : measured(entry.fullOneClickMs, `${entry.caseId} full one-click`);
    finite(entry.triangleCount, `${entry.caseId} triangle count`);
    finite(entry.layerCount, `${entry.caseId} layer count`);
    return {
      caseId: entry.caseId,
      conversionMedianMs: median(conversion),
      ...(full === undefined ? {} : { fullOneClickMedianMs: median(full) }),
      ...(baseline === undefined ? {} : { speedup: median(baseline) / median(conversion) }),
    };
  });

  const failedGates: string[] = [];
  const references = benchmarks.slice(0, 2);
  const fastEnough = references.every(({ conversionMedianMs }) => conversionMedianMs <= 15_000)
    || references.every(({ speedup }) => speedup !== undefined && speedup >= 2);
  if (!fastEnough) failedGates.push('knight-performance');
  if (!evidence.benchmarks.slice(0, 2).every(({ origin, actualWasmPartitionsObserved }) => (
    origin === 'wasm' && actualWasmPartitionsObserved
  ))) failedGates.push('knight-actual-wasm');

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
  const evidencePath = process.argv.at(-1);
  if (evidencePath === undefined || !evidencePath.endsWith('.json')) throw new Error('Usage: verify-wasm-geometry-release.ts <evidence.json>');
  const evidence: unknown = JSON.parse(await readFile(evidencePath, 'utf8'));
  const result = verifyWasmGeometryRelease(evidence);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.softwareReleaseEligible) process.exitCode = 1;
}

if (process.env.VITEST === undefined) await main();
