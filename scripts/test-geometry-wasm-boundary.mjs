import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as generated from '../src/wasm/generated/geometry_wasm.js';
import { initializeSliceKernel } from '../src/wasm/slice-kernel-wrapper.mjs';

const wasmBytes = readFileSync(
  new URL('../src/wasm/generated/geometry_wasm_bg.wasm', import.meta.url),
);
const kernel = initializeSliceKernel(wasmBytes);
const runtime = generated.initSync({ module: wasmBytes });

const failures = [];
function test(name, action) {
  try {
    action();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stderr.write(
      `not ok - ${name}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function expectStructuredError(action, code, phase) {
  assert.throws(action, (error) => {
    assert.equal(error?.name, 'SliceKernelBoundaryError');
    assert.equal(error?.code, code);
    assert.equal(error?.phase, phase);
    return true;
  });
}

const positions = new Float32Array([
  0, 0, 0,
  2, 0, 0,
  0, 2, 0,
  0, 0, 2,
]);
const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
const planes = new Float64Array([0.5, 1]);

function request(deadlineCheckInterval = 2) {
  return { positions, indices, planes, deadlineCheckInterval };
}

test('controlled wrapper publishes stable structured request and deadline codes', () => {
  expectStructuredError(
    () => kernel.sliceLayerBatch({ ...request(), indices: new Int32Array(3) }, {
      deadlineHook: () => false,
    }),
    'INVALID_REQUEST',
    'request',
  );
  expectStructuredError(
    () => kernel.sliceLayerBatch(request(1), {
      deadlineHook: () => { throw new Error('private hook detail'); },
    }),
    'DEADLINE_CHECK_FAILED',
    'execution',
  );
  expectStructuredError(
    () => kernel.sliceLayerBatch(request(1), { deadlineHook: () => true }),
    'DEADLINE_EXCEEDED',
    'execution',
  );
});

test('generated Rust failures cross the controlled boundary with stable resource codes', () => {
  const oversized = new Uint32Array((1_048_576 + 1) * 3);
  expectStructuredError(
    () => kernel.sliceLayerBatch({
      positions: new Float32Array(),
      indices: oversized,
      planes: new Float64Array(),
      deadlineCheckInterval: 1,
    }, { deadlineHook: () => false }),
    'RESOURCE_LIMIT',
    'request',
  );
});

test('controlled wrapper returns owned copies and disposes the raw result exactly once', () => {
  const originalFree = generated.SliceBatchResult.prototype.free;
  let freeCalls = 0;
  generated.SliceBatchResult.prototype.free = function countedFree() {
    freeCalls += 1;
    return originalFree.call(this);
  };
  try {
    const result = kernel.sliceLayerBatch(request(), { deadlineHook: () => false });
    assert.deepEqual(Array.from(result.planeOffsets), [0, 3, 6]);
    assert.equal(result.endpoints.length, 24);
    assert.equal(result.diagnosticCounters[4], 6);
    assert.equal('free' in result, false);
    assert.equal('planeOffsetsPtr' in result, false);
    assert.equal('endpointsPtr' in result, false);
    assert.notEqual(result.planeOffsets.buffer, runtime.memory.buffer);
    assert.notEqual(result.endpoints.buffer, runtime.memory.buffer);
    assert.notEqual(result.diagnosticCounters.buffer, runtime.memory.buffer);
    assert.equal(freeCalls, 1, 'the wrapper must not leak or double-free the raw result');
  } finally {
    generated.SliceBatchResult.prototype.free = originalFree;
  }
});

for (const [name, hook] of [
  ['missing', undefined],
  ['throw', () => { throw new Error('hook failure'); }],
  ['undefined', () => undefined],
  ['null', () => null],
  ['numeric', () => 1],
  ['NaN', () => Number.NaN],
  ['Promise', () => Promise.resolve(false)],
]) {
  test(`deadline hook fails closed for ${name}`, () => {
    expectStructuredError(
      () => kernel.sliceLayerBatch(request(1), { deadlineHook: hook }),
      'DEADLINE_CHECK_FAILED',
      'execution',
    );
  });
}

test('deadline hook accepts strict false and returns a result', () => {
  const result = kernel.sliceLayerBatch(request(1), { deadlineHook: () => false });
  assert.deepEqual(Array.from(result.planeOffsets), [0, 3, 6]);
});

test('deadline hook accepts strict true and cancels', () => {
  expectStructuredError(
    () => kernel.sliceLayerBatch(request(1), { deadlineHook: () => true }),
    'DEADLINE_EXCEEDED',
    'execution',
  );
});

test('deadline hook is required even for an empty request', () => {
  expectStructuredError(
    () => kernel.sliceLayerBatch(
      {
        positions: new Float32Array(),
        indices: new Uint32Array(),
        planes: new Float64Array(),
        deadlineCheckInterval: 4_096,
      },
      { deadlineHook: undefined },
    ),
    'DEADLINE_CHECK_FAILED',
    'execution',
  );
});

for (const [interval, code] of [
  [0.5, 'INVALID_REQUEST'],
  [Number.NaN, 'INVALID_REQUEST'],
  [Number.POSITIVE_INFINITY, 'INVALID_REQUEST'],
  [-1, 'INVALID_REQUEST'],
  [0, 'INVALID_REQUEST'],
  [Number.MAX_SAFE_INTEGER + 1, 'INVALID_REQUEST'],
  [(2 ** 32) + 1, 'RESOURCE_LIMIT'],
]) {
  test(`rejects uncoerced invalid deadline interval ${String(interval)}`, () => {
    expectStructuredError(
      () => kernel.sliceLayerBatch(request(interval), { deadlineHook: () => false }),
      code,
      'request',
    );
  });
}

for (const interval of [1, 4_096]) {
  test(`accepts uncoerced valid deadline interval endpoint ${interval}`, () => {
    const result = kernel.sliceLayerBatch(request(interval), { deadlineHook: () => false });
    assert.deepEqual(Array.from(result.planeOffsets), [0, 3, 6]);
  });
}

test('checkpoints during large WASM input copies', () => {
  const largePositions = new Float32Array((4_096 * 3) + 3);
  let checks = 0;
  const result = kernel.sliceLayerBatch(
    {
      positions: largePositions,
      indices: new Uint32Array(),
      planes: new Float64Array(),
      deadlineCheckInterval: 4_096,
    },
    {
      deadlineHook: () => {
        checks += 1;
        return false;
      },
    },
  );
  assert.deepEqual(Array.from(result.planeOffsets), [0]);
  assert.ok(checks >= 8, `expected copy and validation checkpoints, got ${checks}`);
});

test('checkpoints index validation and triangle degeneracy preprocessing', () => {
  const triangleCount = 5_000;
  const repeatedIndices = new Uint32Array(triangleCount * 3);
  for (let offset = 0; offset < repeatedIndices.length; offset += 3) {
    repeatedIndices.set([0, 1, 2], offset);
  }
  let checks = 0;
  const result = kernel.sliceLayerBatch(
    {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: repeatedIndices,
      planes: new Float64Array(),
      deadlineCheckInterval: 4_096,
    },
    {
      deadlineHook: () => {
        checks += 1;
        return false;
      },
    },
  );
  assert.deepEqual(Array.from(result.planeOffsets), [0]);
  assert.ok(checks >= 12, `expected copy, validation and prepass checkpoints, got ${checks}`);
});

test('checkpoints controlled output copy and validation in bounded chunks', () => {
  const triangleCount = 5_000;
  const repeatedIndices = new Uint32Array(triangleCount * 3);
  for (let offset = 0; offset < repeatedIndices.length; offset += 3) {
    repeatedIndices.set([0, 1, 2], offset);
  }
  let checks = 0;
  const result = kernel.sliceLayerBatch(
    {
      positions: new Float32Array([0, 0, -1, 2, 0, 1, 0, 2, 1]),
      indices: repeatedIndices,
      planes: new Float64Array([0]),
      deadlineCheckInterval: 4_096,
    },
    {
      deadlineHook: () => {
        checks += 1;
        return false;
      },
    },
  );
  assert.equal(result.endpoints.length, triangleCount * 4);
  assert.ok(checks >= 34, `expected output copy and validation checkpoints, got ${checks}`);
});

test('strictly checkpoints before and after each sole bounded owned-array allocation', () => {
  let checks = 0;
  const result = kernel.sliceLayerBatch(
    {
      positions: new Float32Array(),
      indices: new Uint32Array(),
      planes: new Float64Array(),
      deadlineCheckInterval: 4_096,
    },
    {
      deadlineHook: () => {
        checks += 1;
        return false;
      },
    },
  );

  assert.deepEqual(Array.from(result.planeOffsets), [0]);
  assert.equal(result.endpoints.length, 0);
  assert.equal(result.diagnosticCounters.length, 9);
  assert.equal(checks, 10, 'three owned allocations require strict pre/post checkpoints');
});

test('accepts the exact 8 MiB contiguous owned-output hard cap', () => {
  const triangleCount = 131_072;
  const repeatedIndices = new Uint32Array(triangleCount * 3);
  for (let offset = 0; offset < repeatedIndices.length; offset += 3) {
    repeatedIndices.set([0, 1, 2], offset);
  }
  const result = kernel.sliceLayerBatch(
    {
      positions: new Float32Array([0, 0, -1, 2, 0, 1, 0, 2, 1]),
      indices: repeatedIndices,
      planes: new Float64Array([-0.5, 0.5]),
      deadlineCheckInterval: 4_096,
    },
    { deadlineHook: () => false },
  );

  assert.equal(result.endpoints.byteLength, 8 * 1024 * 1024);
  assert.deepEqual(Array.from(result.planeOffsets), [0, triangleCount, triangleCount * 2]);
});

test('rejects a raw output above the 8 MiB owned cap before allocation', () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    generated.SliceBatchResult.prototype,
    'endpointsLen',
  );
  assert.ok(descriptor);
  Object.defineProperty(generated.SliceBatchResult.prototype, 'endpointsLen', {
    configurable: true,
    get() {
      return (8 * 1024 * 1024 / Float64Array.BYTES_PER_ELEMENT) + 1;
    },
  });
  try {
    expectStructuredError(
      () => kernel.sliceLayerBatch(request(), { deadlineHook: () => false }),
      'INVALID_RESULT',
      'result',
    );
  } finally {
    Object.defineProperty(generated.SliceBatchResult.prototype, 'endpointsLen', descriptor);
  }
});

test('retained copied views survive raw free and later WASM memory growth', () => {
  const retained = kernel.sliceLayerBatch(request(), { deadlineHook: () => false });
  const retainedOffsets = Array.from(retained.planeOffsets);
  const retainedEndpoints = Array.from(retained.endpoints);
  const before = runtime.memory.buffer.byteLength;

  const largePositions = new Float32Array(9_000_000);
  kernel.sliceLayerBatch(
    {
      positions: largePositions,
      indices: new Uint32Array(),
      planes: new Float64Array(),
      deadlineCheckInterval: 4_096,
    },
    { deadlineHook: () => false },
  );

  assert.ok(runtime.memory.buffer.byteLength > before, 'test must force memory growth');
  assert.deepEqual(Array.from(retained.planeOffsets), retainedOffsets);
  assert.deepEqual(Array.from(retained.endpoints), retainedEndpoints);
});

test('rejects oversized input before growing WASM memory', () => {
  const oversized = new Uint32Array((1_048_576 + 1) * 3);
  const before = runtime.memory.buffer.byteLength;
  expectStructuredError(
    () => kernel.sliceLayerBatch(
      {
        positions: new Float32Array(),
        indices: oversized,
        planes: new Float64Array(),
        deadlineCheckInterval: 1,
      },
      { deadlineHook: () => false },
    ),
    'RESOURCE_LIMIT',
    'request',
  );
  assert.equal(runtime.memory.buffer.byteLength, before);
});

test('fails closed when bounded output would be exceeded', () => {
  const triangleCount = 131_073;
  const repeatedIndices = new Uint32Array(triangleCount * 3);
  for (let offset = 0; offset < repeatedIndices.length; offset += 3) {
    repeatedIndices.set([0, 1, 2], offset);
  }
  expectStructuredError(
    () => kernel.sliceLayerBatch(
      {
        positions: new Float32Array([0, 0, -1, 2, 0, 1, 0, 2, 1]),
        indices: repeatedIndices,
        planes: new Float64Array([-0.5, 0.5]),
        deadlineCheckInterval: 256,
      },
      { deadlineHook: () => false },
    ),
    'RESOURCE_LIMIT',
    'execution',
  );
});

if (failures.length > 0) {
  process.stderr.write(`${failures.length} WASM boundary test(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('WASM boundary tests passed\n');
}
