# 軟件驗收結果

日期：2026-07-19　分支：`feat/spinner-laser-kit`

## 自動測試

| 關卡 | 結果 |
|---|---:|
| Vitest unit/component | 314/314 通過 |
| Chromium browser | 8/8 通過 |
| Playwright E2E | 5/5 通過 |
| TypeScript | 通過 |
| Vite production build | 通過 |
| 100k triangles | 約 1.7–2.3 秒到可互動軸心頁；分析階段沒有超過 100 ms long task |
| 500k triangles | 約 3.4–3.5 秒內受控返回 blocking 結果 |

E2E 已實際驗證：封閉 STL 完成五步並下載可解開 ZIP；開放 STL 停在匯入步驟；未校準 cork 阻止匯出；ZIP 含 SVG、DXF、PDF、JSON；PWA manifest 存在。

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
