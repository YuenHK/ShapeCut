import {
  parseSliceBatchResult,
  publishBundledSliceBatchResult,
} from '../wasm/slice-kernel-contract';

globalThis.addEventListener('message', () => {
  const counters = new Uint32Array(9);
  counters[3] = 1;
  counters[4] = 1;
  const result = parseSliceBatchResult({
    version: 1,
    statusCode: 0,
    planeOffsets: new Uint32Array([0, 1]),
    endpoints: new Float64Array([0, 0, 1, 1]),
    diagnosticCounters: counters,
  }, {
    positions: new Float32Array([0, 0, -1, 2, 0, 1, 0, 2, 1]),
    indices: new Uint32Array([0, 1, 2]),
    planes: new Float64Array([0]),
    deadlineCheckInterval: 4_096,
  }, () => undefined);
  let closedEntryDenied = false;
  try {
    publishBundledSliceBatchResult(result, {
      type: 'slice-result',
      generation: 1,
      partitionIndex: 0,
    });
  } catch {
    closedEntryDenied = true;
  }
  globalThis.postMessage({ closedEntryDenied });
});
