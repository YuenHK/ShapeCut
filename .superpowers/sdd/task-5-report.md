# Task 5 報告：WASM segments 接入 canonical extraction

## 狀態

READY_FOR_REVIEW。最新獨立 review 的 C1、I1 及 I2 修正已完成，但本報告不會
在新一輪獨立 review 回覆前聲稱已獲批准。

Earlier final-review implementation commit 是 `819a1b9`。Review findings 1–9 已按嚴格
RED → GREEN 處理，implementation worktree 及 detached fresh clone 的完整 gate
均已完成。最新 gate fix 是包含本報告的 commit。

### C1：Task 7 前 production default-off rollout gate

- 根因：`geometry.worker.ts` 原先無條件建構 `WasmExactSegmentSource`，並將它
  注入每次 production conversion；沒有 rollout gate。
- RED：新 default-production Chromium regression 是 0/1（1 failed、36 skipped）。
  Worker state 沒有 `rolloutEnabled: false` 或 `sourceConstructed: false`，而舊路徑
  會建構及執行 WASM source。
- GREEN：新的明確 rollout flag 是 page query `shapecut-wasm-rollout=1`。
  Geometry client 只在值精確為 `1` 時把 flag 傳入 worker；worker 只在同一條件
  下建構及注入 WASM source。Flag 缺省、空白或非 `1` 時繼續使用原本
  TypeScript production path，不建構 source、不啟動 worker、不會 publication；
  generation 及 active worker count 在 conversion 前後都是 0。沒有 UI、CSS、文案
  或 interaction 改動。
- Focused Chromium GREEN：default-off 與 explicit-on 2/2；連同 actual-WASM
  cancel/replacement 為 3/3（4.101 s、8.827 s、12.107 s），每-test 15 秒 gate
  沒有放寬。完整 geometry-worker Chromium 為 37/37（86.84 s）。

### I1：exact-Float32 same-topology wrong-coordinate differential

- 新 regression 使用 exact-Float32 box projected mesh；worker result 保持相同 layer
  及 segment 數量，但改動一個座標。測試明確要求 runner 只執行一次、
  錯誤 WASM 不 publication，回傳 original TypeScript oracle。
- Mutation RED：暫時停用 coordinate comparison 後 0/1（1 failed、16 skipped），
  實際收到 `origin: wasm` 與錯誤座標，證明新測試不會被 exact-Float32
  preflight 短路。
- GREEN：還原 fail-closed coordinate comparison 後 1/1（16 skipped）；完整
  segment-source Node 為 17/17。Runner 呼叫一次、publication 零次、回傳值與
  original TypeScript oracle 完全相同。

### 最新 gate-fix verification

- Automatic pipeline：37/37（145.36 s），每-test 20 秒 gate 沒有放寬。
- Geometry-worker Chromium：37/37（86.84 s），每-test 15 秒 gate 沒有放寬。
- Typecheck：passed。Production build：passed；177 modules transformed。
- Bundle：1 個 hashed slice worker、1 個 hashed WASM、0 source maps；沒有 absolute
  local paths、private fixture token、private model path 或 model data。
- 本次沒有重跑無關的 full 75-file Node、full 9-file Chromium、E2E、private
  heavy fixtures、Rust 或 raw-WASM gates；最新改動只觸及 production rollout routing、
  worker acceptance probes 及 TypeScript differential regression。

Production canonical extraction 只在所有 projected positions 均可 exact Float32
round-trip、worker batch validation 及 publication boundary 全部通過後，才使用
canonical-sorted WASM segments。TypeScript 仍負責 topology、材料驗證、launcher
planning、canonical assembly、preview 及所有 release artifacts。沒有修改 UI、CSS、
字體、字型、大小、顏色、layout、材料規則、launcher 規則或 production error
classification。

## TDD RED → GREEN

### Findings 1–5

- Differential oracle 已改為 original production TypeScript projected mesh，不使用
  Float32 WASM projection 作 oracle；TS/Rust 的 local degeneracy、plane 及 planar
  tolerance 語義一致。任何 non-exact differential 在 publication 前回原本 TS
  collection；publication 後不得混用 TS extraction。
- Small batches 及 Float32-ineligible projected meshes 在 worker startup 前選 TS，
  回 `origin: typescript`，不是 resource error或 compatibility fallback。
- Full TypeScript oracle 只在 explicit differential mode 或 geometry-evidence 驗證執行，
  不成為無條件 production 成本。
- Expanded edge-AABB rejection 只略過 tolerance／distance 外不可能命中的 pair，保留
  原 predicate、tolerance 及最後 `Math.hypot` 距離判定。
- Actual-WASM singleton cancel mutation 曾在預期 workers 0 處收到 4 而 RED；GREEN
  證明 workers 在 1 秒內歸零、第一代 rejected、沒有 late publication、replacement
  generation 乾淨，並與 fresh TS baseline 的 canonical layers、完整 assembly 及
  feature-evidence fingerprint 相同。
- Replacement contamination mutation 刪去第一層後正確 RED；還原後 GREEN。

### Finding 6：exact Float32 production eligibility

- RED：新增 `0.1`／`1.1` ordinary-decimal projected coordinates，關閉 differential
  mode 並要求 runner 0；舊 tolerance-based preflight 錯誤回 `origin: wasm`。
- GREEN：WASM eligibility 現逐一要求每個傳入 kernel 的 projected position 滿足
  `Math.fround(value) === value`。任何 non-exact coordinate 在 worker 前選 original
  TypeScript source；focused Node 16/16，回歸 case 明確驗證 runner 未呼叫。
- Real Chromium differential fixtures 明確以 binary-STL Float32 round-trip 建立；
  closed/open/duplicate/stepped/disconnected/mixed-scale/non-Z/near-plane/Float32-edge
  等 14/14 通過，successful exact cases 明確保持 actual `origin: wasm`。Explicit
  differential mode 仍存在，不是無條件 production cost。

### Finding 7：15 秒六輸出 identity

- RED：移除 browser test 的 120 秒 override 後，原 32-segment fixture 在既有
  15 秒 gate 於 15.138 秒 timeout。
- GREEN：改用 12-segment closed launcher-compatible cylinder；仍明確驗證 actual
  WASM publication、`launcher.status: fixed`、canonical layers、assembly、feature
  fingerprint、SVG、DXF、preview PDF、exploded-view PDF、launcher coupon SVG，
  以及解包後按 canonical member name/content hash 比較的 ZIP。Focused test 1/1，
  8.86 秒，沒有 per-test override。

### Finding 8：truthful full E2E

- RED：沒有 private env 時 A/B 各自 assertion fail；100k deterministic fixture 真實
  回 `NO_OUTLINE`，舊測試只接受 `RESOURCE_LIMIT`／`TIME_LIMIT` 而 fail。
- GREEN：A/B 缺 env 時各自 truthful skip；提供外部 inputs 時仍完整執行。100k 測試
  接受與 UI 一致的 bounded terminal `NO_OUTLINE|RESOURCE_LIMIT|TIME_LIMIT`，不改寫
  production classification。Final full E2E 為 15 passed、3 skipped、0 failed；三個
  skip 是既有 conditional Knight case及缺 env 的 A/B。
- Exact eligibility 令另一 package-replacement case 的 conversion 超過隱含 5 秒
  polling default；穩定 RED 後，只把該 evidence poll 明確設為 15 秒。Production
  行為不變；isolated 1/1，final full E2E 亦通過。

### Finding 9：runtime／test timeout 說明

- `DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs` 的 production runtime 仍是 `Infinity`。
- 120 秒是設計中 1M-triangle acceptance boundary：須在該邊界內完成或回 typed
  resource failure；它不是 Task 5 改動的 production runtime deadline。
- `src/export/outline-package.test.ts` 的 evidence-based 30 秒 test-only timeout 設於
  整個 `material-independent outline package` describe block，不是單一 test。
  原 5 秒下 genuine conversion/package reconciliation 曾在 6.894 秒 timeout，且沒有
  geometry/artifact assertion mismatch；30 秒下 focused 1/1 約 8.13 秒。
- Automatic 每-test 20 秒及 Chromium 每-test 15 秒 gates 沒有放寬。

## Final-code verification

Implementation worktree（commit `819a1b9`）：

- Focused exact eligibility：16/16；real Chromium differential：14/14。
- Actual-WASM singleton cancel/replacement：1/1，約 10.73 秒。
- Production six-output identity：1/1，8.86 秒，15 秒 gate，沒有 override。
- Automatic pipeline：37/37，保留每-test 20 秒 gate。
- Geometry worker：36/36，保留每-test 15 秒 gate。
- Full serial Node：75/75 files；1,851 passed、4 skipped；274.90 秒。
- Full Chromium：9/9 files；141/141；79.45 秒。
- Full E2E：15 passed、3 skipped、0 failed。
- Public fixture validator：10/10；8 automatic successes；output comparison passed。
- Rust：1 unit + 21 integration；clippy `-D warnings` passed；raw WASM 31/31。
- Typecheck、production build、pinned WASM regeneration、`git diff --check`：passed。
- Bundle：1 個 hashed slice worker、1 個 hashed WASM、0 source maps；沒有 absolute
  local paths、private fixture tokens或 model data。

Detached fresh clone（commit `819a1b9`，含空格及中文路徑，重新 `npm ci`）：

- Full serial Node：75/75 files；1,851 passed、4 skipped；276.07 秒。
- Full Chromium：9/9 files；141/141；79.69 秒；15 秒 gate 未改。
- Full E2E：15 passed、3 skipped、0 failed。
- Public fixtures 10/10、Rust 22/22、clippy、raw WASM 31/31、typecheck、build、
  byte-identical regeneration、`git diff --check` 及 clean git status：passed。

## Private A/B final-code acceptance

- Conditional one-click six-download acceptance：2/2 passed；每個 case 均進行兩次
  完整 upload-to-six-download reconciliation 及 deterministic comparison，整個 test
  runtime 約 39.5 秒及 39.9 秒。
- Full private fixture validator：10/10；launcher template、determinism、runtime
  validation、artifact geometry及 output comparison 全部 passed。單次 conversion
  約 14.19 秒及 14.62 秒。
- 報告及 commits 沒有記錄 private fixture 路徑、檔名、model bytes或 geometry hash。

## 清理、限制與 concerns

- Task 產生的 Vitest attachments/screenshots 已從原 implementation worktree 移到
  macOS Trash，可復原；沒有清理其他 task-owned 檔案。Recovered clone 保留作安全來源。
- Controller-owned `.superpowers/sdd/progress.md` 沒有納入任何 Task 5 commit。
- 本 Task 不聲稱 A3 兩倍速度、五次 warmed median、30% peak-live-byte reduction、
  1M/120 秒 acceptance或 physical launcher acceptance 已完成。這些仍屬後續
  performance、memory及 physical acceptance 工作。

## Commits

- `9283269` — `fix: close wasm canonical extraction review findings`
- `e6fd668` — `test: bound genuine artifact reconciliation`
- `c25a13c` — `fix: preflight local wasm precision`
- `587e6f6` — `docs: record task 5 final verification`
- `819a1b9` — `fix: close final wasm review findings`
