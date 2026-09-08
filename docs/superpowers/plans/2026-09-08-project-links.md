# ShapeCut 專案連結實現計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 在 ShapeCut 頁尾加入 GitHub 專案介紹及 Beyblade Simulator 宣傳連結，同時保持桌面和手機版面不溢出。

**架構：** 在 `App` 的既有頁尾內加入語意化 `nav`，由現有 CSS 管理水平排列及窄畫面換行。以單元測試驗證連結安全屬性，以瀏覽器佈局測試驗證視窗邊界。

**技術棧：** React、TypeScript、CSS、Vitest、Testing Library、Vitest Browser

---

### 任務 1：鎖定頁尾連結合約

**文件：**
- 修改：`src/app/App.test.tsx`
- 修改：`src/app/workbench-layout.browser.test.tsx`

- [ ] **步驟 1：編寫失敗的單元測試**

渲染 `App`，查找「GitHub 專案介紹」及「延伸體驗：陀螺對戰模擬器」，並斷言兩者的 `href`、`target="_blank"`、`rel="noreferrer"`。

- [ ] **步驟 2：編寫失敗的瀏覽器佈局測試**

在 1280 × 720 及 390 × 844 視窗檢查頁尾連結位於視窗內，且文件沒有水平溢出。

- [ ] **步驟 3：執行測試確認紅燈**

運行：`npx vitest run src/app/App.test.tsx -t 'links to project information'`

預期：FAIL，因頁尾尚未提供兩個連結。

### 任務 2：實作頁尾相關連結

**文件：**
- 修改：`src/app/App.tsx`
- 修改：`src/styles.css`

- [ ] **步驟 1：加入語意化頁尾結構**

把現有提示包在 `footer-note` 段落，並加入 `aria-label="相關專案"` 的 `nav` 和兩個外部連結。

- [ ] **步驟 2：加入最小版面規則**

讓頁尾以置中 grid 排列、連結區可換行，並沿用現有顏色和字級；桌面緊湊模式保持在單一頁面內。

- [ ] **步驟 3：執行聚焦測試確認綠燈**

運行：`npx vitest run src/app/App.test.tsx -t 'links to project information'`

預期：PASS。

### 任務 3：完整驗證及部署

**文件：**
- 驗證：`src/app/App.test.tsx`
- 驗證：`src/app/workbench-layout.browser.test.tsx`

- [ ] **步驟 1：執行完整測試與建置**

運行：`npm run typecheck`、`npm test -- --run`、`npm run test:browser -- --run`、`npm run build`。

預期：所有測試通過，正式建置成功。

- [ ] **步驟 2：提交及推送**

提交本次規格、計劃、元件、樣式及測試，再推送至 GitHub `main`。

- [ ] **步驟 3：公開驗收**

等待 GitHub Pages 部署完成，檢查 `https://yuenhk.github.io/ShapeCut/` 回傳 HTTP 200，且公開 DOM 含有兩個正確連結。
