import { readFile, writeFile } from 'node:fs/promises';

type RawRecord = Record<string, unknown> & { caseId: string; runIndex: number };

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} schema is not canonical`);
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a finite non-negative safe integer`);
  return value;
}

const [inputPath, validationPath, outputPath] = process.argv.slice(2);
if (!inputPath || !validationPath || !outputPath || process.argv.length !== 5) {
  throw new Error('Usage: generate-wasm-release-evidence.ts <measurements.jsonl> <validation.json> <evidence.json>');
}
const records = (await readFile(inputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RawRecord);
const validation = JSON.parse(await readFile(validationPath, 'utf8')) as Record<string, unknown>;
const validationKeys = ['schemaVersion', 'memory', 'responsiveness', 'geometry', 'bundle', 'privateAcceptance', 'physicalLauncherCoupon'];
if (JSON.stringify(Object.keys(validation).sort()) !== JSON.stringify(validationKeys.sort()) || validation.schemaVersion !== 1) {
  throw new Error('Validation evidence schema is not canonical');
}
const memory = validation.memory as Record<string, unknown>;
const responsiveness = validation.responsiveness as Record<string, unknown>;
const geometry = validation.geometry as Record<string, unknown>;
const bundle = validation.bundle as Record<string, unknown>;
exactKeys(memory, ['baselineAttributableLiveBytes', 'observationStages'], 'memory validation');
if (memory.baselineAttributableLiveBytes !== null) finite(memory.baselineAttributableLiveBytes, 'baseline live bytes');
if (!Array.isArray(memory.observationStages) || memory.observationStages.some((stage) => typeof stage !== 'string')) throw new Error('memory observation stages are invalid');
exactKeys(responsiveness, ['cancellationVerifiedUnderOneSecond', 'activeWorkersAfterCancellation'], 'responsiveness validation');
if (typeof responsiveness.cancellationVerifiedUnderOneSecond !== 'boolean') throw new Error('cancellation evidence must be boolean');
finite(responsiveness.activeWorkersAfterCancellation, 'active workers after cancellation');
const geometryKeys = ['differential', 'launcherFingerprint', 'launcherRotation', 'launcherFit', 'exteriorExpansion', 'decorationOmissions', 'layerCanonical', 'sixOutputsCanonical', 'zipMembersCanonical'];
exactKeys(geometry, geometryKeys, 'geometry validation');
if (geometryKeys.some((key) => typeof geometry[key] !== 'boolean')) throw new Error('geometry evidence must be boolean');
exactKeys(bundle, ['hashedWasmAssets', 'hashedSliceWorkerAssets', 'sourceMaps', 'absolutePaths', 'privateTokens'], 'bundle validation');
finite(bundle.hashedWasmAssets, 'hashed WASM assets'); finite(bundle.hashedSliceWorkerAssets, 'hashed slice worker assets'); finite(bundle.sourceMaps, 'source maps');
if (typeof bundle.absolutePaths !== 'boolean' || typeof bundle.privateTokens !== 'boolean') throw new Error('bundle privacy evidence must be boolean');
if (validation.privateAcceptance !== 'passed' && validation.privateAcceptance !== 'conditional-skip') throw new Error('private acceptance evidence is invalid');
if (validation.physicalLauncherCoupon !== 'passed' && validation.physicalLauncherCoupon !== 'outstanding') throw new Error('physical coupon evidence is invalid');
const caseIds = ['reference-a', 'reference-b', 'synthetic-200000', 'synthetic-500000', 'synthetic-1000000'] as const;
const groups = new Map(caseIds.map((caseId) => [caseId, records.filter((record) => record.caseId === caseId).sort((a, b) => a.runIndex - b.runIndex)]));
for (const [caseId, samples] of groups) {
  if (samples.length !== 6 || samples.some((sample, index) => sample.runIndex !== index)) {
    throw new Error(`${caseId} requires one warmup and five ordered measured records`);
  }
  const [first] = samples;
  for (const sample of samples) {
    const isReference = caseId.startsWith('reference-');
    exactKeys(sample, isReference
      ? ['caseId', 'runIndex', 'runId', 'architecture', 'browser', 'triangleCount', 'layerCount', 'measurementInterval', 'conversionStageMs', 'fullOneClickMs', 'peakAttributableLiveBytes', 'canonicalArtifactsVerified', 'actualWasmPublications']
      : ['caseId', 'runIndex', 'runId', 'architecture', 'browser', 'triangleCount', 'layerCount', 'measurementInterval', 'elapsedMs', 'longestMainThreadTaskMs', 'peakAttributableLiveBytes', 'outcome', 'actualWasmPublications'], `${caseId} run ${sample.runIndex}`);
    if (sample.triangleCount !== first.triangleCount || sample.layerCount !== first.layerCount
      || sample.measurementInterval !== first.measurementInterval
      || typeof sample.runId !== 'string' || !/^[a-z0-9-]+$/.test(sample.runId)) throw new Error(`${caseId} raw records are inconsistent`);
    if (caseId.startsWith('synthetic-') && !['NO_OUTLINE', 'RESOURCE_LIMIT', 'TIME_LIMIT', 'SUCCESS'].includes(sample.outcome as string)) {
      throw new Error(`${caseId} requires a typed terminal outcome`);
    }
    if (caseId.startsWith('synthetic-') && ((sample.outcome === 'SUCCESS') !== (typeof sample.layerCount === 'number' && sample.layerCount > 0))) {
      throw new Error(`${caseId} layer count does not match its real terminal outcome`);
    }
    if (sample.architecture !== 'arm64' || sample.browser !== 'chromium') throw new Error(`${caseId} was not measured on the fixed release host`);
    finite(sample.runIndex, `${caseId} run index`);
    finite(sample.triangleCount, `${caseId} triangle count`);
    if (sample.layerCount !== null) finite(sample.layerCount, `${caseId} layer count`);
    finite(sample.peakAttributableLiveBytes, `${caseId} live bytes`);
    if (!Array.isArray(sample.actualWasmPublications) || sample.actualWasmPublications.length > 1) throw new Error(`${caseId} requires zero or one publication per job`);
    for (const candidate of sample.actualWasmPublications as Array<Record<string, unknown>>) {
      exactKeys(candidate, ['generation', 'layerCount', 'activeWorkerCount', 'sliceWorkersCreated', 'sliceWorkersTerminated'], `${caseId} publication`);
      for (const key of Object.keys(candidate)) finite(candidate[key], `${caseId} publication ${key}`);
      if (candidate.layerCount !== sample.layerCount) throw new Error(`${caseId} publication layer count does not match its job`);
    }
    if (isReference && sample.canonicalArtifactsVerified !== true) throw new Error(`${caseId} canonical artifacts were not verified`);
  }
  if (new Set(samples.map(({ runId }) => runId)).size !== 6) throw new Error(`${caseId} run IDs must be unique`);
}
if (new Set(records.map(({ runId }) => runId)).size !== records.length) throw new Error('Run IDs must be globally unique');
const benchmark = caseIds.map((caseId) => {
  const samples = groups.get(caseId)!;
  const first = samples[0];
  const measured = samples.slice(1);
  const isReference = caseId.startsWith('reference-');
  const observed = measured.map((sample) => {
    const candidates = sample.actualWasmPublications as Array<Record<string, unknown>>;
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    return {
      runId: sample.runId,
      jobGeneration: candidate.generation,
      generation: candidate.generation,
      layerCount: candidate.layerCount,
      sliceWorkersCreated: candidate.sliceWorkersCreated,
      sliceWorkersTerminated: candidate.sliceWorkersTerminated,
      activeWorkersAfter: candidate.activeWorkerCount,
    };
  });
  return {
    caseId,
    kind: isReference ? 'private-reference' : 'synthetic',
    triangleCount: first.triangleCount,
    layerCount: first.layerCount,
    measurementInterval: isReference ? 'conversion-stage' : 'selection-to-terminal',
    origin: observed.every((publication) => publication !== null) ? 'wasm' : 'typescript',
    measuredRunIds: measured.map(({ runId }) => runId),
    actualWasmPublications: observed,
    conversionStageMs: measured.map((sample) => isReference ? sample.conversionStageMs : sample.elapsedMs),
    ...(isReference ? { fullOneClickMs: measured.map((sample) => sample.fullOneClickMs) } : {}),
  };
});
const synthetic = records.filter((record) => record.caseId.startsWith('synthetic-'));
const measuredHost = records[0];
const evidence = {
  schemaVersion: 1,
  host: {
    architecture: measuredHost.architecture,
    browser: measuredHost.browser,
    measuredRuns: groups.get(caseIds[0])!.length - 1,
    warmupRuns: groups.get(caseIds[0])!.filter(({ runIndex }) => runIndex === 0).length,
  },
  benchmarks: benchmark,
  memory: {
    baselineAttributableLiveBytes: memory.baselineAttributableLiveBytes,
    runtimeAttributableLiveBytes: Math.max(...synthetic.map((record) => record.peakAttributableLiveBytes as number)),
    observationStages: memory.observationStages,
  },
  responsiveness: {
    longestMainThreadTaskMs: Math.max(...synthetic.map((record) => record.longestMainThreadTaskMs as number)),
    cancellationVerifiedUnderOneSecond: responsiveness.cancellationVerifiedUnderOneSecond,
    activeWorkersAfterCancellation: responsiveness.activeWorkersAfterCancellation,
  },
  geometry: validation.geometry,
  bundle: validation.bundle,
  privateAcceptance: validation.privateAcceptance,
  physicalLauncherCoupon: validation.physicalLauncherCoupon,
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
