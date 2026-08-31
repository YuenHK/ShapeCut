import * as contract from '../wasm/slice-kernel-contract';

globalThis.addEventListener('message', () => {
  globalThis.postMessage({
    closedEntryDenied: !('publishBundledSliceBatchResult' in contract),
  });
});
