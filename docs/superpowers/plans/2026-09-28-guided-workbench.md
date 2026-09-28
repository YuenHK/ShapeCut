# 引導式工作台實作計劃

> 使用 subagent-driven-development 進行整合實作，再按規格、品質兩階段審查。使用者已批准設計及自動測試部署，不重複要求確認。

**目標：** 固定預覽與底部操作，分組設定並保持製作／恢復版面一致。

**架構：** 只改 React 展示結構與 CSS；保留 OneClickConverter 狀態機及所有領域服務。可拆出 GuidedWorkbench 或製作進度元件，避免複製運算程式。

**技術棧：** React、TypeScript、CSS、Vitest、Playwright。

## 任務 1：完整展示整合（單一實作者，避免同檔衝突）

檔案：src/app/OneClickConverter.tsx、AppleWorkbench.tsx、ProcessingLoadingPanel.tsx、EngravingFields.tsx、src/styles.css 及相應測試；按需要新增小型展示元件。

- [x] 先新增失敗測試，斷言 `.guided-action-bar` 與 `.guided-settings` 不互相巢狀、底部按鈕界限在視窗內、材料先於刻字、進階欄可展開。
- [x] 執行 `npm run test:browser -- --run src/app/workbench-layout.browser.test.tsx`，確認因缺少新結構而失敗。
- [x] 使用 `<details><summary>進階配合設定</summary>…</details>` 保留現有微調 input；材料、刻字與恢復提示為內容區；原事件處理原封移往 `<div className="guided-action-bar">…</div>`。
- [x] 保留預覽資料，在 mismatch 分支以最新 result.preview 作展示而不放行輸出。製作狀態使用同位置預覽與精簡進度，取消按鈕移至操作列，不重複按鈕。
- [x] 加四階段非互動路標，恢復提示與底部重新連結動作；新增純文字刻字範例。
- [x] 以針對性 CSS 限定在新工作台 class，桌面 `grid-template-rows: auto minmax(0,1fr) auto`，可捲動區 `min-height:0;overflow:auto`；手機使用正常單欄與 sticky 操作列。
- [x] 跑相關單元／瀏覽器測試及 build，修正測試中舊版排版假設，保留行為斷言。截圖實際驗證。

## 任務 2：審查與發布

- [x] 規格審查：逐項對照上面的設計文件，不放寬安全檢查。
- [x] 品質審查：檢查狀態競態、取消、重新連結、鍵盤與短視窗；修正後重審。
- [x] `npm test`、`npm run test:browser -- --run --fileParallelism=false`、`npm run build` 及 `git diff --check`。
- [x] 本機真實 sample1 帶刻字轉換與恢復測試。
- 發布程序：提交推送 github main，等 Pages 部署成功；公開站重測設定、轉換、刻字、下載與舊專案不一致恢復。部署結果與版本在交付訊息中記錄，不以本機測試代替公開驗收。

## 實作驗證記錄

- 已用真實 sample1 在本機正式建置完成刻字轉換，確認 ZIP 的 SVG／DXF 包含 `ENGRAVE_TEXT`。
- 已在隔離瀏覽器中模擬舊專案外框決策不一致：輸出被攔截、預覽仍保留、底部重新連結可達；驗證同一 STL 後可再產生正式輸出。
- 實際頁面已檢視 1280×720、1440×900、390×844；未重現測試框架全頁截圖的空白上段。
- 回歸測試包含新舊畫面間預覽位置一致、不可用按鈕外觀、手機鍵盤焦點、無預覽時真實階段與播報。
- 最終單元／整合測試：91 個檔案，1,960 通過、4 原有跳過；Chromium：10 個檔案、149 通過；正式建置及差異格式檢查通過。
