# Review package: 27afe35..08716dc

## Commits
08716dc fix: gate wasm canonical extraction rollout

## Files changed
 .superpowers/sdd/task-5-report.md              | 47 ++++++++++++++++++++++--
 src/domain/outline-2.5d/segment-source.test.ts | 27 ++++++++++++++
 src/workers/geometry-client.ts                 |  7 +++-
 src/workers/geometry-worker.browser.test.ts    | 42 ++++++++++++++++++++--
 src/workers/geometry.worker.ts                 | 49 ++++++++++++++++----------
 5 files changed, 147 insertions(+), 25 deletions(-)

## Diff
diff --git a/.superpowers/sdd/task-5-report.md b/.superpowers/sdd/task-5-report.md
index b766c53..1e21b47 100644
--- a/.superpowers/sdd/task-5-report.md
+++ b/.superpowers/sdd/task-5-report.md
@@ -1,19 +1,60 @@
 # Task 5 報告：WASM segments 接入 canonical extraction

 ## 狀態

-READY_FOR_FINAL_REVIEW。
+READY_FOR_REVIEW。最新獨立 review 的 C1、I1 及 I2 修正已完成，但本報告不會
+在新一輪獨立 review 回覆前聲稱已獲批准。

-Final implementation commit 是 `819a1b9`。Review findings 1–9 已按嚴格
+Earlier final-review implementation commit 是 `819a1b9`。Review findings 1–9 已按嚴格
 RED → GREEN 處理，implementation worktree 及 detached fresh clone 的完整 gate
-均已完成；本報告不會在正式獨立 review 回覆前聲稱已獲批准。
+均已完成。最新 gate fix 是包含本報告的 commit。
+
+### C1：Task 7 前 production default-off rollout gate
+
+- 根因：`geometry.worker.ts` 原先無條件建構 `WasmExactSegmentSource`，並將它
+  注入每次 production conversion；沒有 rollout gate。
+- RED：新 default-production Chromium regression 是 0/1（1 failed、36 skipped）。
+  Worker state 沒有 `rolloutEnabled: false` 或 `sourceConstructed: false`，而舊路徑
+  會建構及執行 WASM source。
+- GREEN：新的明確 rollout flag 是 page query `shapecut-wasm-rollout=1`。
+  Geometry client 只在值精確為 `1` 時把 flag 傳入 worker；worker 只在同一條件
+  下建構及注入 WASM source。Flag 缺省、空白或非 `1` 時繼續使用原本
+  TypeScript production path，不建構 source、不啟動 worker、不會 publication；
+  generation 及 active worker count 在 conversion 前後都是 0。沒有 UI、CSS、文案
+  或 interaction 改動。
+- Focused Chromium GREEN：default-off 與 explicit-on 2/2；連同 actual-WASM
+  cancel/replacement 為 3/3（4.101 s、8.827 s、12.107 s），每-test 15 秒 gate
+  沒有放寬。完整 geometry-worker Chromium 為 37/37（86.84 s）。
+
+### I1：exact-Float32 same-topology wrong-coordinate differential
+
+- 新 regression 使用 exact-Float32 box projected mesh；worker result 保持相同 layer
+  及 segment 數量，但改動一個座標。測試明確要求 runner 只執行一次、
+  錯誤 WASM 不 publication，回傳 original TypeScript oracle。
+- Mutation RED：暫時停用 coordinate comparison 後 0/1（1 failed、16 skipped），
+  實際收到 `origin: wasm` 與錯誤座標，證明新測試不會被 exact-Float32
+  preflight 短路。
+- GREEN：還原 fail-closed coordinate comparison 後 1/1（16 skipped）；完整
+  segment-source Node 為 17/17。Runner 呼叫一次、publication 零次、回傳值與
+  original TypeScript oracle 完全相同。
+
+### 最新 gate-fix verification
+
+- Automatic pipeline：37/37（145.36 s），每-test 20 秒 gate 沒有放寬。
+- Geometry-worker Chromium：37/37（86.84 s），每-test 15 秒 gate 沒有放寬。
+- Typecheck：passed。Production build：passed；177 modules transformed。
+- Bundle：1 個 hashed slice worker、1 個 hashed WASM、0 source maps；沒有 absolute
+  local paths、private fixture token、private model path 或 model data。
+- 本次沒有重跑無關的 full 75-file Node、full 9-file Chromium、E2E、private
+  heavy fixtures、Rust 或 raw-WASM gates；最新改動只觸及 production rollout routing、
+  worker acceptance probes 及 TypeScript differential regression。

 Production canonical extraction 只在所有 projected positions 均可 exact Float32
 round-trip、worker batch validation 及 publication boundary 全部通過後，才使用
 canonical-sorted WASM segments。TypeScript 仍負責 topology、材料驗證、launcher
 planning、canonical assembly、preview 及所有 release artifacts。沒有修改 UI、CSS、
 字體、字型、大小、顏色、layout、材料規則、launcher 規則或 production error
 classification。

 ## TDD RED → GREEN

diff --git a/src/domain/outline-2.5d/segment-source.test.ts b/src/domain/outline-2.5d/segment-source.test.ts
index 9f50af3..c823bf3 100644
--- a/src/domain/outline-2.5d/segment-source.test.ts
+++ b/src/domain/outline-2.5d/segment-source.test.ts
@@ -189,20 +189,47 @@ describe('exact segment sources', () => {
       compareWithTypeScript: true,
       minimumWasmWork: 0,
       onPublication: publication,
     });

     await expect(source.collect(projected, specs, Infinity, () => undefined))
       .resolves.toMatchObject({ origin: 'typescript' });
     expect(publication).not.toHaveBeenCalled();
   });

+  it('rejects same-topology wrong coordinates from an executed runner before publication', async () => {
+    const projected = projectMesh(box(), selection, Infinity);
+    const oracle = await new TypeScriptExactSegmentSource()
+      .collect(projected, specs, Infinity, () => undefined);
+    const wrongCoordinates = oracle.layers[0].segments.flatMap((segment, segmentIndex) => (
+      segment.flatMap((point, pointIndex) => point.map((coordinate, coordinateIndex) => (
+        segmentIndex === 0 && pointIndex === 0 && coordinateIndex === 0
+          ? coordinate + 0.25
+          : coordinate
+      )))
+    ));
+    const batchRunner = runner(result(wrongCoordinates));
+    const publication = vi.fn();
+    const source = new WasmExactSegmentSource({
+      runner: batchRunner,
+      compareWithTypeScript: true,
+      minimumWasmWork: 0,
+      onPublication: publication,
+    });
+
+    const collected = await source.collect(projected, specs, Infinity, () => undefined);
+
+    expect(batchRunner.run).toHaveBeenCalledOnce();
+    expect(collected).toEqual(oracle);
+    expect(publication).not.toHaveBeenCalled();
+  });
+
   it('preselects the original TypeScript source for Float32-unsafe coordinates without starting a worker', async () => {
     const projected: ProjectedMesh = Object.freeze({
       vertices: Object.freeze([
         Object.freeze([100_000_000.25, 0, -1] as const),
         Object.freeze([100_000_001.25, 0, 1] as const),
         Object.freeze([100_000_000.25, 1, 1] as const),
       ]),
       triangles: Object.freeze([Object.freeze([0, 1, 2] as const)]),
       minX: 100_000_000.25,
       minY: 0,
diff --git a/src/workers/geometry-client.ts b/src/workers/geometry-client.ts
index 8349f18..0f1f4d6 100644
--- a/src/workers/geometry-client.ts
+++ b/src/workers/geometry-client.ts
@@ -210,21 +210,26 @@ function createRestartableGeometryClient(initialWorker: Worker, workerFactory: (
     abortExecution: releaseCurrentWorker,
     release: releaseCurrentWorker,
   });
 }

 export function createGeometryWorkerClient(): GeometryClient {
   return createRestartableGeometryClient(createGeometryWorker(), createGeometryWorker);
 }

 function createGeometryWorker(): Worker {
-  return new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
+  const workerUrl = new URL('./geometry.worker.ts', import.meta.url);
+  const pageUrl = new URL(globalThis.location.href);
+  if (pageUrl.searchParams.get('shapecut-wasm-rollout') === '1') {
+    workerUrl.searchParams.set('shapecut-wasm-rollout', '1');
+  }
+  return new Worker(workerUrl, { type: 'module' });
 }

 function dynamicApi(
   getRemote: () => Remote<GeometryApi>,
   progressCleanups: Set<() => void>,
 ): GeometryApi {
   return {
     createStlPresentation: (input) => getRemote().createStlPresentation(input),
     inspect: (input) => getRemote().inspect(input),
     convertAutomatically: async (request, onProgress) => {
diff --git a/src/workers/geometry-worker.browser.test.ts b/src/workers/geometry-worker.browser.test.ts
index 24b9e83..bd948ae 100644
--- a/src/workers/geometry-worker.browser.test.ts
+++ b/src/workers/geometry-worker.browser.test.ts
@@ -41,34 +41,39 @@ function createGeometryWorkerClient(): TestGeometryClient {
     }, onProgress),
   };
 }
 function createRawGeometryWorkerApi(): Remote<GeometryApi> {
   const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
   const api = wrap<GeometryApi>(worker);
   rawWorkers.push(worker);
   rawWorkerApis.push(api);
   return api;
 }
-function createAcceptanceGeometryWorker(): { readonly worker: Worker; readonly api: Remote<GeometryApi> } {
+function createAcceptanceGeometryWorker(
+  wasmRolloutEnabled = false,
+): { readonly worker: Worker; readonly api: Remote<GeometryApi> } {
   const url = new URL('./geometry.worker.ts', import.meta.url);
   url.searchParams.set('shapecut-acceptance', '1');
+  if (wasmRolloutEnabled) url.searchParams.set('shapecut-wasm-rollout', '1');
   const worker = new Worker(url, { type: 'module' });
   const api = wrap<GeometryApi>(worker);
   rawWorkers.push(worker);
   rawWorkerApis.push(api);
   return { worker, api };
 }
 type WasmAccelerationState = Readonly<{
   type: 'SHAPECUT_WASM_STATE';
   requestId: number;
   generation: number;
   activeWorkerCount: number;
+  rolloutEnabled: boolean;
+  sourceConstructed: boolean;
 }>;
 let wasmStateRequestId = 0;
 function requestWasmAccelerationState(
   worker: Worker,
   action: 'SHAPECUT_WASM_STATE_REQUEST' | 'SHAPECUT_WASM_CANCEL_REQUEST',
 ): Promise<WasmAccelerationState> {
   const requestId = ++wasmStateRequestId;
   return new Promise((resolve, reject) => {
     const timeout = setTimeout(() => {
       worker.removeEventListener('message', listener);
@@ -157,22 +162,53 @@ function cacheResult(index: number): AutomaticOutlineResult {
   };
 }

 afterEach(() => {
   for (const client of clients.splice(0)) client.dispose();
   for (const api of rawWorkerApis.splice(0)) api[releaseProxy]();
   for (const worker of rawWorkers.splice(0)) worker.terminate();
 });

 describe('geometry worker boundary', () => {
-  it('uses verified WASM segments in production canonical extraction without changing launcher artifacts', async () => {
+  it('keeps the production default on TypeScript without constructing or executing WASM', async () => {
     const { worker, api } = createAcceptanceGeometryWorker();
+    const publications: GeometryAccelerationProbe[] = [];
+    worker.addEventListener('message', (event) => {
+      if (event.data?.type === 'SHAPECUT_WASM_SEGMENTS_PUBLISHED') publications.push(event.data);
+    });
+
+    const before = await requestWasmAccelerationState(worker, 'SHAPECUT_WASM_STATE_REQUEST');
+    const converted = await api.convertAutomatically({
+      bytes: writeBinarySTL(launcherCompatibleCylinder(12), 'safe'),
+      material: testMaterial,
+      launcherFitOffsetMm: 0,
+    });
+    const after = await requestWasmAccelerationState(worker, 'SHAPECUT_WASM_STATE_REQUEST');
+
+    expect(converted).toMatchObject({ mode: 'exact' });
+    expect(before).toMatchObject({
+      rolloutEnabled: false,
+      sourceConstructed: false,
+      generation: 0,
+      activeWorkerCount: 0,
+    });
+    expect(after).toMatchObject({
+      rolloutEnabled: false,
+      sourceConstructed: false,
+      generation: 0,
+      activeWorkerCount: 0,
+    });
+    expect(publications).toEqual([]);
+  });
+
+  it('uses verified WASM segments in production canonical extraction without changing launcher artifacts', async () => {
+    const { worker, api } = createAcceptanceGeometryWorker(true);
     const source = writeBinarySTL(launcherCompatibleCylinder(12), 'safe');
     const publication = new Promise<unknown>((resolve) => {
       worker.addEventListener('message', (event) => {
         if (event.data?.type === 'SHAPECUT_WASM_SEGMENTS_PUBLISHED') resolve(event.data);
       });
     });
     const baseline = await convertAutomaticOutline({
       bytes: source.slice(0), material: testMaterial, launcherFitOffsetMm: 0,
     });
     const baselineArtifacts = await createOutlinePackage(baseline);
@@ -202,21 +238,21 @@ describe('geometry worker boundary', () => {
       artifactSha256(baselineArtifacts.cutSvg),
       artifactSha256(baselineArtifacts.cutDxf),
       artifactSha256(baselineArtifacts.previewPdf),
       artifactSha256(baselineArtifacts.explodedViewPdf),
       artifactSha256(baselineArtifacts.launcherCouponSvg),
       canonicalZipMemberIdentities(baselineArtifacts.zip),
     ]));
   });

   it('cancels actual WASM singleton workers without late publication and replaces with a clean generation', async () => {
-    const { worker, api } = createAcceptanceGeometryWorker();
+    const { worker, api } = createAcceptanceGeometryWorker(true);
     const publications: Array<GeometryAccelerationProbe & { readonly generation: number }> = [];
     worker.addEventListener('message', (event) => {
       if (event.data?.type === 'SHAPECUT_WASM_SEGMENTS_PUBLISHED') publications.push(event.data);
     });
     const firstOutcome = startWasmCancellationWork(worker);
     let active!: WasmAccelerationState;
     await vi.waitFor(async () => {
       active = await requestWasmAccelerationState(worker, 'SHAPECUT_WASM_STATE_REQUEST');
       expect(active.activeWorkerCount).toBeGreaterThan(0);
     }, { timeout: 5_000, interval: 10 });
diff --git a/src/workers/geometry.worker.ts b/src/workers/geometry.worker.ts
index 428431f..077ed17 100644
--- a/src/workers/geometry.worker.ts
+++ b/src/workers/geometry.worker.ts
@@ -29,64 +29,77 @@ import {
   type GeometryApi,
   type ImportRepairAnalysis,
   type MeshAnalysis,
   type OutlineArtifactId,
   type OutlinePackageTransfer,
 } from './geometry-api';
 import { InternalAutomaticResultCache } from './internal-automatic-result-cache';

 let nearLimitPackageWorkload: ReturnType<typeof nearLimitColoredResult> | undefined;
 const internalResultCache = new InternalAutomaticResultCache();
-const acceptanceProbeEnabled = new URL(globalThis.location.href).searchParams.get('shapecut-acceptance') === '1';
-const exactSegmentSource = new WasmExactSegmentSource({
-  minimumWasmWork: acceptanceProbeEnabled ? 0 : undefined,
-  onPublication: (collection, generation) => {
-    if (!acceptanceProbeEnabled || collection.origin !== 'wasm') return;
-    const message: GeometryAccelerationProbe = {
-      type: 'SHAPECUT_WASM_SEGMENTS_PUBLISHED',
-      origin: 'wasm',
-      layerCount: collection.layers.length,
-      generation,
-      activeWorkerCount: exactSegmentSource.activeWorkerCount,
-    };
-    globalThis.postMessage(message);
-  },
-});
+const workerSearchParams = new URL(globalThis.location.href).searchParams;
+const acceptanceProbeEnabled = workerSearchParams.get('shapecut-acceptance') === '1';
+const wasmRolloutEnabled = workerSearchParams.get('shapecut-wasm-rollout') === '1';
+let exactSegmentSource: WasmExactSegmentSource | undefined;
+if (wasmRolloutEnabled) {
+  exactSegmentSource = new WasmExactSegmentSource({
+    minimumWasmWork: acceptanceProbeEnabled ? 0 : undefined,
+    onPublication: (collection, generation) => {
+      if (!acceptanceProbeEnabled || collection.origin !== 'wasm') return;
+      const message: GeometryAccelerationProbe = {
+        type: 'SHAPECUT_WASM_SEGMENTS_PUBLISHED',
+        origin: 'wasm',
+        layerCount: collection.layers.length,
+        generation,
+        activeWorkerCount: exactSegmentSource?.activeWorkerCount ?? 0,
+      };
+      globalThis.postMessage(message);
+    },
+  });
+}

 globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
   if (!acceptanceProbeEnabled) return;
   const message = typeof event.data === 'object' && event.data !== null
     ? event.data as Record<string, unknown>
     : undefined;
   if (message?.type === 'SHAPECUT_TEST_HOLE_PROBE_ENABLE') {
     setHoleCandidateProbeForTesting((evidence) => {
       globalThis.postMessage({ type: 'SHAPECUT_HOLE_CANDIDATES', evidence });
     });
   }
   if ((message?.type === 'SHAPECUT_WASM_STATE_REQUEST'
       || message?.type === 'SHAPECUT_WASM_CANCEL_REQUEST')
     && Number.isSafeInteger(message.requestId)) {
     const respond = (): void => {
       globalThis.postMessage({
         type: 'SHAPECUT_WASM_STATE',
         requestId: message.requestId,
-        generation: exactSegmentSource.generation,
-        activeWorkerCount: exactSegmentSource.activeWorkerCount,
+        generation: exactSegmentSource?.generation ?? 0,
+        activeWorkerCount: exactSegmentSource?.activeWorkerCount ?? 0,
+        rolloutEnabled: wasmRolloutEnabled,
+        sourceConstructed: exactSegmentSource !== undefined,
       });
     };
     if (message.type === 'SHAPECUT_WASM_CANCEL_REQUEST') {
-      void exactSegmentSource.cancel().then(respond);
+      void (exactSegmentSource?.cancel() ?? Promise.resolve()).then(respond);
     } else {
       respond();
     }
   }
   if (message?.type === 'SHAPECUT_WASM_START_REQUEST' && Number.isSafeInteger(message.requestId)) {
+    if (!exactSegmentSource) {
+      globalThis.postMessage({
+        type: 'SHAPECUT_WASM_START_OUTCOME', requestId: message.requestId, outcome: 'rejected',
+      });
+      return;
+    }
     const triangles = Object.freeze(Array.from({ length: 50_000 }, () => Object.freeze([0, 1, 2] as const)));
     const specs = Object.freeze(Array.from({ length: 24 }, (_, index) => Object.freeze({
       index,
       zStart: -0.5,
       zMid: -0.48 + index * 0.04,
       zEnd: -0.46 + index * 0.04,
     })));
     void exactSegmentSource.collect(Object.freeze({
       vertices: Object.freeze([
         Object.freeze([0, 0, -1] as const),
