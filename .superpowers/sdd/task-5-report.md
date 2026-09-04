# Task 5 報告：WASM segments 接入 canonical extraction

## 狀態

DONE_WITH_CONCERNS。

Task 5 的五項 review findings 已完成，並在最終 code commit
`c25a13c` 上取得 fresh full matrix 及獨立 re-review。正式 review 結果為
0 Critical、0 Important、0 Minor，可接受。

Production canonical extraction 只在 Float32 preflight、worker batch validation
及 publication boundary 全部通過後使用 canonical-sorted WASM segments；
TypeScript 仍負責 topology、材料驗證、launcher planning、canonical assembly、
preview 及所有 release artifacts。任何 differential 非 exact 結果均在
publication 前改用 original projected TypeScript mesh；publication 後不得混用
TypeScript extraction。

沒有修改 UI、CSS、字體、字型、大小、顏色、layout、材料規則、launcher 規則，
亦沒有修改 production 120 秒、automatic 20 秒或 browser 15 秒限制。

## TDD RED → GREEN 證據

### Finding 5：actual-WASM singleton cancel／replacement

- RED mutation：暫時令 acceptance cancel 訊息只回報狀態而不呼叫
  `exactSegmentSource.cancel()`；同一 real Chromium test 收到
  `activeWorkerCount: 4`，在預期 `0` 處失敗。
- GREEN：還原實作後，focused test 1/1 通過；取消後 workers 在 1 秒內歸零，
  第一代工作被拒絕，沒有 late publication，replacement generation 遞增，
  唯一 publication 來自新 generation 且 `activeWorkerCount: 0`。
- replacement 與獨立 fresh TypeScript baseline 精確比較 canonical layers、
  完整 assembly 及 feature-evidence fingerprint。
- contamination mutation 將 replacement layers 刪去第一層後，同一 test 正確
  RED；還原後在 15 秒 test gate 內 GREEN，focused runtime 約 10.00 秒。

### Finding 2：mixed-scale Float32 preselection

- 首個反例使用非 Float32-exact 的遠端十進制座標，舊 preflight 已保守回 TS，
  因而不是有效 RED；該 fixture 沒有被當成缺陷證據。
- 有效 RED 改用 Float32-exact 的遠端 `2^40`／`2^30` 三角形放大全局直徑，
  並保留局部 `100000000.25` 座標。舊全局 tolerance 錯誤回
  `origin: wasm`，而要求是 TypeScript、runner 0。
- GREEN：preflight 現逐 triangle 以最小 positive local edge scale 評估
  coordinate round-off，並核對原始／Float32 degeneracy 及每個切片 plane 的
  classification。Node 明確驗證 `origin: typescript` 且 runner 未啟動；real
  Chromium 驗證 `origin: typescript`、active workers 0。

### Full Node genuine-package timeout

- RED：full serial Node 唯一失敗是 genuine converted six-artifact reconciliation
  在預設 5 秒 timeout；該次工作耗時 6.894 秒，沒有 geometry 或 artifact
  assertion mismatch。
- GREEN：只為這個同時進行真實 conversion、六輸出 packaging 及 parsing 的
  evidence-heavy test 設 30 秒 test-only timeout。先前隔離最慢約 18.1 秒；
  focused 1/1 約 8.13 秒，final full Node 75/75 files 通過。
- automatic 20 秒、browser 15 秒及 production 120 秒沒有改動。

## 實作及 correctness boundary

- Differential oracle 使用 original production TypeScript projected mesh，不使用
  Float32 WASM projection 作 oracle。
- TS/Rust 共用相同的 local degeneracy、plane 及 planar tolerance 語義；
  non-Z axis、near-plane、Float32 edge、mixed-scale、coplanar、open、duplicate、
  stepped、disconnected 及 non-manifold evidence 均有 Node／real Chromium coverage。
- Small batches 及 Float32-unsafe inputs 在 worker startup 前選擇 TypeScript，回傳
  `origin: typescript`；不是 resource error，也不是 compatibility fallback。
- 非 production 不再無條件執行 full TypeScript oracle；differential mode 必須
  明確開啟。
- Worker/pool generation 及 hard cancel 阻止舊結果 publication；新的 replacement
  使用乾淨 generation。
- Expanded edge-AABB rejection 只略過在 tolerance／distance 外不可能命中的 pair，
  保留原 predicate、tolerance 及最終 `Math.hypot` 距離計算。
- 六個輸出逐一比較：SVG、DXF、preview PDF、exploded-view PDF、launcher coupon
  SVG；ZIP 先解包，再按 canonical member name 及 member content hash 比較，
  不以 nondeterministic ZIP metadata 判定差異。

## Final code commit 的 fresh 驗證

Implementation worktree：

- Focused actual-WASM cancel/replacement：1/1。
- Automatic pipeline：37/37，保留每 test 20 秒 gate。
- Geometry worker：36/36，使用 15 秒 browser gate。
- Real Chromium segment differential/preflight：14/14。
- Full serial Node：75/75 files；1,850 passed、4 skipped；282.29 秒。
- Full Chromium：9/9 files；141/141；83.67 秒。
- Public fixtures：10/10；8 automatic successes；output comparison passed。
- Rust：1 unit + 21 integration tests；clippy `-D warnings` passed。
- Raw WASM boundary：31/31。
- Typecheck、production build、pinned WASM regeneration、`git diff --check`：passed。
- Bundle inspection：1 個 hashed slice worker、1 個 hashed WASM、0 source maps；
  worker references 正確，沒有 absolute local path、private fixture token 或 model data。

Detached fresh clone（commit `c25a13c`，路徑包含空格及中文，重新 `npm ci`）：

- Full serial Node：75/75 files；1,850 passed、4 skipped；275.75 秒。
- Full Chromium：9/9 files；141/141；80.70 秒。
- Raw WASM 31/31、Rust 22/22、clippy、typecheck、production build、pinned
  regeneration、public fixtures 10/10、`git diff --check` 及 clean git status：passed。

## E2E 及 private A/B

- 無 private environment inputs 的 full E2E：12 passed、1 skipped、2 did not run、
  3 failed。兩個 failure 只因 A/B env 未提供；其後已用外部 fixtures 個別補跑。
- 其餘 failure 是 100k synthetic case 真實回 `NO_OUTLINE`，但測試只接受
  `RESOURCE_LIMIT`／`TIME_LIMIT`。沒有改寫 genuine empty-topology classification
  來令測試假通過。
- Final code commit 後 private A/B one-click six-download acceptance：2/2 passed；
  每個 case 均包括兩次完整 upload-to-six-download reconciliation 及 deterministic
  comparison。整個 test runtime 分別約 39.6 秒及 42.8 秒。
- Full private fixture validator：10/10；launcher template、determinism、runtime
  validation、artifact geometry 及 output comparison 全部 passed。單次 conversion
  約 14.1 秒及 14.5 秒。
- 報告及 commit 沒有記錄 private fixture 路徑、檔名或 geometry hash。

## Review、清理及 concerns

- 最終獨立 re-review 實際審查 `d8c6696..c25a13c`，結論可接受：
  0 Critical、0 Important、0 Minor。這取代舊報告中未有證據的批准聲稱。
- Task 產生的 Vitest attachments/screenshots 及 disposable fresh clone 已移到
  macOS Trash，可復原；沒有清理其他檔案。
- Controller-owned `.superpowers/sdd/progress.md` 保持 unstaged，沒有納入任何
  Task 5 commit。
- 本 Task 不聲稱 A3 兩倍速度、五次 warmed median、30% peak-live-byte reduction、
  1M/120 秒或 physical launcher acceptance 已完成。這些仍屬後續 performance／
  memory／physical acceptance 工作。

## Commits

- `9283269` — `fix: close wasm canonical extraction review findings`
- `e6fd668` — `test: bound genuine artifact reconciliation`
- `c25a13c` — `fix: preflight local wasm precision`
