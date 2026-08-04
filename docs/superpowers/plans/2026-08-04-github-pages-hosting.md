# ShapeCut GitHub Pages 託管實作計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用復選框（`- [ ]`）語法來跟蹤進度。

**目標：** 把 ShapeCut 連同兩個已授權 STL 範例發佈到 `YuenHK/ShapeCut`，由 GitHub Actions 自動部署至 `https://yuenhk.github.io/ShapeCut/`。

**架構：** Vite 只在 Pages build 使用 `/ShapeCut/` base，本機開發保持 `/`。範例模型放在 `public/samples/`，由一個小型資料模組產生 base-aware 下載 URL；GitHub 官方 Pages Actions 只在 typecheck 與 build 通過後部署 `dist/`。

**技術棧：** TypeScript、React 19、Vite 7、Vitest、Vitest Browser Mode、GitHub Actions、GitHub Pages。

---

## 檔案結構

- 新增 `src/app/sample-models.ts`：範例名稱、檔名及 base-aware URL 的唯一來源。
- 新增 `src/app/sample-models.test.ts`：URL 正規化和固定樣本清單測試。
- 修改 `src/app/OneClickConverter.tsx`：只在 upload 畫面呈現可存取的範例下載區。
- 修改 `src/app/OneClickConverter.test.tsx`：驗證兩個下載連結、提示文字和私隱文案。
- 修改 `src/app/App.browser.test.tsx`：在真實瀏覽器驗證 Pages base 的連結。
- 修改 `src/styles.css`：範例下載區的響應式與 focus 樣式。
- 修改 `vite.config.ts`：以 `SHAPECUT_BASE_PATH` 控制 production base。
- 新增 `public/samples/sample1.stl`：Group 範例，來源 SHA-256 `17269a09c5a56b3c2e62683836781126421e30bfb9dce5599ff8f53667808b4d`。
- 新增 `public/samples/sample2.stl`：非 Group 範例，來源 SHA-256 `96d0ddd32cc660af31bedf4fb52552d54505169efb7887862bd9943c4f73d5b6`。
- 新增 `.github/workflows/deploy-pages.yml`：官方 Pages build/deploy workflow。
- 修改 `README.md`：公開網址、樣本、私隱與部署說明。

### 任務 1：建立可測試的 Pages base 與範例 URL

**檔案：**
- 新增：`src/app/sample-models.ts`
- 新增：`src/app/sample-models.test.ts`
- 修改：`vite.config.ts`

- [ ] **步驟 1：為固定樣本清單與 base-aware URL 編寫失敗測試**

```ts
import { describe, expect, it } from 'vitest';
import { sampleModels, sampleModelUrl } from './sample-models';

describe('sample model catalogue', () => {
  it('keeps the two approved public sample names and files fixed', () => {
    expect(sampleModels).toEqual([
      { id: 'sample1', label: '下載 sample1', fileName: 'sample1.stl' },
      { id: 'sample2', label: '下載 sample2', fileName: 'sample2.stl' },
    ]);
  });

  it.each([
    ['/', 'sample1.stl', '/samples/sample1.stl'],
    ['/ShapeCut/', 'sample2.stl', '/ShapeCut/samples/sample2.stl'],
  ])('joins base %s without losing the project path', (base, fileName, expected) => {
    expect(sampleModelUrl(fileName, base)).toBe(expected);
  });
});
```

- [ ] **步驟 2：執行測試並確認紅燈**

執行：

```bash
npm test -- src/app/sample-models.test.ts --maxWorkers=1 --fileParallelism=false
```

預期：FAIL，`./sample-models` 尚不存在。

- [ ] **步驟 3：加入最小資料模組**

```ts
export const sampleModels = [
  { id: 'sample1', label: '下載 sample1', fileName: 'sample1.stl' },
  { id: 'sample2', label: '下載 sample2', fileName: 'sample2.stl' },
] as const;

export function sampleModelUrl(fileName: string, base = import.meta.env.BASE_URL): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}samples/${fileName}`;
}
```

- [ ] **步驟 4：令 Vite Pages base 可明確重現**

把 `vite.config.ts` 的 config 加入：

```ts
const base = process.env.SHAPECUT_BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  // 保留現有 build 設定
});
```

本機預設仍是 `/`；workflow 會明確傳入 `/ShapeCut/`。

- [ ] **步驟 5：執行聚焦測試與 build base 檢查**

```bash
npm test -- src/app/sample-models.test.ts --maxWorkers=1 --fileParallelism=false
SHAPECUT_BASE_PATH=/ShapeCut/ npm run build
rg -n '/ShapeCut/assets/' dist/index.html
```

預期：測試通過；build 退出碼 0；`dist/index.html` 的 CSS／JS URL 包含 `/ShapeCut/assets/`。

- [ ] **步驟 6：提交任務 1**

```bash
git add -- src/app/sample-models.ts src/app/sample-models.test.ts vite.config.ts
git commit -m "feat: add Pages-aware sample URLs"
```

### 任務 2：改名、核對並公開兩個 STL 範例

**檔案：**
- 新增：`public/samples/sample1.stl`
- 新增：`public/samples/sample2.stl`

- [ ] **步驟 1：記錄來源檔案身份**

```bash
shasum -a 256 \
  "Copy of Beyblade X Knight Fortress Group.stl" \
  "Copy of Beyblade X Knight Fortress.stl"
```

預期：依次得到：

```text
17269a09c5a56b3c2e62683836781126421e30bfb9dce5599ff8f53667808b4d
96d0ddd32cc660af31bedf4fb52552d54505169efb7887862bd9943c4f73d5b6
```

- [ ] **步驟 2：建立目錄並按已批准對應改名**

```bash
mkdir -p public/samples
mv -- "Copy of Beyblade X Knight Fortress Group.stl" public/samples/sample1.stl
mv -- "Copy of Beyblade X Knight Fortress.stl" public/samples/sample2.stl
```

- [ ] **步驟 3：驗證名稱、大小與 byte identity**

```bash
shasum -a 256 public/samples/sample1.stl public/samples/sample2.stl
stat -f '%N %z bytes' public/samples/sample1.stl public/samples/sample2.stl
```

預期：SHA-256 與步驟 1 完全相同；大小分別為 `2005084` 和 `1855884` bytes。

- [ ] **步驟 4：確認只 staged 兩個已批准 STL**

```bash
git add -- public/samples/sample1.stl public/samples/sample2.stl
git diff --cached --name-status
git status --short
```

預期：staged 只有兩個 `public/samples/*.stl`；`shapecut-outline.zip` 和 `shapecut-outline/` 仍未追蹤。

- [ ] **步驟 5：提交任務 2**

```bash
git commit -m "feat: add public STL samples"
```

### 任務 3：在首頁加入範例下載區

**檔案：**
- 修改：`src/app/OneClickConverter.tsx:773-790`
- 修改：`src/app/OneClickConverter.test.tsx`
- 修改：`src/app/App.browser.test.tsx`
- 修改：`src/styles.css:422-520`

- [ ] **步驟 1：編寫 React 失敗測試**

在 upload 畫面測試加入：

```tsx
expect(screen.getByRole('region', { name: '範例模型' })).toBeVisible();
expect(screen.getByRole('link', { name: '下載 sample1' }))
  .toHaveAttribute('href', '/samples/sample1.stl');
expect(screen.getByRole('link', { name: '下載 sample2' }))
  .toHaveAttribute('href', '/samples/sample2.stl');
expect(screen.getByText(/實際切割前仍須檢查尺寸、材料、刀縫與結構安全/)).toBeVisible();
```

- [ ] **步驟 2：編寫瀏覽器 base path 失敗測試**

在 `App.browser.test.tsx` 使用 `sampleModelUrl('sample1.stl', '/ShapeCut/')`，斷言結果為 `/ShapeCut/samples/sample1.stl`，並驗證兩個連結可由鍵盤 focus。

- [ ] **步驟 3：執行兩個測試並確認紅燈**

```bash
npm test -- src/app/OneClickConverter.test.tsx --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run src/app/App.browser.test.tsx
```

預期：範例 region／links 尚不存在而失敗。

- [ ] **步驟 4：加入下載區**

在 upload card 的 `ModelInput` 後加入：

```tsx
<section className="sample-models" aria-label="範例模型">
  <h2>範例模型</h2>
  <div className="sample-model-links">
    {sampleModels.map((sample) => (
      <a key={sample.id} href={sampleModelUrl(sample.fileName)} download={sample.fileName}>
        {sample.label}
      </a>
    ))}
  </div>
  <p>範例只供測試 ShapeCut 工作流程；實際切割前仍須檢查尺寸、材料、刀縫與結構安全。</p>
</section>
```

保留 upload zone 內「檔案只在你的瀏覽器內處理，不會上載到伺服器」原文。

- [ ] **步驟 5：加入最小響應式樣式**

```css
.sample-models { display: grid; gap: .75rem; text-align: center; }
.sample-models h2 { margin: 0; font-size: 1.1rem; }
.sample-model-links { display: flex; flex-wrap: wrap; justify-content: center; gap: .75rem; }
.sample-model-links a { min-height: 48px; padding: .75rem 1rem; border-radius: var(--control-radius); }
.sample-models p { margin: 0; color: var(--muted); line-height: 1.6; }
```

既有全域 `a:focus-visible` 規則繼續提供 3px focus outline。

- [ ] **步驟 6：執行聚焦測試並提交**

```bash
npm test -- src/app/sample-models.test.ts src/app/OneClickConverter.test.tsx --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run src/app/App.browser.test.tsx
git add -- src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx src/app/App.browser.test.tsx src/styles.css
git commit -m "feat: expose downloadable STL samples"
```

### 任務 4：加入 GitHub Pages workflow 與公開說明

**檔案：**
- 新增：`.github/workflows/deploy-pages.yml`
- 修改：`README.md`

- [ ] **步驟 1：建立最小權限 Pages workflow**

```yaml
name: Deploy ShapeCut to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - uses: actions/configure-pages@v5
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
        env:
          SHAPECUT_BASE_PATH: /ShapeCut/
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **步驟 2：更新 README**

加入：

```markdown
## 公開網站與範例

ShapeCut 網站：<https://yuenhk.github.io/ShapeCut/>

首頁提供 `sample1.stl` 和 `sample2.stl` 下載。範例只供測試工作流程；實際切割前仍須自行檢查尺寸、材料、刀縫與結構安全。使用者選取的 STL 只在瀏覽器本機處理，不會上載到 GitHub Pages。

## GitHub Pages 部署

推送至 `main` 後，GitHub Actions 會先執行 typecheck 和 production build，成功後才部署 `dist/`。本機重現 Pages build：

```bash
SHAPECUT_BASE_PATH=/ShapeCut/ npm run build
```
```

- [ ] **步驟 3：檢查 workflow 與 production artifact**

```bash
SHAPECUT_BASE_PATH=/ShapeCut/ npm run build
test -f dist/samples/sample1.stl
test -f dist/samples/sample2.stl
shasum -a 256 dist/samples/sample1.stl dist/samples/sample2.stl
rg -n '/ShapeCut/assets/' dist/index.html
git diff --check
```

預期：兩個 dist STL 的 SHA-256 與任務 2 相同；HTML 使用 `/ShapeCut/assets/`；diff-check 無輸出。

- [ ] **步驟 4：提交 workflow 與 README**

```bash
git add -- .github/workflows/deploy-pages.yml README.md
git commit -m "ci: deploy ShapeCut to GitHub Pages"
```

### 任務 5：完整本機驗證

**檔案：**
- 修改：`docs/superpowers/plans/2026-08-04-github-pages-hosting.md`

- [ ] **步驟 1：執行完整門檻**

```bash
npm run typecheck
npm test -- --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run
SHAPECUT_BASE_PATH=/ShapeCut/ npm run build
git diff --check
git status --short
```

預期：所有命令退出碼 0；status 只保留 `shapecut-outline.zip`、`shapecut-outline/` 及待提交的計劃驗證記錄。

- [ ] **步驟 2：核對樣本與 staged scope**

```bash
shasum -a 256 public/samples/*.stl dist/samples/*.stl
git ls-files | rg '(^|/)(shapecut-outline|Copy of Beyblade)'
```

預期：每個 sample 的 public/dist SHA 相同；第二個命令無輸出。

- [ ] **步驟 3：記錄實際測試數與退出碼並提交計劃**

把實際 Node／Chromium 測試數、build 結果和 SHA 寫入本計劃末段，然後：

```bash
git add -- docs/superpowers/plans/2026-08-04-github-pages-hosting.md
git commit -m "docs: record GitHub Pages verification"
```

### 任務 6：建立公開 repository、推送及啟用 Pages

**遠端目標：** `YuenHK/ShapeCut`

- [ ] **步驟 1：取得外部寫入批准**

在執行前明確列出將進行的外部動作並取得使用者批准：建立 public repository、加入 remote、推送 `main`、執行 Pages workflow。未獲批准不得進行。

- [ ] **步驟 2：以 GitHub 已登入網頁建立空 repository**

建立 `YuenHK/ShapeCut`，可見性選 Public；不要由 GitHub 初始化 README、`.gitignore` 或 license，避免與本機歷史衝突。建立後核對 canonical URL：

```text
https://github.com/YuenHK/ShapeCut
```

- [ ] **步驟 3：加入並核對 remote**

```bash
git remote add origin https://github.com/YuenHK/ShapeCut.git
git remote -v
```

預期：fetch/push 都精確指向 `YuenHK/ShapeCut.git`。

- [ ] **步驟 4：取得推送批准並推送**

推送是獨立外部寫入；再次確認 staged/unstaged scope 後才執行：

```bash
git status --short
git push -u origin main
```

預期：只有已提交歷史上傳；本機未追蹤 `shapecut-outline` 輸出不會進入 GitHub。

- [ ] **步驟 5：在 repository Pages 設定選擇 GitHub Actions**

在 Settings → Pages，把 Source 設為 GitHub Actions。回到 Actions，確認 `Deploy ShapeCut to GitHub Pages` workflow 已由 `main` push 觸發；若尚未觸發，只在使用者批准後使用 `workflow_dispatch`。

### 任務 7：公開部署驗收

**網址：** `https://yuenhk.github.io/ShapeCut/`

- [ ] **步驟 1：等待 workflow 得出終態**

確認 build 和 deploy jobs 均為 success；若失敗，讀取第一個失敗 step 日誌，先修正根因再重新部署，不盲目重試。

- [ ] **步驟 2：驗證公開資源**

```bash
curl -fsSIL https://yuenhk.github.io/ShapeCut/
curl -fsSL https://yuenhk.github.io/ShapeCut/samples/sample1.stl | shasum -a 256
curl -fsSL https://yuenhk.github.io/ShapeCut/samples/sample2.stl | shasum -a 256
```

預期：首頁 HTTP 成功；兩個遠端 SHA-256 分別為：

```text
17269a09c5a56b3c2e62683836781126421e30bfb9dce5599ff8f53667808b4d
96d0ddd32cc660af31bedf4fb52552d54505169efb7887862bd9943c4f73d5b6
```

- [ ] **步驟 3：在 Chrome 驗證公開 UI**

開啟公開網址，確認：首頁渲染、兩個下載連結為 `/ShapeCut/samples/...`、無 assets／worker 404、console 無 base path 或跨來源錯誤。下載一個範例後用現有選檔流程開啟，至少到達材料選擇與處理畫面。

- [ ] **步驟 4：交付最終證據**

報告 repository URL、Pages URL、workflow 成功狀態、commit SHA、完整本機測試數、兩個遠端 STL SHA-256，以及未上傳的 `shapecut-outline` 檔案狀態。
