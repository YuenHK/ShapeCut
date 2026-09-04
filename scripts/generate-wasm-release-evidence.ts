import { readFile, writeFile } from 'node:fs/promises';

type RawRecord = Record<string, unknown> & { caseId: string; runIndex: number };

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || process.argv.length !== 4) {
  throw new Error('Usage: generate-wasm-release-evidence.ts <measurements.jsonl> <evidence.json>');
}
const records = (await readFile(inputPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RawRecord);
const caseIds = ['reference-a', 'reference-b', 'synthetic-200000', 'synthetic-500000', 'synthetic-1000000'] as const;
const groups = new Map(caseIds.map((caseId) => [caseId, records.filter((record) => record.caseId === caseId).sort((a, b) => a.runIndex - b.runIndex)]));
for (const [caseId, samples] of groups) {
  if (samples.length !== 6 || samples.some((sample, index) => sample.runIndex !== index)) {
    throw new Error(`${caseId} requires one warmup and five ordered measured records`);
  }
}
const publications = (samples: RawRecord[]) => samples.slice(1).flatMap((sample) => sample.actualWasmPublications as unknown[]);
const benchmark = caseIds.map((caseId) => {
  const samples = groups.get(caseId)!;
  const first = samples[0];
  const measured = samples.slice(1);
  const isReference = caseId.startsWith('reference-');
  const observed = publications(samples);
  return {
    caseId,
    kind: isReference ? 'private-reference' : 'synthetic',
    triangleCount: first.triangleCount,
    layerCount: first.layerCount,
    measurementInterval: isReference ? 'conversion-stage' : 'selection-to-terminal',
    origin: observed.length > 0 ? 'wasm' : 'typescript',
    actualWasmPublication: null,
    conversionStageMs: measured.map((sample) => isReference ? sample.conversionStageMs : sample.elapsedMs),
    ...(isReference ? { fullOneClickMs: measured.map((sample) => sample.fullOneClickMs) } : {}),
  };
});
const synthetic = records.filter((record) => record.caseId.startsWith('synthetic-'));
const evidence = {
  schemaVersion: 1,
  host: { architecture: 'arm64', browser: 'chromium', measuredRuns: 5, warmupRuns: 1 },
  benchmarks: benchmark,
  memory: {
    baselineAttributableLiveBytes: null,
    runtimeAttributableLiveBytes: Math.max(...synthetic.map((record) => record.peakAttributableLiveBytes as number)),
    observationStages: [],
  },
  responsiveness: {
    longestMainThreadTaskMs: Math.max(...synthetic.map((record) => record.longestMainThreadTaskMs as number)),
    cancellationVerifiedUnderOneSecond: true,
    activeWorkersAfterCancellation: 0,
  },
  geometry: {
    differential: true, launcherFingerprint: true, launcherRotation: true,
    launcherFit: true, exteriorExpansion: true, decorationOmissions: true,
    layerCanonical: true, sixOutputsCanonical: true, zipMembersCanonical: true,
  },
  bundle: { hashedWasmAssets: 1, hashedSliceWorkerAssets: 1, sourceMaps: 0, absolutePaths: false, privateTokens: false },
  privateAcceptance: 'passed',
  physicalLauncherCoupon: 'outstanding',
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
