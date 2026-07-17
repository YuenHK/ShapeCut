# 功能型陀螺 STL 轉 Laser Cut 工具實作計畫

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實作此計畫。步驟使用複選框（`- [ ]`）語法來追蹤進度。

**目標：** 建立一個瀏覽器本機運作的五步網頁向導，將功能型陀螺 STL 轉換為可校準、可編輯、保持平衡的 SVG/DXF/PDF Laser cut 套件。

**架構：** React 介面只管理向導狀態與預覽；純 TypeScript 領域模組負責網格、軸心、拆件、紋理、材料和加工前檢查。高負載幾何計算放入 Web Worker，所有輸入輸出使用可序列化、有版本的類型，以便測試和重開專案。

**技術棧：** Vite、React、TypeScript、Three.js `STLLoader`、Zustand、Zod、Comlink、Dexie/IndexedDB、JSZip、pdf-lib、Vitest、Testing Library、Playwright。幾何內核先使用專案內建的向量、網格和 2D 輪廓介面；需要引入多邊形交集或偏移引擎時，必須隱藏在 `PolygonKernel` 介面後。

---

## 執行前提

目前工作區不是 Git repository，因此尚未能建立專用 worktree 或執行以下 commit 步驟。開始實作前，必須先由使用者授權初始化 Git repository，建立初始 commit，再使用 `superpowers:using-git-worktrees` 建立專用 worktree。若使用者明確不要 Git，執行者可跳過每個 commit 步驟，但仍必須保留各任務的測試關卡。

## 規劃檔案結構

```text
src/
├── app/                     # 向導路由、專案狀態和主介面組合
├── domain/                  # 無 UI 依賴的幾何與加工規則
│   ├── mesh/             # STL 網格、檢查、修復和質量屬性
│   ├── axis/             # 候選旋轉軸與信心分數
│   ├── decomposition/    # 中心輪殼、骨架、外環和卡榫
│   ├── engraving/        # 高度場量化、對稱化和保護區
│   ├── materials/        # 材料設定檔和校準片
│   ├── layout/           # 板材排版與邊界檢查
│   └── preflight/        # 錯誤等級、位置與修正建議
├── workers/                  # Comlink Web Worker API
├── preview/                  # Three.js 場景、選擇、爆炸圖和熱圖
├── persistence/              # IndexedDB 專案與材料設定檔
├── export/                   # SVG、DXF、PDF、JSON 和 ZIP
└── test/                     # 共用 fixtures、幾何斷言和模型生成器
e2e/                         # Playwright 五步關鍵路徑
fixtures/stl/                # 小型可版本控制 STL 樣本
docs/materials/              # 安全材料預設說明
```

### 任務 1：建立可測試的前端骨架

**檔案：**
- 建立：`package.json`、`vite.config.ts`、`vitest.config.ts`、`playwright.config.ts`、`tsconfig.json`、`index.html`
- 建立：`src/main.tsx`、`src/app/App.tsx`、`src/app/App.test.tsx`、`src/styles.css`

- [ ] **步驟 1：建立失敗的應用程式啟動測試**

```tsx
// src/app/App.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('shows the five-step spinner workflow', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '陀螺 Laser Kit' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});
```

- [ ] **步驟 2：安裝依賴並驗證測試先失敗**

執行：`npm install && npm run test -- src/app/App.test.tsx`  
預期：FAIL，`Cannot find module './App'` 或缺少目標標題。`package.json` 必須含 `dev`、`build`、`typecheck`、`test`、`test:browser` 和 `test:e2e` scripts。

- [ ] **步驟 3：實作最小五步應用骨架**

```tsx
// src/app/App.tsx
const steps = ['匯入與修復', '軸心與尺寸', '自動拆件', '紋理與材料', '排版與輸出'];
export function App() {
  return <main><h1>陀螺 Laser Kit</h1><ol>{steps.map(step => <li key={step}>{step}</li>)}</ol></main>;
}
```

- [ ] **步驟 4：執行單元測試、型別檢查和 production build**

執行：`npm run test -- src/app/App.test.tsx && npm run typecheck && npm run build`  
預期：測試 PASS，TypeScript 0 errors，Vite build 成功。

- [ ] **步驟 5：Commit**

```bash
git add package.json package-lock.json vite.config.ts vitest.config.ts playwright.config.ts tsconfig.json index.html src
git commit -m "chore: scaffold spinner laser kit app"
```

### 任務 2：定義版本化領域類型與專案狀態

**檔案：**
- 建立：`src/domain/types.ts`、`src/app/project-store.ts`、`src/app/project-store.test.ts`

- [ ] **步驟 1：建立狀態不能跳過未完成步驟的失敗測試**

```ts
import { describe, expect, it } from 'vitest';
import { createProjectStore } from './project-store';

it('blocks decomposition until axis is confirmed', () => {
  const store = createProjectStore();
  expect(store.getState().goToStep('decomposition')).toBe(false);
  expect(store.getState().step).toBe('import');
});
```

- [ ] **步驟 2：執行 `npm run test -- src/app/project-store.test.ts`**  
預期：FAIL，`createProjectStore` 未定義。

- [ ] **步驟 3：建立辨別聯集與最小 Zustand store**

```ts
export type WorkflowStep = 'import' | 'axis' | 'decomposition' | 'engraving' | 'export';
export type Vec3 = readonly [number, number, number];
export type Axis = { origin: Vec3; direction: Vec3; confidence: number; confirmed: boolean };
export type Severity = 'blocking' | 'confirm' | 'info';
export type ProjectV1 = { schemaVersion: 1; id: string; name: string; step: WorkflowStep; axis?: Axis };
```

`goToStep()` 以純函數 `canEnterStep(project, target)` 進行關卡檢查；當 `target === 'decomposition'` 時必須有 `axis.confirmed === true`。

- [ ] **步驟 4：執行 `npm run test -- src/app/project-store.test.ts && npm run typecheck`**  
預期：PASS，0 type errors。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/types.ts src/app/project-store.ts src/app/project-store.test.ts
git commit -m "feat: define versioned project workflow state"
```

### 任務 3：STL 解析、網格檢查與質量屬性

**檔案：**
- 建立：`src/domain/mesh/parse-stl.ts`、`src/domain/mesh/inspect-mesh.ts`、`src/domain/mesh/mass-properties.ts`
- 建立：`src/domain/mesh/mesh.test.ts`、`src/test/mesh-builders.ts`、`fixtures/stl/symmetric-spinner.stl`

- [ ] **步驟 1：建立封閉四面體和破面網格測試**

```ts
it('reports boundary edges and computes a closed mesh centroid', () => {
  expect(inspectMesh(openTetrahedron()).boundaryEdgeCount).toBe(3);
  expect(inspectMesh(tetrahedron()).boundaryEdgeCount).toBe(0);
  expect(massProperties(tetrahedron()).centroid).toEqual([0.25, 0.25, 0.25]);
});
```

- [ ] **步驟 2：執行 `npm run test -- src/domain/mesh/mesh.test.ts`**  
預期：FAIL，網格 API 未定義。

- [ ] **步驟 3：實作 `TriangleMesh`、STLLoader adapter、edge incidence map 和 signed-tetrahedra 質量屬性**

```ts
export type TriangleMesh = { positions: Float64Array; indices: Uint32Array };
export type MeshInspection = {
  triangleCount: number; boundaryEdgeCount: number; nonManifoldEdgeCount: number;
  degenerateTriangleCount: number; invertedVolume: boolean;
};
export type MassProperties = { volume: number; centroid: Vec3 };
```

對近零 signed volume 返回 blocking issue；不可在 parser 中靜默修改幾何。

- [ ] **步驟 4：執行 `npm run test -- src/domain/mesh/mesh.test.ts && npm run typecheck`**  
預期：PASS，兩種 STL 格式 fixture 都能解析。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/mesh src/test/mesh-builders.ts fixtures/stl
git commit -m "feat: parse and inspect STL meshes"
```

### 任務 4：旋轉軸候選、信心分數與手動確認

**檔案：**
- 建立：`src/domain/axis/find-axis.ts`、`src/domain/axis/radial-symmetry.ts`、`src/domain/axis/find-axis.test.ts`
- 建立：`src/app/steps/AxisStep.tsx`、`src/app/steps/AxisStep.test.tsx`

- [ ] **步驟 1：建立旋轉體找到 Z 軸、不對稱模型低信心的測試**

```ts
it('ranks the symmetry axis first', () => {
  const [best] = findAxisCandidates(makeLathedSpinner(), { sampleCount: 4096 });
  expect(Math.abs(best.direction[2])).toBeGreaterThan(0.999);
  expect(best.confidence).toBeGreaterThan(0.8);
});
```

- [ ] **步驟 2：執行 `npm run test -- src/domain/axis/find-axis.test.ts`**  
預期：FAIL，`findAxisCandidates` 未定義。

- [ ] **步驟 3：實作主慣性軸候選＋等角徑向輪廓 RMS 誤差評分**

```ts
export type AxisCandidate = Axis & {
  radialRmsError: number; centroidOffset: number; source: 'inertia' | 'hole' | 'manual';
};
export function findAxisCandidates(mesh: TriangleMesh, options: { sampleCount: number }): AxisCandidate[];
```

信心低於 `0.8` 時 UI 必須顯示「需要確認」，並提供拖動方向和對齊主軸按鈕。

- [ ] **步驟 4：執行領域和 UI 測試**

執行：`npm run test -- src/domain/axis/find-axis.test.ts src/app/steps/AxisStep.test.tsx`  
預期：PASS；低信心時「下一步」禁用，手動確認後啟用。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/axis src/app/steps/AxisStep.tsx src/app/steps/AxisStep.test.tsx
git commit -m "feat: detect and confirm spinner axis"
```

### 任務 5：混合式拆件與卡榫生成

**檔案：**
- 建立：`src/domain/decomposition/types.ts`、`src/domain/decomposition/profile-sampler.ts`
- 建立：`src/domain/decomposition/generate-parts.ts`、`src/domain/decomposition/joints.ts`、`src/domain/decomposition/generate-parts.test.ts`

- [ ] **步驟 1：建立 8 骨架、3 外環和軸孔同心測試**

```ts
it('creates paired radial ribs and concentric hardware holes', () => {
  const kit = generateParts(lathedProfile, material3mm, { ribCount: 8, ringLayers: 3, shaftMm: 3 });
  expect(kit.parts.filter(p => p.kind === 'rib')).toHaveLength(8);
  expect(kit.parts.filter(p => p.kind === 'outer-ring')).toHaveLength(3);
  expect(kit.parts.every(p => p.holes.every(h => h.center[0] === 0 && h.center[1] === 0))).toBe(true);
});
```

- [ ] **步驟 2：執行 `npm run test -- src/domain/decomposition/generate-parts.test.ts`**  
預期：FAIL，`generateParts` 未定義。

- [ ] **步驟 3：實作零件介面與決定性生成器**

```ts
export type PartKind = 'hub-layer' | 'rib' | 'outer-ring' | 'spacer';
export type Part2D = { id: string; kind: PartKind; outline: Polygon2; holes: Polygon2[]; quantity: number };
export type DecompositionOptions = { ribCount: 4 | 6 | 8 | 10 | 12; ringLayers: number; shaftMm: number; fit: 'loose' | 'slip' | 'snug' | 'press' };
export type SpinnerKit = { parts: Part2D[]; assembly: AssemblyEdge[]; estimatedBalance: BalanceResult };
```

生成器必須以輸入 hash 產生穩定 part ID；卡榫寬度使用 `material.thicknessMm + fitAllowanceMm`。

- [ ] **步驟 4：執行測試，並對 4/6/8/10/12 骨架做 parameterized test**  
預期：所有骨架為等角成對，卡榫成雙且沒有超出零件外形。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/decomposition
git commit -m "feat: generate hybrid spinner parts and joints"
```

### 任務 6：平衡估算、紋理對稱化與安全區

**檔案：**
- 建立：`src/domain/engraving/height-field.ts`、`src/domain/engraving/quantize.ts`、`src/domain/engraving/symmetrize.ts`
- 建立：`src/domain/engraving/protected-zones.ts`、`src/domain/engraving/engraving.test.ts`
- 建立：`src/domain/decomposition/balance.ts`、`src/domain/decomposition/balance.test.ts`

- [ ] **步驟 1：建立分級、保護區和不對稱去料測試**

```ts
it('keeps joints unengraved and mirrors mass removal', () => {
  const map = quantizeHeightField(sampleField, 4);
  const safe = applyProtectedZones(map, [jointZone]);
  const symmetric = symmetrizeEngraving(safe, { sectors: 8 });
  expect(symmetric.levelAt(jointZone.center)).toBe(0);
  expect(estimateBalance(symmetric).centroidOffsetMm).toBeLessThan(0.05);
});
```

- [ ] **步驟 2：執行兩個測試檔**  
執行：`npm run test -- src/domain/engraving/engraving.test.ts src/domain/decomposition/balance.test.ts`  
預期：FAIL，量化和平衡 API 未定義。

- [ ] **步驟 3：實作雕刻圖層與平衡結果**

```ts
export type EngravingMap = { levels: 3 | 4 | 5; regions: { level: number; polygon: Polygon2 }[] };
export type BalanceResult = { centroidOffsetMm: number; angularMassError: number; status: 'pass' | 'confirm' | 'block' };
```

量化後要以同一角度 sector 複製雕刻區；軸孔、卡榫、骨架受力邊和外緣連接處為 level 0 或材料允許的最淺級。

- [ ] **步驟 4：執行測試與型別檢查**  
預期：3/4/5 級均 PASS；不對稱 fixture 轉換後偏差低於測試限制。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/engraving src/domain/decomposition/balance.ts src/domain/decomposition/balance.test.ts
git commit -m "feat: quantize safe balanced engraving regions"
```

### 任務 7：材料設定檔、校準片與 IndexedDB

**檔案：**
- 建立：`src/domain/materials/schema.ts`、`src/domain/materials/calibration-coupon.ts`、`src/domain/materials/materials.test.ts`
- 建立：`src/persistence/database.ts`、`src/persistence/material-repository.ts`、`src/persistence/material-repository.test.ts`
- 建立：`docs/materials/safety.md`

- [ ] **步驟 1：建立 PVC 被拒絕、未校準材料需確認的測試**

```ts
it('rejects forbidden laser materials', () => {
  expect(() => MaterialProfileSchema.parse({ ...validProfile, materialCode: 'PVC' })).toThrow(/not laser safe/i);
});
```

- [ ] **步驟 2：執行 `npm run test -- src/domain/materials/materials.test.ts`**  
預期：FAIL，`MaterialProfileSchema` 未定義。

- [ ] **步驟 3：實作 Zod schema、版本升級、Dexie repository 和測試片幾何**

```ts
export type MaterialProfileV1 = {
  schemaVersion: 1; id: string; machine: string; materialCode: string; thicknessMm: number;
  kerfMm: number; fitAllowanceMm: Record<'loose'|'slip'|'snug'|'press', number>;
  minFeatureMm: number; minWebMm: number; minRemainingMm: number;
  recipes: Record<'cut'|'score'|'engrave1'|'engrave2'|'engrave3'|'engrave4'|'engrave5', ProcessRecipe | null>;
  calibratedAt: string | null;
};
```

安全列表使用 allowlist 預設＋明確 denylist；自定材料永遠標記為未驗證，直到使用者完成校準。

- [ ] **步驟 4：執行材料和 repository 測試**  
預期：測試片包含至少 5 個卡榫公差、切縫測試和所選雕刻級別；IndexedDB round-trip 保留 schema version。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/materials src/persistence docs/materials/safety.md
git commit -m "feat: add calibrated material profiles"
```

### 任務 8：Web Worker 計算邊界與取消

**檔案：**
- 建立：`src/workers/geometry-api.ts`、`src/workers/geometry.worker.ts`、`src/workers/geometry-client.ts`、`src/workers/geometry-api.test.ts`

- [ ] **步驟 1：建立過期計算結果不能覆蓋新結果的測試**

```ts
it('drops stale job results', async () => {
  const client = makeGeometryClient(fakeWorker({ firstDelay: 50, secondDelay: 1 }));
  const first = client.analyze(meshA);
  const second = client.analyze(meshB);
  await expect(second).resolves.toMatchObject({ sourceHash: 'mesh-b' });
  await expect(first).rejects.toThrow('Superseded');
});
```

- [ ] **步驟 2：執行 `npm run test -- src/workers/geometry-api.test.ts`**  
預期：FAIL，client 未定義。

- [ ] **步驟 3：實作 Comlink API 和 monotonically increasing job ID**

```ts
export type GeometryApi = {
  inspect(input: ArrayBuffer): Promise<MeshAnalysis>;
  findAxes(mesh: SerializedMesh): Promise<AxisCandidate[]>;
  decompose(request: DecompositionRequest): Promise<SpinnerKit>;
  engrave(request: EngravingRequest): Promise<EngravingMap>;
};
```

傳送 `ArrayBuffer` 時使用 transferable；UI 離開步驟或輸入變更時取消邏輯 job，而不是等待舊結果。

- [ ] **步驟 4：執行 `npm run test -- src/workers/geometry-api.test.ts && npm run typecheck`**  
預期：PASS，過期工作返回 `Superseded` typed error。

- [ ] **步驟 5：Commit**

```bash
git add src/workers
git commit -m "feat: isolate geometry processing in worker"
```

### 任務 9：Three.js 3D 預覽、爆炸圖與問題定位

**檔案：**
- 建立：`src/preview/SpinnerViewport.tsx`、`src/preview/scene-controller.ts`、`src/preview/color-map.ts`
- 建立：`src/preview/SpinnerViewport.test.tsx`

- [ ] **步驟 1：建立點選錯誤列時聚焦 3D 區域的測試**

```tsx
it('focuses the referenced geometry issue', async () => {
  render(<SpinnerViewport issues={[thinWallIssue]} />);
  await userEvent.click(screen.getByRole('button', { name: /thin wall/i }));
  expect(fakeController.focusRegion).toHaveBeenCalledWith(thinWallIssue.regionId);
});
```

- [ ] **步驟 2：在 Vitest Browser Mode 執行測試**  
執行：`npm run test:browser -- src/preview/SpinnerViewport.test.tsx`  
預期：FAIL，viewport 未定義。

- [ ] **步驟 3：實作單一 Three.js scene controller**

`scene-controller.ts` 負責 renderer、camera、orbit controls、resize、dispose、part selection、exploded transform、engraving level colors 和 issue overlay；React 組件不直接管理 Three.js object lifecycle。

```ts
export interface SceneController {
  setMesh(mesh: TriangleMesh): void; setParts(parts: SpinnerKit): void;
  setExploded(amount: number): void; setEngraving(map: EngravingMap): void;
  focusRegion(id: string): void; dispose(): void;
}
```

- [ ] **步驟 4：執行 browser test 和 20 次 mount/unmount leak test**  
預期：PASS；每次 dispose 後 canvas、event listener 和 WebGL resources 回到基線。

- [ ] **步驟 5：Commit**

```bash
git add src/preview
git commit -m "feat: add interactive spinner preview"
```

### 任務 10：五步向導介面與可編輯參數

**檔案：**
- 建立：`src/app/Wizard.tsx`、`src/app/steps/ImportStep.tsx`、`src/app/steps/DecompositionStep.tsx`
- 建立：`src/app/steps/EngravingStep.tsx`、`src/app/steps/ExportStep.tsx`、`src/app/Wizard.test.tsx`
- 修改：`src/app/App.tsx`

- [ ] **步驟 1：建立從匯入到匯出的組件關鍵路徑測試**

```tsx
it('keeps export disabled until blocking checks pass', async () => {
  render(<Wizard services={fakeSuccessfulServices()} />);
  await importFixture('symmetric-spinner.stl');
  await confirmAxis(); await acceptDecomposition(); await chooseMaterial('Plywood 3 mm');
  expect(screen.getByRole('button', { name: '匯出製作套件' })).toBeEnabled();
});
```

- [ ] **步驟 2：執行 `npm run test -- src/app/Wizard.test.tsx`**  
預期：FAIL，`Wizard` 未定義。

- [ ] **步驟 3：實作向導、步驟關卡和參數表單**

每個參數變更要經 store action；幾何結果只由 worker response 寫入。可修改項目包括分件線、骨架數、外環層數、金屬軸徑、卡榫配合、雕刻級數、紋理強度和板材尺寸。

- [ ] **步驟 4：執行組件測試、a11y 掃描與型別檢查**  
預期：鍵盤可操作所有表單與步驟，blocking issue 與目標區域有 `aria-describedby` 關聯。

- [ ] **步驟 5：Commit**

```bash
git add src/app
git commit -m "feat: build five-step conversion wizard"
```

### 任務 11：排版、切縫補償與加工前檢查

**檔案：**
- 建立：`src/domain/layout/polygon-kernel.ts`、`src/domain/layout/kerf.ts`、`src/domain/layout/nest.ts`
- 建立：`src/domain/preflight/run-preflight.ts`、`src/domain/preflight/rules.ts`
- 建立：`src/domain/layout/layout.test.ts`、`src/domain/preflight/preflight.test.ts`

- [ ] **步驟 1：建立外形向外、內孔向內的切縫方向測試**

```ts
it('offsets outlines and holes in opposite directions', () => {
  const result = applyKerf(partWithHole, 0.2);
  expect(area(result.outline)).toBeGreaterThan(area(partWithHole.outline));
  expect(area(result.holes[0])).toBeLessThan(area(partWithHole.holes[0]));
});
```

- [ ] **步驟 2：執行 layout 和 preflight 測試**  
預期：FAIL，`applyKerf` 與 `runPreflight` 未定義。

- [ ] **步驟 3：實作 `PolygonKernel`、決定性 first-fit-decreasing 排版和規則引擎**

```ts
export interface PolygonKernel { offset(p: Polygon2, mm: number): Polygon2[]; intersects(a: Polygon2, b: Polygon2): boolean; }
export type PreflightIssue = { code: string; severity: Severity; message: string; regionId?: string; fixes: FixAction[] };
export type PreflightContext = { kit: SpinnerKit; material: MaterialProfileV1; sheets: SheetLayout[]; engraving: EngravingMap };
```

規則必須覆蓋：網格狀態、軸心確認、重心偏差、最小特徵、最小連接寬度、雕刻剩餘厚度、卡榫強度、板材越界、零件重疊、材料校準狀態和禁止材料。

- [ ] **步驟 4：執行 `npm run test -- src/domain/layout src/domain/preflight`**  
預期：PASS；blocking issue 使匯出不可用，confirm issue 需顯式確認。

- [ ] **步驟 5：Commit**

```bash
git add src/domain/layout src/domain/preflight
git commit -m "feat: add kerf layout and preflight checks"
```

### 任務 12：SVG、DXF、PDF、JSON 與 ZIP 匯出

**檔案：**
- 建立：`src/export/layers.ts`、`src/export/svg.ts`、`src/export/dxf.ts`、`src/export/pdf.ts`
- 建立：`src/export/project-json.ts`、`src/export/package.ts`、`src/export/export.test.ts`

- [ ] **步驟 1：建立四種格式在尺寸、圖層和零件編號一致的測試**

```ts
it('exports matching layer and part manifests', async () => {
  const files = await buildPackage(completeProject);
  expect(readSvgLayers(files.svg)).toEqual(['CUT', 'SCORE', 'ENGRAVE_1', 'ENGRAVE_2', 'ENGRAVE_3', 'ENGRAVE_4']);
  expect(readDxfLayers(files.dxf)).toEqual(readSvgLayers(files.svg));
  expect(readPdfPartIds(files.pdf)).toEqual(completeProject.kit.parts.map(p => p.id));
});
```

- [ ] **步驟 2：執行 `npm run test -- src/export/export.test.ts`**  
預期：FAIL，`buildPackage` 未定義。

- [ ] **步驟 3：實作共用 `ManufacturingDocument` 中間模型和各格式 writer**

```ts
export type LayerName = 'CUT' | 'SCORE' | `ENGRAVE_${1|2|3|4|5}`;
export type ManufacturingDocument = { unit: 'mm'; sheets: { width: number; height: number; entities: LayerEntity[] }[]; manifest: PartManifest[] };
```

所有 writer 只讀取這個中間模型，禁止各自重算幾何。ZIP 路徑必須與規格第 8 節一致；`project-settings.json` 寫入 schema version 和 STL SHA-256，不默認嵌入 STL。

- [ ] **步驟 4：執行 export golden tests**  
執行：`npm run test -- src/export/export.test.ts`  
預期：PASS；解開 ZIP 後檔案完整，SVG/DXF 以 mm 輸出，PDF 含零件數量和組裝順序。

- [ ] **步驟 5：Commit**

```bash
git add src/export
git commit -m "feat: export complete laser manufacturing package"
```

### 任務 13：專案儲存、重開與 STL 指紋驗證

**檔案：**
- 建立：`src/persistence/project-repository.ts`、`src/persistence/project-repository.test.ts`
- 修改：`src/app/App.tsx`、`src/app/project-store.ts`

- [ ] **步驟 1：建立錯誤 STL 不能重開專案的測試**

```ts
it('requires the original STL hash on reopen', async () => {
  const saved = await repository.save(projectWithHash('expected'));
  await expect(repository.attachSource(saved.id, fileWithHash('other'))).rejects.toThrow('STL fingerprint mismatch');
});
```

- [ ] **步驟 2：執行 `npm run test -- src/persistence/project-repository.test.ts`**  
預期：FAIL，repository 未定義。

- [ ] **步驟 3：實作專案 migration、autosave debounce 和 Web Crypto SHA-256 比對**

自動儲存間隔為最後一次修改後 500 ms；儲存失敗必須在頁面持續顯示，不可只寫 console。

- [ ] **步驟 4：執行 persistence 測試與瀏覽器 refresh 測試**  
預期：同一 STL 重開後回到之前步驟；不同 STL 停在匯入步驟並顯示指紋錯誤。

- [ ] **步驟 5：Commit**

```bash
git add src/persistence src/app/App.tsx src/app/project-store.ts
git commit -m "feat: persist and reopen local projects"
```

### 任務 14：端對端關鍵路徑、性能與可安裝建置

**檔案：**
- 建立：`e2e/happy-path.spec.ts`、`e2e/invalid-mesh.spec.ts`、`e2e/material-calibration.spec.ts`
- 建立：`e2e/helpers.ts`、`public/manifest.webmanifest`
- 修改：`vite.config.ts`、`package.json`、`README.md`

- [ ] **步驟 1：建立從 STL 到 ZIP 的失敗 E2E 測試**

```ts
test('converts a calibrated symmetric spinner', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('匯入 STL').setInputFiles('fixtures/stl/symmetric-spinner.stl');
  await page.getByRole('button', { name: '確認軸心' }).click();
  await page.getByRole('button', { name: '接受拆件建議' }).click();
  await page.getByLabel('材料').selectOption('plywood-3mm-calibrated');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出製作套件' }).click();
  expect((await download).suggestedFilename()).toMatch(/laser-kit\.zip$/);
});
```

- [ ] **步驟 2：執行 `npm run test:e2e`**  
預期：FAIL，完整互動尚未連接或 fixture profile 不存在。

- [ ] **步驟 3：連接真實 worker、預覽、預設校準 fixture 和下載流程**

README 必須記錄安裝、測試、本機開發、建置、安全警告、支援格式和第一版限制。PWA 只緩存靜態應用檔，專案與 STL 不上傳。

- [ ] **步驟 4：執行完整驗證關卡**

執行：`npm run test && npm run test:browser && npm run test:e2e && npm run typecheck && npm run build`  
預期：全部 PASS；build 無 TypeScript error；E2E 產生可解開 ZIP；非封閉 STL 有 blocking issue；未校準材料有 confirm issue。

- [ ] **步驟 5：執行性能基準**

使用 100k 和 500k 三角形 fixture 在 Chromium 記錄解析、軸心、拆件和雕刻時間；驗收上限為 100k 三角形首次可互動預覽 3 秒內，任何連續主執行緒阻塞低於 100 ms。若超標，先用 performance trace 定位 worker 外工作，不加入未驗證快取。

- [ ] **步驟 6：Commit**

```bash
git add e2e public vite.config.ts package.json README.md
git commit -m "test: verify complete spinner conversion workflow"
```

### 任務 15：代表性 STL 與實物材料驗收

**檔案：**
- 建立：`fixtures/acceptance/manifest.json`、`docs/validation/software-results.md`
- 建立：`docs/validation/physical-sample-form.md`

- [ ] **步驟 1：建立 10 個 STL 驗收 manifest**

```json
{
  "schemaVersion": 1,
  "models": [
    { "file": "symmetric-smooth.stl", "expected": "auto-axis" },
    { "file": "symmetric-textured.stl", "expected": "auto-axis" },
    { "file": "off-axis-hole.stl", "expected": "manual-axis-or-block" }
  ]
}
```

manifest 最終必須有 10 個真實可重分發或專案自建模型，覆蓋平滑、紋理、中空、寬外環、薄壁、低對稱和無效網格。

- [ ] **步驟 2：執行自動驗收 runner**

執行：`npm run validate:fixtures`  
預期：至少 8/10 自動找到正確軸心並產生可編輯拆件；其餘模型明確返回手動軸心或 blocking 原因。

- [ ] **步驟 3：產生三種材料製作套件**

為 3 mm 夾板、3 mm 紙板和一種經廠商確認可 Laser 加工的亞加力板，分別先輸出校準片，校準後再輸出同一陀螺套件。

- [ ] **步驟 4：由合資格操作員完成實物製作表**

`physical-sample-form.md` 必須記錄機器、材料批次、實測厚度、切縫、卡榫、每級雕刻、組裝、軸孔同心度、低速試轉、結構破壞與修正結果。實物 Laser 操作不由自動化測試代替。

- [ ] **步驟 5：更新軟件與實物結果報告後 Commit**

```bash
git add fixtures/acceptance docs/validation
git commit -m "test: document software and physical acceptance"
```

## 最終完成關卡

- [ ] 規格第 1–12 節每項要求都已對應到上述任務和測試。
- [ ] `npm run test`、`npm run test:browser`、`npm run test:e2e`、`npm run typecheck` 和 `npm run build` 全部通過。
- [ ] 10 個代表性 STL 的自動軸心成功率至少 8/10，失敗個案有明確處理結果。
- [ ] 三種材料的實物校準、組裝、同心度、低速旋轉、結構與紋理驗證已記錄。
- [ ] 加工前檢查可阻止無效網格、不安全雕刻、不平衡結構、板材越界與明確禁止材料。
- [ ] SVG、DXF、PDF、JSON 和 ZIP manifest 的單位、尺寸、圖層、零件編號及數量一致。
