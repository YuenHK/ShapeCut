import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const generated = await import('../src/wasm/generated/geometry_wasm.js');
globalThis.__shapecut_geometry_should_abort = () => false;
const runtime = generated.initSync({
  module: readFileSync(new URL('../src/wasm/generated/geometry_wasm_bg.wasm', import.meta.url)),
});

const failures = [];
function test(name, action) {
  try {
    action();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stderr.write(`not ok - ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const positions = new Float32Array([
  0, 0, 0,
  2, 0, 0,
  0, 2, 0,
  0, 0, 2,
]);
const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
const planes = new Float64Array([0.5, 1]);

test('exposes zero-copy pointer-length output with explicit disposal', () => {
  const result = generated.slice_layer_batch(positions, indices, planes, 2);
  assert.equal(typeof result.planeOffsetsPtr, 'number');
  assert.equal(typeof result.planeOffsetsLen, 'number');
  assert.equal(typeof result.endpointsPtr, 'number');
  assert.equal(typeof result.endpointsLen, 'number');
  assert.equal(typeof result.diagnosticCountersPtr, 'number');
  assert.equal(typeof result.diagnosticCountersLen, 'number');
  const offsets = new Uint32Array(
    runtime.memory.buffer,
    result.planeOffsetsPtr,
    result.planeOffsetsLen,
  );
  const endpoints = new Float64Array(
    runtime.memory.buffer,
    result.endpointsPtr,
    result.endpointsLen,
  );
  const diagnostics = new Uint32Array(
    runtime.memory.buffer,
    result.diagnosticCountersPtr,
    result.diagnosticCountersLen,
  );
  assert.deepEqual(Array.from(offsets), [0, 3, 6]);
  assert.equal(endpoints.length, 24);
  assert.equal(diagnostics[4], 6);
  result.free();
  assert.throws(() => result.planeOffsetsLen);
});

test('calls the bounded WASM deadline hook and fails closed', () => {
  let checks = 0;
  globalThis.__shapecut_geometry_should_abort = () => {
    checks += 1;
    return checks >= 2;
  };
  assert.throws(
    () => generated.slice_layer_batch(positions, indices, planes, 2),
    /deadline|cancel/i,
  );
  assert.equal(checks, 2);
  globalThis.__shapecut_geometry_should_abort = () => false;
});

test('rejects oversized input before growing WASM memory', () => {
  const oversized = new Uint32Array((1_048_576 + 1) * 3);
  const before = runtime.memory.buffer.byteLength;
  assert.throws(
    () => generated.slice_layer_batch(new Float32Array(), oversized, new Float64Array(), 1),
    /triangle count/i,
  );
  assert.equal(runtime.memory.buffer.byteLength, before);
});

test('fails closed when bounded output would be exceeded', () => {
  const triangleCount = 131_073;
  const repeatedIndices = new Uint32Array(triangleCount * 3);
  for (let offset = 0; offset < repeatedIndices.length; offset += 3) {
    repeatedIndices.set([0, 1, 2], offset);
  }
  const crossingTriangle = new Float32Array([
    0, 0, -1,
    2, 0, 1,
    0, 2, 1,
  ]);
  let unexpectedResult;
  assert.throws(() => {
    unexpectedResult = generated.slice_layer_batch(
      crossingTriangle,
      repeatedIndices,
      new Float64Array([-0.5, 0.5]),
      256,
    );
  }, /output.*limit/i);
  unexpectedResult?.free();
});

if (failures.length > 0) {
  process.stderr.write(`${failures.length} WASM boundary test(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('WASM boundary tests passed: 4/4\n');
}
