import * as contract from '../wasm/slice-kernel-contract';

globalThis.postMessage({
  marker: 'crafted-production-worker-contract-surface',
  publisherExported: 'publishBundledSliceBatchResult' in contract,
});
