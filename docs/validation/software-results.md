# 軟件驗收結果

日期：2026-07-19　分支：`feat/spinner-laser-kit`

## 自動測試

| 關卡 | 結果 |
|---|---:|
| Vitest unit/component | 409/409 通過（25 個 test files） |
| Chromium browser | 31/31 通過（4 個 test files） |
| Playwright E2E | 9/9 通過（single worker，避免幾何 benchmark 與另一個 repair worker 爭用 CPU） |
| 10 個代表性 STL | 8 個自動成功；1 個要求人工軸心；1 個 topology blocking；10/10 通過 |
| TypeScript | 通過 |
| Vite production build | 通過（341 modules transformed） |
| 非根路徑 PWA build | `/school/spinner/` manifest、icon、service worker URL／scope 及 cache shell 全部通過 |
| 100k triangles | 2,893 ms 到可互動軸心頁；最長 main-thread task 72 ms |
| 500k triangles | 1,397 ms 受控返回 resource-limit `操作失敗`：unique vertices 超過 300,000 上限 |
| 真實拆件／雕刻 worker | 首次 pipeline 106 ms；decomposition 11.9 ms；engraving 8.0 ms |

E2E 已實際驗證：真實封閉 STL 完成軟件流程，但預設材料因欠精確材料身份、實體 coupon 及合資格操作員簽署而阻止 production 匯出；開放 STL 停在匯入步驟；低對稱 fixture 必須輸入有限非零手動軸心；頁面重載後必須重新附加並核對原始 STL。另有 real-fixture integration 使用兩個不同 STL 及明確標示 `TEST ONLY` 的完整 synthetic signed profile，經真正 readiness／preflight gate 建立套件，再逐 entity 驗證 SVG、DXF、PDF、JSON 與 ZIP；兩個 STL 的 profile、CUT geometry 及使用尺寸均不同。這個 synthetic profile 只屬自動測試證據，不代表任何實物或 production 批准。完整 fresh matrix 指令為 `npm run test`、`npm run test:browser -- --run --browser=chromium`、`npm run test:e2e -- --workers=1`、`npm run validate:fixtures`、`npm run typecheck`、`npm run build` 及 `npm run test:performance`。

效能數字來自 2026-07-19 的本機 Chromium single-worker fresh run，只量使用者按「分析模型」至互動軸心或明確 resource-limit 結果；測試端 fixture 建立及 `setInputFiles` 傳輸在計時範圍外。數字會隨機器及當時系統負載波動，驗收門檻仍為 100k 少於 3,000 ms、最長 main-thread task 少於 100 ms，以及 500k 在 15,000 ms 內受控返回具體結果。

## Knight Fortress 真實 STL regression

外部使用者 fixture `Copy of Beyblade X Knight Fortress.stl` 未加入 repository；E2E 在 fixture 存在時實際執行，亦可用 `KNIGHT_FORTRESS_STL` 明確指定路徑，缺失時會清楚 skip，避免 CI 假失敗。

| 階段 | 開放邊界 | 非流形邊 | 退化三角形 | 重複三角形 | 結果 |
|---|---:|---:|---:|---:|---|
| 原始模型 | 0 | 105 | 63 | 33 | 可解析；沒有誤報為「讀不到檔案」 |
| 安全修復 | 41 | 49 | 0 | 0 | 未通過安全檢查；保持 blocking |
| 進階修復 | 41 | 49 | 0 | 0 | 未通過安全檢查；`非流形面扇無法在限制內安全拆分` |

真實 browser workflow 同時確認：必須明確勾選同意才可執行進階修復；`使用進階修復` 保持 disabled；「軸心與尺寸」保持鎖定。進階結果只可下載供外部檢查，不能進入自動拆件。E2E 下載 `Copy of Beyblade X Knight Fortress-repaired.stl` 後用 STL parser 重新讀取，得到 41／49／0／0；按「復原原始模型」後回復 0／105／63／33。以上結果不表示 Knight Fortress 已成功修復。

## 10 個代表性 STL

執行：`npm run validate:fixtures`

| 模型 | 類別 | 結果 | 軸向 alignment | confidence | 零件 |
|---|---|---|---:|---:|---:|
| symmetric-smooth.stl | 平滑 | 自動軸心＋可編輯拆件 | 1.000 | 1.000 | 10 |
| symmetric-textured.stl | 紋理 | 自動軸心＋可編輯拆件 | 1.000 | 0.984 | 10 |
| hollow-shell.stl | 中空殼 | 自動軸心＋可編輯拆件 | 1.000 | 0.810 | 10 |
| wide-outer-ring.stl | 寬外環 | 自動軸心＋可編輯拆件 | 1.000 | 1.000 | 10 |
| thin-profile.stl | 薄壁空殼 | 自動軸心＋可編輯拆件 | 1.000 | 0.919 | 10 |
| tall-spindle.stl | 修長 | 自動軸心＋可編輯拆件 | 1.000 | 0.994 | 10 |
| squat-disc.stl | 扁碟 | 自動軸心＋可編輯拆件 | 1.000 | 0.920 | 10 |
| stepped-profile.stl | 階梯輪廓 | 自動軸心＋可編輯拆件 | 1.000 | 0.955 | 10 |
| low-symmetry.stl | 低對稱 | 要求手動軸心 | — | 0.523 | — |
| invalid-open.stl | 無效網格 | blocking：開放邊界 | — | — | — |

自動成功率為 8/10；`low-symmetry.stl` 的 0.523 低於 UI 自動確認門檻 0.8，`invalid-open.stl` 則由真實 topology inspection 阻止。validator 亦比較至少兩個自動模型的 geometry SHA-256 及輸出尺寸，確認不是共用固定輸出。所有模型由本專案程序化產生，以 CC0-1.0 發佈；重建指令為 `node scripts/generate-acceptance-fixtures.mjs`。

## 三材料軟件狀態

| 材料 | 軟件支援 | 廠商 Laser 身份證明 | 實體 coupon | 最終製作套件 |
|---|---|---|---|---|
| 3 mm birch plywood | 已支援 | 待操作員填寫產品／批次 | 待切割 | 待 coupon 合格後輸出 |
| 3 mm cardboard | 已支援 | 待操作員填寫產品／批次 | 待切割 | 待 coupon 合格後輸出 |
| 3 mm cast acrylic | 只接受廠商確認可 Laser 加工的 cast PMMA | 待操作員附資料表 | 待切割 | 待 coupon 合格後輸出 |

軟件可產生 calibration coupon；預設材料 profile 全部保持 pending，不能產生 production 製作 ZIP。只有在合資格操作員填寫精確機器／產品／批次／安全證據、完成實體 coupon，並以姓名、資格、時間、簽署及 coupon ID 簽批後，材料才可變成 `ready`。production 匯出邊界會重新驗證完整 `MaterialProfileV1`，不能只靠 UI checkbox 或偽造 `ready` 字串繞過。

預校準 coupon 已由實際 coupon 引擎產生；重建指令為 `npm run generate:coupons`：

- `fixtures/acceptance/material-coupons/pending-plywood-3-coupon.svg`
- `fixtures/acceptance/material-coupons/pending-cardboard-3-coupon.svg`
- `fixtures/acceptance/material-coupons/pending-cast-pmma-3-coupon.svg`

以上 SVG 只供合資格操作員以正確機器、產品、批次及厚度重新確認後進行校準，並非已批准的最終陀螺製作檔。校準結果須記錄於 `docs/validation/physical-sample-form.md`，再更新對應材料 profile，方可輸出 production manufacturing package。

## 尚未完成的實物關卡

以下結果不能由自動化或模擬代替，目前狀態為 **待合資格 Laser 操作員執行**：三材料 coupon、kerf／卡榫實測、雕刻級別、組裝、軸孔同心度、低速試轉、結構破壞檢查。未有簽署結果前，Task 15 的物理部分及整體 production manufacturing approval 不得標記完成。
