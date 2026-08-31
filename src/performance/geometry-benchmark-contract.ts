import { z } from 'zod';

const finiteNonNegative = z.number().finite().nonnegative().safe();
const count = z.number().int().nonnegative().safe();

export const geometryBenchmarkStageMillisecondsSchema = Object.freeze(z.object({
  parse: finiteNonNegative,
  slice: finiteNonNegative,
  canonicalize: finiteNonNegative,
  artifacts: finiteNonNegative,
}).strict().readonly());

const sampleSchema = z.object({
  schemaVersion: z.literal(1),
  stageMilliseconds: geometryBenchmarkStageMillisecondsSchema,
  elapsedMilliseconds: finiteNonNegative,
  estimatedLiveBytes: count,
  triangleCount: count,
  layerCount: count,
}).strict().superRefine((sample, context) => {
  const stageTotal = Object.values(sample.stageMilliseconds)
    .reduce((total, duration) => total + duration, 0);
  const tolerance = Math.max(1e-9, Number.EPSILON * Math.max(1, stageTotal) * 8);
  if (Math.abs(stageTotal - sample.elapsedMilliseconds) > tolerance) {
    context.addIssue({
      code: 'custom',
      path: ['elapsedMilliseconds'],
      message: 'Elapsed milliseconds must equal the sum of stage milliseconds',
    });
  }
}).readonly();

export const geometryBenchmarkSampleSchema = Object.freeze(sampleSchema);
export type GeometryBenchmarkSample = z.infer<typeof geometryBenchmarkSampleSchema>;

const percentileSchema = z.object({
  median: finiteNonNegative,
  p95: finiteNonNegative,
}).strict().readonly();

export const geometryBenchmarkSummarySchema = Object.freeze(z.object({
  schemaVersion: z.literal(1),
  sampleCount: z.number().int().positive().safe(),
  elapsedMilliseconds: percentileSchema,
  estimatedLiveBytes: percentileSchema,
  triangleCount: count,
  layerCount: count,
  stageMilliseconds: z.object({
    parse: percentileSchema,
    slice: percentileSchema,
    canonicalize: percentileSchema,
    artifacts: percentileSchema,
  }).strict().readonly(),
}).strict().readonly());
export type GeometryBenchmarkSummary = z.infer<typeof geometryBenchmarkSummarySchema>;

function summarizeNumbers(values: readonly number[]): { readonly median: number; readonly p95: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return { median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

export function summarizeGeometryBenchmark(
  input: readonly GeometryBenchmarkSample[],
): GeometryBenchmarkSummary {
  if (input.length === 0) throw new RangeError('At least one benchmark sample is required');
  const samples = input.map((sample) => geometryBenchmarkSampleSchema.parse(sample));
  const { triangleCount, layerCount } = samples[0];
  if (samples.some((sample) => (
    sample.triangleCount !== triangleCount || sample.layerCount !== layerCount
  ))) throw new RangeError('Benchmark samples must describe the same geometry counts');

  return geometryBenchmarkSummarySchema.parse({
    schemaVersion: 1,
    sampleCount: samples.length,
    elapsedMilliseconds: summarizeNumbers(samples.map((sample) => sample.elapsedMilliseconds)),
    estimatedLiveBytes: summarizeNumbers(samples.map((sample) => sample.estimatedLiveBytes)),
    triangleCount,
    layerCount,
    stageMilliseconds: {
      parse: summarizeNumbers(samples.map((sample) => sample.stageMilliseconds.parse)),
      slice: summarizeNumbers(samples.map((sample) => sample.stageMilliseconds.slice)),
      canonicalize: summarizeNumbers(samples.map((sample) => sample.stageMilliseconds.canonicalize)),
      artifacts: summarizeNumbers(samples.map((sample) => sample.stageMilliseconds.artifacts)),
    },
  });
}
