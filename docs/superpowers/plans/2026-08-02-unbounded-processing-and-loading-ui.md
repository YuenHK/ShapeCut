# ShapeCut 無自動超時與中央讀取介面實現計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用核取方塊追蹤進度。

**目標：** 移除轉換與封裝的固定時間上限，同時保留取消、資源與製造安全檢查；以中央 B loading 面板顯示穩定動畫和 `已處理 mm:ss`。

**架構：** `Number.POSITIVE_INFINITY` 是唯一「沒有自動 deadline」的預算值，既有檢查點因此仍可由取消／資源錯誤中止，但不會因時鐘到期失敗。將重複的 loading 標記抽成獨立呈現元件；計時狀態封裝在該元件，避免每秒重繪 WebGL／Canvas 預覽。

**技術棧：** TypeScript、React、CSS animations、Vitest、Vitest Browser Mode、Comlink Web Worker。

---

### 任務 1：移除自動 deadline，保留資源與取消界線

**檔案：**
- 修改：`src/domain/outline-2.5d/types.ts:13-35`
- 修改：`src/domain/outline-2.5d/extract.ts:243-247`
- 修改：`src/domain/outline-2.5d/types.test.ts`
- 修改：`src/domain/pipeline/automatic-outline-pipeline.test.ts:901-960`
- 修改：`src/export/real-fixtures.integration.test.ts:119-143`
- 修改：`src/test/validate-fixtures-release.test.ts:84-128`
- 修改：`scripts/validate-fixtures.ts:150-195`

- [x] **步驟 1：先把預算契約測試改成無自動 deadline**

```ts
it('does not impose an automatic runtime deadline', () => {
  expect(DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs).toBe(Number.POSITIVE_INFINITY);
});
```

- [x] **步驟 2：執行測試並確認紅燈**

執行：`npm test -- src/domain/outline-2.5d/types.test.ts --maxWorkers=1 --fileParallelism=false`

預期：FAIL，收到 `120000` 而非 `Infinity`。

- [x] **步驟 3：允許無 deadline 的預算值**

在 `types.ts` 把 runtime 預設值改為：

```ts
readonly maxRuntimeMs: typeof Number.POSITIVE_INFINITY;
// …
maxRuntimeMs: Number.POSITIVE_INFINITY,
```

在 `extract.ts` 的預算驗證改為只拒絕 `NaN`、負數和零，明確接受 `Infinity`：

```ts
if (Number.isNaN(budgets.maxRuntimeMs) || budgets.maxRuntimeMs <= 0
  || !Number.isInteger(budgets.maxContourPointsPerLayer)
  // existing contour checks
) throw new RangeError('Contour extraction requires valid fail-closed budgets');
```

不要移除 `checkDeadline()` 或任一資源／製造安全驗證；`Date.now() + Infinity` 會讓既有 checkpoint 自然不會以時間中止。

- [x] **步驟 4：更新只為舊 120 秒而存在的驗收斷言**

保留以 mock `Date.now()` 驗證明確 deadline 的管線測試，但將「產品預設會 TIME_LIMIT」的期待改為「預設為 Infinity」。將真實 Knight Fortress 與 release fixture 的 `conversionElapsedMs < 120_000` 斷言移除，改為只要求有限、正數的實際耗時：

```ts
expect(Number.isFinite(conversionElapsedMs)).toBe(true);
expect(conversionElapsedMs).toBeGreaterThan(0);
```

- [x] **步驟 5：確認資源限制與取消仍有效**

保留／補上這兩個明確斷言：

```ts
await expect(convertAutomatically({ bytes: oversizedBytes }))
  .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
await expect(client.packageOutline(runtime, 0))
  .rejects.toMatchObject({ code: 'TIME_LIMIT' });
```

第二個測試證明呼叫端明確傳入過期 deadline 時，封裝仍安全停止；它不是產品預設限制。

- [x] **步驟 6：執行聚焦驗證並提交**

執行：

```bash
npm test -- src/domain/outline-2.5d/types.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/export/real-fixtures.integration.test.ts src/test/validate-fixtures-release.test.ts --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run src/workers/geometry-worker.browser.test.ts
```

預期：退出碼 0；資源與明確 deadline 測試仍通過。

提交：

```bash
git add src/domain/outline-2.5d/types.ts src/domain/outline-2.5d/extract.ts src/domain/outline-2.5d/types.test.ts src/domain/pipeline/automatic-outline-pipeline.test.ts src/export/real-fixtures.integration.test.ts src/test/validate-fixtures-release.test.ts scripts/validate-fixtures.ts
git commit -m "fix: remove automatic processing deadline"
```

### 任務 2：建立不造成預覽閃爍的中央 loading 面板

**檔案：**
- 新增：`src/app/ProcessingLoadingPanel.tsx`
- 新增：`src/app/ProcessingLoadingPanel.test.tsx`
- 修改：`src/app/OneClickConverter.tsx:55-60,494-640,834-871`
- 修改：`src/styles.css:685-730`

- [x] **步驟 1：為面板編寫失敗測試**

```tsx
it('shows the selected central B indicator and increments elapsed time once per second', () => {
  vi.useFakeTimers();
  render(<ProcessingLoadingPanel fileName="knight.stl" startedAt={0} now={() => Date.now()} />);
  expect(screen.getByText('已處理 00:00')).toBeVisible();
  act(() => { vi.advanceTimersByTime(63_000); });
  expect(screen.getByText('已處理 01:03')).toBeVisible();
  expect(document.querySelector('.processing-orbit')).toBeInTheDocument();
});
```

- [x] **步驟 2：執行測試並確認紅燈**

執行：`npm test -- src/app/ProcessingLoadingPanel.test.tsx --maxWorkers=1 --fileParallelism=false`

預期：FAIL，因元件不存在。

- [x] **步驟 3：實作獨立的計時與呈現元件**

建立 `ProcessingLoadingPanel.tsx`，只在自身 `useEffect` 以一秒 interval 更新 elapsed seconds，並在 unmount 清除 interval：

```tsx
export function ProcessingLoadingPanel({ fileName, startedAt }: {
  readonly fileName: string;
  readonly startedAt: number;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <div className="processing-loading-panel">{/* orbit, dots, title, filename, mm:ss */}</div>;
}
```

格式化函式必須零填充分與秒：`已處理 ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`。

- [x] **步驟 4：以單一開始時間串連所有 processing view**

在 `OneClickConverter.tsx` 加入 `processingStartedAt` state；選檔進入 reading 時設 `Date.now()`，新選檔、完成、失敗與取消時清除。reading、無 preview processing、以及有 preview processing 都傳入相同 `startedAt` 並使用 `<ProcessingLoadingPanel>`。不要把 elapsed seconds 放入 converter 的 `view` union，避免每秒令預覽重新 render。

- [x] **步驟 5：加入取消處理動作與測試**

在 loading panel 顯示 `取消處理` 按鈕。它必須遞增 `requestId`、取消 timeline、呼叫 `runtimeServices.cancel()`、清除開始時間，並回到已選材料畫面以便重新開始：

```ts
requestId.current += 1;
timelineRef.current?.cancel();
timelineRef.current = undefined;
runtimeServices.cancel();
setProcessingStartedAt(undefined);
setView({ kind: 'material', fileName, bytes });
```

新增元件整合測試，確認按下按鈕會呼叫 `cancel`、不顯示 failure alert、且計時元件已卸載。

- [x] **步驟 6：實作 B 視覺樣式並確認綠燈**

在 `styles.css` 加入中央 overlay 樣式，讓 `.processing-loading-panel` 在預覽存在時仍位於 viewport 中央；加入 `.processing-orbit` 的 CSS rotation 與上方三點。保留讀屏名稱，並讓計時以 `aria-live="polite"`、非每幀更新。

執行：

```bash
npm test -- src/app/ProcessingLoadingPanel.test.tsx src/app/OneClickConverter.test.tsx --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run src/app/App.browser.test.tsx
```

預期：退出碼 0；原本的 `processing-loading-panel` 斷言仍成立，新計時與取消測試通過。

- [x] **步驟 7：提交**

```bash
git add src/app/ProcessingLoadingPanel.tsx src/app/ProcessingLoadingPanel.test.tsx src/app/OneClickConverter.tsx src/app/OneClickConverter.test.tsx src/styles.css
git commit -m "feat: add central processing timer and cancel action"
```

### 任務 3：端到端驗證與交付

**檔案：**
- 修改：`docs/superpowers/plans/2026-08-02-unbounded-processing-and-loading-ui.md`

- [x] **步驟 1：檢查處理預設不再為有限時間**

執行：

```bash
rg -n "maxRuntimeMs: (120_000|30_000)" src scripts
```

預期：無輸出；明確測試 deadline 可保留，但產品預設不得有有限上限。

- [x] **步驟 2：執行完整檢查**

執行：

```bash
npm run typecheck
npm test -- --maxWorkers=1 --fileParallelism=false
npm run test:browser -- --run
npm run build
git diff --check
git status --short
```

預期：所有命令退出碼 0；僅計劃的核取方塊與本分支提交中的檔案有變更。

- [x] **步驟 3：記錄驗證結果並提交計劃**

把各步的實際結果填入已完成核取方塊，然後執行：

```bash
git add docs/superpowers/plans/2026-08-02-unbounded-processing-and-loading-ui.md
git commit -m "docs: record unbounded processing verification"
```

## 實際驗證結果（2026-08-03）

- 完整 Node 測試：67 個測試檔、1678/1678 項通過；退出碼 0；398.34 秒。
- 完整 Chromium 測試：6 個測試檔、82/82 項通過；退出碼 0；47.60 秒。
- TypeScript：`npm run typecheck` 退出碼 0。
- Production build：169 個模組完成轉換；`npm run build` 退出碼 0。
- 格式檢查：`git diff --check` 無輸出；退出碼 0。
- 逾時回歸：封裝與彩色文件聚焦測試 495/495 通過；pipeline 測試 35/35 通過。
- 安全邊界：產品預設使用 `Number.POSITIVE_INFINITY`；明確有限期限仍會逾時，`NaN` 與 `-Infinity` 維持 fail-closed；資源、製造與取消界線保留。
