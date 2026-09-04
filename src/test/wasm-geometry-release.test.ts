import { describe, expect, it } from 'vitest';

import {
  verifyWasmGeometryRelease,
  type WasmGeometryReleaseEvidence,
} from '../../scripts/verify-wasm-geometry-release';

function validEvidence(): WasmGeometryReleaseEvidence {
  const measured = [14_000, 14_200, 14_100, 14_300, 14_050];
  return {
    schemaVersion: 1,
    host: { architecture: 'arm64', browser: 'chromium', measuredRuns: 5, warmupRuns: 1 },
    benchmarks: [
      { caseId: 'reference-a', kind: 'private-reference', triangleCount: 1, layerCount: 1, measurementInterval: 'conversion-stage', origin: 'wasm', actualWasmPartitionsObserved: true, conversionStageMs: measured, fullOneClickMs: [30_000, 30_100, 30_200, 30_300, 30_400] },
      { caseId: 'reference-b', kind: 'private-reference', triangleCount: 1, layerCount: 1, measurementInterval: 'conversion-stage', origin: 'wasm', actualWasmPartitionsObserved: true, conversionStageMs: measured, fullOneClickMs: [31_000, 31_100, 31_200, 31_300, 31_400] },
      ...([200_000, 500_000, 1_000_000] as const).map((triangleCount) => ({
        caseId: `synthetic-${triangleCount}` as const,
        kind: 'synthetic' as const,
        triangleCount,
        layerCount: 1,
        measurementInterval: 'selection-to-cancel-cleanup' as const,
        origin: 'wasm' as const,
        actualWasmPartitionsObserved: true,
        conversionStageMs: measured,
      })),
    ],
    memory: {
      baselineAttributableLiveBytes: 100_000,
      runtimeAttributableLiveBytes: 65_000,
      observationStages: ['pipeline:stl-received', 'slice-pool:partitions-ready', 'slice-pool:result-merged', 'slice-pool:cleanup'],
    },
    responsiveness: { longestMainThreadTaskMs: 99, cancellationVerifiedUnderOneSecond: true, activeWorkersAfterCancellation: 0 },
    geometry: {
      differential: true, launcherFingerprint: true, launcherRotation: true,
      launcherFit: true, exteriorExpansion: true, decorationOmissions: true,
      layerCanonical: true, sixOutputsCanonical: true, zipMembersCanonical: true,
    },
    bundle: { hashedWasmAssets: 1, hashedSliceWorkerAssets: 1, sourceMaps: 0, absolutePaths: false, privateTokens: false },
    privateAcceptance: 'passed',
    physicalLauncherCoupon: 'outstanding',
  };
}

describe('WASM geometry release verifier', () => {
  it('accepts complete software evidence while reporting physical acceptance separately', () => {
    const result = verifyWasmGeometryRelease(validEvidence());
    expect(result.softwareReleaseEligible).toBe(true);
    expect(result.productionRolloutEligible).toBe(false);
    expect(result.externalOutstanding).toEqual(['physical-launcher-coupon']);
    expect(result.benchmarks.slice(0, 2).map(({ conversionMedianMs }) => conversionMedianMs))
      .toEqual([14_100, 14_100]);
    expect(result.liveByteReductionPercent).toBe(35);
  });

  it('requires exactly one warmup and five measured trials on Apple Silicon Chromium', () => {
    for (const mutation of [
      (e: WasmGeometryReleaseEvidence) => { (e.host as { architecture: string }).architecture = 'x64'; },
      (e: WasmGeometryReleaseEvidence) => { (e.host as { browser: string }).browser = 'firefox'; },
      (e: WasmGeometryReleaseEvidence) => { (e.host as { warmupRuns: number }).warmupRuns = 0; },
      (e: WasmGeometryReleaseEvidence) => { e.benchmarks[0].conversionStageMs.pop(); },
    ]) {
      const evidence = structuredClone(validEvidence()); mutation(evidence);
      expect(() => verifyWasmGeometryRelease(evidence)).toThrow(/Apple Silicon|Chromium|warmup|five measured/i);
    }
  });

  it('keeps conversion-stage and full one-click timings separate', () => {
    const result = verifyWasmGeometryRelease(validEvidence());
    expect(result.benchmarks[0]).toMatchObject({ conversionMedianMs: 14_100, fullOneClickMedianMs: 30_200 });
  });

  it('rejects performance, memory, responsiveness, worker and geometry gate failures', () => {
    const cases: Array<(e: WasmGeometryReleaseEvidence) => void> = [
      (e) => { e.benchmarks[0].conversionStageMs.fill(15_001); },
      (e) => { e.memory.runtimeAttributableLiveBytes = 70_001; },
      (e) => { e.responsiveness.longestMainThreadTaskMs = 100; },
      (e) => { e.responsiveness.cancellationVerifiedUnderOneSecond = false; },
      (e) => { e.responsiveness.activeWorkersAfterCancellation = 1; },
      (e) => { e.geometry.sixOutputsCanonical = false; },
      (e) => { e.geometry.zipMembersCanonical = false; },
      (e) => { e.benchmarks[0].origin = 'typescript'; e.benchmarks[0].actualWasmPartitionsObserved = false; },
    ];
    for (const mutate of cases) {
      const evidence = structuredClone(validEvidence()); mutate(evidence);
      expect(verifyWasmGeometryRelease(evidence).softwareReleaseEligible).toBe(false);
    }
  });

  it('truthfully blocks release when private references are absent', () => {
    const evidence = validEvidence(); evidence.privateAcceptance = 'conditional-skip';
    expect(verifyWasmGeometryRelease(evidence)).toMatchObject({
      softwareReleaseEligible: false,
      productionRolloutEligible: false,
    });
  });

  it('does not invent a memory reduction when no comparable runtime baseline exists', () => {
    const evidence = validEvidence(); evidence.memory.baselineAttributableLiveBytes = null;
    expect(verifyWasmGeometryRelease(evidence)).toMatchObject({
      softwareReleaseEligible: false,
      liveByteReductionPercent: null,
      failedGates: expect.arrayContaining(['live-byte-baseline']),
    });
  });

  it.each(['fileName', 'path', 'hash', 'modelName', 'account', 'email'])('rejects private field %s', (field) => {
    expect(() => verifyWasmGeometryRelease({ ...validEvidence(), [field]: 'secret' } as never)).toThrow();
  });
});
