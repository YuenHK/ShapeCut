# ShapeCut 平衡留白 UI 實現計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 落實已批准的 B 方案，重整主頁左欄文案層級並擴闊運算狀態區的垂直留白。

**架構：** 保留既有 React 元件和流程狀態，只為主頁文案加入明確的斷行標記，並透過現有響應式 CSS 調整桌面與手機配置。以真實 Chromium 幾何量度鎖定三行標題、圓環內容邊界及控制項間距。

**技術棧：** React、TypeScript、CSS、Vitest Browser、Playwright、Vite。

---

### 任務 1：鎖定主頁文案與三行桌面排版

**文件：**
- 修改：`src/app/OneClickConverter.tsx`
- 修改：`src/styles.css`
- 測試：`src/app/App.test.tsx`
- 測試：`src/app/workbench-layout.browser.test.tsx`

- [ ] **步驟 1：加入失敗測試**

測試主頁顯示「3D → LASER CUT」、完整新副標題及三個標題行；在 1280 × 720 量度三行由上而下排列、左欄不溢出，並在 390 × 844 確認沒有水平捲動。

- [ ] **步驟 2：確認測試先失敗**

運行：`npx vitest run src/app/App.test.tsx && npx vitest --config vitest.browser.config.ts run src/app/workbench-layout.browser.test.tsx`

預期：新文案或 `.hero-title-line` 查詢失敗。

- [ ] **步驟 3：實作最小標記與樣式**

在標題內加入三個 `.hero-title-line`：`把陀螺模型`、`變成可製作的`、`三層切片`；副標題改為批准文案。桌面版把每行設為 block，調整左欄最大寬度、段落間距與行高；手機版讓行元素恢復 inline，保留自然換行。

- [ ] **步驟 4：確認目標測試通過**

運行上述單元及瀏覽器測試，預期全部 PASS。

### 任務 2：擴闊運算狀態的空間關係

**文件：**
- 修改：`src/styles.css`
- 測試：`src/app/App.browser.test.tsx`

- [ ] **步驟 1：加入失敗的幾何測試**

在 1024 × 768 量度圓環直徑不少於 300 px；圓環與進度條至少相隔 16 px，進度條與「更換模型」按鈕至少相隔 24 px；圓內標題、檔名、時間及取消按鈕仍保留 12 px 安全邊界。

- [ ] **步驟 2：確認現況未達新間距**

運行：`npx vitest --config vitest.browser.config.ts run src/app/App.browser.test.tsx`

預期：圓環尺寸或垂直間距斷言 FAIL。

- [ ] **步驟 3：實作響應式留白**

稍微放大桌面圓環，調整狀態面板 grid gap、進度條外距及右欄列間距；以 `min()` 限制寬度，確保手機版不越界。長檔名維持現有可換行／截短機制。

- [ ] **步驟 4：確認桌面與手機測試通過**

運行目標瀏覽器測試，預期全部 PASS，並輸出主頁及運算畫面 PNG 作目視檢查。

### 任務 3：完整驗證與部署

**文件：**
- 驗證：全部改動及 GitHub Actions

- [ ] **步驟 1：完整驗證**

運行：`npm test -- --run`、`npm run test:browser -- --run`、`npm run build`、`git diff --check`。

預期：所有命令退出碼為 0。

- [ ] **步驟 2：提交並推送**

提交訊息：`feat: rebalance ShapeCut interface spacing`；先抓取 `github/main` 並確認可快轉，再推送 `HEAD:main`。

- [ ] **步驟 3：公開驗收**

等候 GitHub Pages 及 release gates 成功；重新下載正式網站資源並以 1280 × 720 截圖，確認新文案及新版 CSS 已發布。
