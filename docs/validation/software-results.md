# 軟件驗收結果

日期：2026-07-19　分支：`feat/spinner-laser-kit`

## 自動測試

| 關卡 | 結果 |
|---|---:|
| Vitest unit/component | 366/366 通過（22 個 test files） |
| Chromium browser | 25/25 通過（4 個 test files） |
| Playwright E2E | 6/6 通過（single worker，避免幾何 benchmark 與另一個 repair worker 爭用 CPU） |
| 10 個代表性 STL | 8 個自動成功；2 個按預期要求人工軸心／blocking；10/10 通過 |
| TypeScript | 通過 |
| Vite production build | 通過（324 modules transformed） |
| 100k triangles | 2,776 ms 到可互動軸心頁；最長 main-thread task 81 ms |
| 500k triangles | 3,411 ms 受控返回 blocking 結果 |

E2E 已實際驗證：封閉 STL 完成五步並下載可解開 ZIP；開放 STL 停在匯入步驟；未校準 cork 阻止匯出；ZIP 含 SVG、DXF、PDF、JSON；PWA manifest 存在。完整 fresh matrix 指令為 `npm test -- --run`、`npm run test:browser`、`npm run test:e2e`、`npm run validate:fixtures`、`npm run typecheck`、`npm run build` 及 `npm run test:performance`。

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
| symmetric-smooth.stl | 平滑 | 自動軸心＋可編輯拆件 | 1.000 | 0.985 | 10 |
| symmetric-textured.stl | 紋理 | 自動軸心＋可編輯拆件 | 1.000 | 0.958 | 10 |
| hollow-shell.stl | 中空殼 | 自動軸心＋可編輯拆件 | 1.000 | 0.587 | 10 |
| wide-outer-ring.stl | 寬外環 | 自動軸心＋可編輯拆件 | 1.000 | 0.968 | 10 |
| thin-profile.stl | 薄壁空殼 | 自動軸心＋可編輯拆件 | 1.000 | 0.811 | 10 |
| tall-spindle.stl | 修長 | 自動軸心＋可編輯拆件 | 1.000 | 0.988 | 10 |
| squat-disc.stl | 扁碟 | 自動軸心＋可編輯拆件 | 1.000 | 0.901 | 10 |
| stepped-profile.stl | 階梯輪廓 | 自動軸心＋可編輯拆件 | 1.000 | 0.890 | 10 |
| low-symmetry.stl | 低對稱 | 要求手動軸心 | — | 0.523 | — |
| invalid-open.stl | 無效網格 | blocking：開放邊界 | — | — | — |

自動成功率為 8/10，另外兩個模型均按 manifest 返回預期人工處理或 blocking 結果。所有模型由本專案程序化產生，以 CC0-1.0 發佈；重建指令為 `node scripts/generate-acceptance-fixtures.mjs`。

## 三材料軟件狀態

| 材料 | 軟件支援 | 廠商 Laser 身份證明 | 實體 coupon | 最終製作套件 |
|---|---|---|---|---|
| 3 mm birch plywood | 已支援 | 待操作員填寫產品／批次 | 待切割 | 待 coupon 合格後輸出 |
| 3 mm cardboard | 已支援 | 待操作員填寫產品／批次 | 待切割 | 待 coupon 合格後輸出 |
| 3 mm cast acrylic | 只接受廠商確認可 Laser 加工的 cast PMMA | 待操作員附資料表 | 待切割 | 待 coupon 合格後輸出 |

軟件可產生 calibration coupon 及製作 ZIP，但本報告不把未切割材料標記為 calibrated。需完成下列實物表後，才可把三個材料 profile 設為 `physicalCouponVerified: true`。

預校準 coupon 已由實際 coupon 引擎產生；重建指令為 `npm run generate:coupons`：

- `fixtures/acceptance/material-coupons/pending-plywood-3-coupon.svg`
- `fixtures/acceptance/material-coupons/pending-cardboard-3-coupon.svg`
- `fixtures/acceptance/material-coupons/pending-cast-pmma-3-coupon.svg`

以上 SVG 只供合資格操作員以正確機器、產品、批次及厚度重新確認後進行校準，並非已批准的最終陀螺製作檔。校準結果須記錄於 `docs/validation/physical-sample-form.md`，再更新對應材料 profile，方可輸出 production manufacturing package。

## 尚未完成的實物關卡

以下結果不能由自動化或模擬代替，目前狀態為 **待合資格 Laser 操作員執行**：三材料 coupon、kerf／卡榫實測、雕刻級別、組裝、軸孔同心度、低速試轉、結構破壞檢查。未有簽署結果前，Task 15 的物理部分及整體 production manufacturing approval 不得標記完成。
