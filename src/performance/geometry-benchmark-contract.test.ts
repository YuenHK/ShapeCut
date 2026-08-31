import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const validSample = {
  schemaVersion: 1,
  stageMilliseconds: {
    parse: 2,
    slice: 5,
    canonicalize: 2,
    artifacts: 1,
  },
  elapsedMilliseconds: 10,
  estimatedLiveBytes: 1024,
  triangleCount: 12,
  layerCount: 3,
} as const;

describe('linked worktree dependency contract', () => {
  it('resolves vite-node through npm exec', () => {
    expect(existsSync(resolve(process.cwd(), 'node_modules/.bin/vite-node'))).toBe(true);
    const version = execFileSync('npm', ['exec', 'vite-node', '--', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(version).toMatch(/vite-node\/3\.2\.4/);
  });

  it('starts the fixture validator child process through npm exec', () => {
    const result = spawnSync(
      'npm',
      ['exec', 'vite-node', '--', 'scripts/validate-fixtures.ts', '--dependency-contract'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage: validate-fixtures.ts [--public-only]');
    expect(result.stderr).not.toMatch(/could not determine executable|ENOENT|MODULE_NOT_FOUND/);
  });
});

describe('geometry benchmark contract', () => {
  it('accepts only frozen benchmark schemas', async () => {
    const {
      geometryBenchmarkSampleSchema,
      geometryBenchmarkStageMillisecondsSchema,
      geometryBenchmarkSummarySchema,
    } = await import('./geometry-benchmark-contract');
    const parsed = geometryBenchmarkSampleSchema.parse(validSample);
    expect(parsed).toEqual(validSample);
    expect(Object.isFrozen(geometryBenchmarkSampleSchema)).toBe(true);
    expect(Object.isFrozen(geometryBenchmarkStageMillisecondsSchema)).toBe(true);
    expect(Object.isFrozen(geometryBenchmarkSummarySchema)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.stageMilliseconds)).toBe(true);
  });

  it.each(['fileName', 'filename', 'path', 'hash', 'geometryHash'])(
    'rejects identifying field %s',
    async (field) => {
      const { geometryBenchmarkSampleSchema } = await import('./geometry-benchmark-contract');
      expect(() => geometryBenchmarkSampleSchema.parse({ ...validSample, [field]: 'private.stl' }))
        .toThrow();
    },
  );

  it.each([
    ['non-finite duration', { ...validSample, elapsedMilliseconds: Number.NaN }],
    ['negative duration', { ...validSample, elapsedMilliseconds: -1 }],
    ['non-finite live bytes', { ...validSample, estimatedLiveBytes: Number.POSITIVE_INFINITY }],
    ['negative stage duration', {
      ...validSample,
      stageMilliseconds: { ...validSample.stageMilliseconds, slice: -1 },
    }],
    ['inconsistent total', { ...validSample, elapsedMilliseconds: 11 }],
  ])('rejects %s', async (_label, sample) => {
    const { geometryBenchmarkSampleSchema } = await import('./geometry-benchmark-contract');
    expect(() => geometryBenchmarkSampleSchema.parse(sample)).toThrow();
  });

  it.each([
    ['elapsed duration', {
      ...validSample,
      stageMilliseconds: { parse: Number.MAX_SAFE_INTEGER + 1, slice: 0, canonicalize: 0, artifacts: 0 },
      elapsedMilliseconds: Number.MAX_SAFE_INTEGER + 1,
    }],
    ['stage duration', {
      ...validSample,
      stageMilliseconds: { ...validSample.stageMilliseconds, parse: Number.MAX_SAFE_INTEGER + 1 },
      elapsedMilliseconds: Number.MAX_SAFE_INTEGER + 9,
    }],
  ])('rejects unsafe %s', async (_label, sample) => {
    const { geometryBenchmarkSampleSchema } = await import('./geometry-benchmark-contract');
    expect(() => geometryBenchmarkSampleSchema.parse(sample)).toThrow();
  });

  it('rejects unsafe duration summary percentiles', async () => {
    const { geometryBenchmarkSummarySchema } = await import('./geometry-benchmark-contract');
    expect(() => geometryBenchmarkSummarySchema.parse({
      schemaVersion: 1,
      sampleCount: 1,
      elapsedMilliseconds: { median: Number.MAX_SAFE_INTEGER + 1, p95: 1 },
      estimatedLiveBytes: { median: 1, p95: 1 },
      triangleCount: 1,
      layerCount: 1,
      stageMilliseconds: {
        parse: { median: 1, p95: 1 },
        slice: { median: 1, p95: 1 },
        canonicalize: { median: 1, p95: 1 },
        artifacts: { median: 1, p95: 1 },
      },
    })).toThrow();
  });

  it('returns deterministic median and nearest-rank p95 summaries', async () => {
    const { summarizeGeometryBenchmark } = await import('./geometry-benchmark-contract');
    const samples = [1, 2, 3, 4, 100].map((elapsedMilliseconds) => ({
      ...validSample,
      stageMilliseconds: {
        parse: elapsedMilliseconds,
        slice: 0,
        canonicalize: 0,
        artifacts: 0,
      },
      elapsedMilliseconds,
      estimatedLiveBytes: elapsedMilliseconds * 100,
    }));
    expect(summarizeGeometryBenchmark(samples)).toEqual({
      schemaVersion: 1,
      sampleCount: 5,
      elapsedMilliseconds: { median: 3, p95: 100 },
      estimatedLiveBytes: { median: 300, p95: 10_000 },
      triangleCount: 12,
      layerCount: 3,
      stageMilliseconds: {
        parse: { median: 3, p95: 100 },
        slice: { median: 0, p95: 0 },
        canonicalize: { median: 0, p95: 0 },
        artifacts: { median: 0, p95: 0 },
      },
    });
  });
});
