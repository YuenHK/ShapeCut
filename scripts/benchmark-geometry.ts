import { readFile } from 'node:fs/promises';
import {
  geometryBenchmarkSampleSchema,
  summarizeGeometryBenchmark,
} from '../src/performance/geometry-benchmark-contract';

const inputPath = process.argv[2];
if (inputPath === undefined || process.argv.length !== 3) {
  throw new Error('Usage: benchmark-geometry.ts <numeric-samples.json>');
}

const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(input)) throw new TypeError('Benchmark input must be an array');
const samples = input.map((sample) => geometryBenchmarkSampleSchema.parse(sample));
process.stdout.write(`${JSON.stringify(summarizeGeometryBenchmark(samples), null, 2)}\n`);
