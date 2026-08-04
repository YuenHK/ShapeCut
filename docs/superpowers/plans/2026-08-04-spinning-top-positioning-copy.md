# ShapeCut 3D 陀螺定位文案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓工具首頁、網頁 metadata、Web App Manifest、README 與 GitHub repository 簡介一致說明 ShapeCut 是把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。

**Architecture:** 不新增文案抽象層或依賴；在各自擁有該公開介面的既有檔案中更新短文案，並由 React 測試、靜態文字檢查、production build 與公開部署驗收共同防止定位再次含糊。GitHub repository description 是唯一的外部 metadata 寫入，須在本機變更通過後才更新。

**Tech Stack:** React 19、TypeScript、Vitest、Vitest Browser Mode、Vite 7、GitHub Actions、GitHub Pages。

## Global Constraints

- 核心輸入名稱固定為「3D 陀螺 STL 模型」，不使用 Beyblade 或戰鬥陀螺作產品定位。
- 核心輸出名稱固定為「Laser Cut 平面切片」；GitHub 簡介可加上「及製作檔案」。
- 保留現有本機處理、材料、刀縫及結構安全提示。
- 不修改轉換流程、幾何演算法、支援格式、三爪結構或安全規則。
- `shapecut-outline.zip` 與 `shapecut-outline/` 不得追蹤、提交或上傳。

---

### Task 1: Lock and Update the Homepage Positioning

**Files:**
- Modify: `src/app/OneClickConverter.test.tsx`
- Modify: `src/app/OneClickConverter.tsx`

**Interfaces:**
- Consumes: `OneClickConverter` 的既有 upload view 及 `converter-title` accessible heading。
- Produces: 首頁唯一 `h1` 與說明段落，不新增 component prop 或 exported symbol。

- [ ] **Step 1: Write the failing copy assertions**

在 `offers downloadable sample models without selecting or processing them` 測試內、`render(<OneClickConverter ... />)` 後加入：

```tsx
expect(screen.getByRole('heading', {
  level: 1,
  name: '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片',
})).toBeVisible();
expect(screen.getByText(
  '放入 3D 陀螺 STL 模型，ShapeCut 會自動分析、簡化和分層切片，並準備可供 Laser Cut 使用的平面外形與製作檔案。',
)).toBeVisible();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/app/OneClickConverter.test.tsx -t "offers downloadable sample models" --maxWorkers=1 --fileParallelism=false
```

Expected: FAIL because the old generic heading and paragraph do not match either new assertion.

- [ ] **Step 3: Implement the exact homepage copy**

Replace only the upload hero heading and paragraph in `src/app/OneClickConverter.tsx`:

```tsx
<h1 id="converter-title">把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片</h1>
<p>放入 3D 陀螺 STL 模型，ShapeCut 會自動分析、簡化和分層切片，並準備可供 Laser Cut 使用的平面外形與製作檔案。</p>
```

- [ ] **Step 4: Run focused Node and browser tests**

Run:

```bash
npx vitest run src/app/OneClickConverter.test.tsx -t "offers downloadable sample models" --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run src/app/App.browser.test.tsx
```

Expected: focused Node test PASS; App Chromium test file PASS with the upload view still accessible.

- [ ] **Step 5: Commit the homepage change**

```bash
git add -- src/app/OneClickConverter.test.tsx src/app/OneClickConverter.tsx
git commit -m "copy: clarify spinning-top conversion purpose"
```

### Task 2: Align README and Web Metadata

**Files:**
- Modify: `README.md`
- Modify: `index.html`
- Modify: `public/manifest.webmanifest`

**Interfaces:**
- Consumes: Vite `%BASE_URL%` replacement and static public manifest copying.
- Produces: public title, meta description, manifest description and repository README introduction.

- [ ] **Step 1: Record the expected strings and verify they are initially absent**

Run:

```bash
rg -F 'ShapeCut｜3D 陀螺模型轉 Laser Cut 切片' index.html
rg -F '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。' README.md public/manifest.webmanifest
```

Expected: both commands exit 1 before implementation because the approved exact strings are absent.

- [ ] **Step 2: Update README introduction**

Replace the first paragraph after `# ShapeCut` with:

```markdown
ShapeCut 是一個把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。檔案只在本機處理，不會上載到伺服器。
```

- [ ] **Step 3: Update HTML title and description**

Keep all existing tags and add／replace these values inside `<head>`:

```html
<meta name="description" content="把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。" />
<title>ShapeCut｜3D 陀螺模型轉 Laser Cut 切片</title>
```

- [ ] **Step 4: Update manifest description**

Set the existing `description` property to:

```json
"description": "把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。"
```

- [ ] **Step 5: Build and inspect production artifacts**

Run:

```bash
SHAPECUT_BASE_PATH=/ShapeCut/ npm run build
rg -F '<title>ShapeCut｜3D 陀螺模型轉 Laser Cut 切片</title>' dist/index.html
rg -F 'name="description" content="把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。"' dist/index.html
node -e 'const m=require("./dist/manifest.webmanifest"); if(m.description!=="把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。"){process.exit(1)}'
rg -F '/ShapeCut/assets/' dist/index.html
```

Expected: build exits 0; every inspection command exits 0; manifest value is exact; production assets keep `/ShapeCut/` base.

- [ ] **Step 6: Commit metadata and README**

```bash
git add -- README.md index.html public/manifest.webmanifest
git commit -m "docs: align ShapeCut spinning-top positioning"
```

### Task 3: Verify, Publish, and Align GitHub Description

**Files:**
- Modify: `docs/superpowers/plans/2026-08-04-spinning-top-positioning-copy.md`
- External: `https://github.com/YuenHK/ShapeCut/settings`

**Interfaces:**
- Consumes: approved GitHub account access, existing `origin`, Pages workflow and exact repository description from the design.
- Produces: synchronized `main`, successful Pages run, updated public site and GitHub description.

- [ ] **Step 1: Run the complete local gate**

```bash
npm run typecheck
npm test -- --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run
SHAPECUT_BASE_PATH=/ShapeCut/ npm run build
git diff --check
git status --short
git ls-files | rg '(^|/)(shapecut-outline|Copy of Beyblade)'
```

Expected: typecheck, Node tests, Chromium tests, build and `git diff --check` exit 0; the last command has no output; status contains only the plan record plus the two known untracked outputs.

- [ ] **Step 2: Update the GitHub repository description**

On `YuenHK/ShapeCut`, set the description exactly to:

```text
把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。
```

Verify the repository header or About section displays the exact text before leaving GitHub.

- [ ] **Step 3: Record verification and commit the plan result**

Append the actual test counts, build result and GitHub description verification to this plan, then:

```bash
git add -- docs/superpowers/plans/2026-08-04-spinning-top-positioning-copy.md
git commit -m "docs: record spinning-top copy verification"
```

- [ ] **Step 4: Push and wait for the Pages workflow**

```bash
git push origin main
```

Expected: remote `main` advances to local HEAD; the resulting `Deploy ShapeCut to GitHub Pages` build and deploy jobs both reach `completed / success`.

- [ ] **Step 5: Verify the public deployment**

```bash
curl -fsSL https://yuenhk.github.io/ShapeCut/ | rg -F 'ShapeCut｜3D 陀螺模型轉 Laser Cut 切片'
curl -fsSL https://yuenhk.github.io/ShapeCut/manifest.webmanifest | \
  jq -e '.description == "把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。"'
```

In Chrome, verify the new homepage `h1` and paragraph are visible and console has no errors. Confirm `sample1` and `sample2` links remain under `/ShapeCut/samples/`.

- [ ] **Step 6: Final repository safety check**

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/main
git status --short --branch
git ls-files | rg '(^|/)(shapecut-outline|Copy of Beyblade)'
```

Expected: local and remote SHA match; only `shapecut-outline.zip` and `shapecut-outline/` are untracked; forbidden tracked-file search has no output.
