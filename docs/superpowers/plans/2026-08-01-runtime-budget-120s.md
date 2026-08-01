# ShapeCut 120 秒處理預算實現計劃

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推薦）或 superpowers:executing-plans 逐任務實現此計劃。步驟使用核取方塊追蹤進度。

**目標：** 讓自動轉換及未指定 deadline 的輸出封裝共用 120,000 ms 處理上限。

**架構：** `DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs` 是唯一預算常數。自動管線已引用該常數；工作執行緒封裝改為匯入同一常數，消除獨立的 30,000 ms 預設值。

**技術棧：** TypeScript、Vitest、Comlink Web Worker、Vite。

---

### 任務 1：鎖定共用預算契約

**檔案：**
- 新增：`src/domain/outline-2.5d/types.test.ts`
- 修改：`src/domain/outline-2.5d/types.ts:26-35`

- [x] **步驟 1：編寫失敗的預算測試**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTLINE_BUDGETS } from './types';

describe('DEFAULT_OUTLINE_BUDGETS', () => {
  it('allows verified local conversion work for up to 120 seconds', () => {
    expect(DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs).toBe(120_000);
  });
});
```

- [x] **步驟 2：執行測試並確認紅燈**

執行：`npm test -- src/domain/outline-2.5d/types.test.ts`

預期：FAIL，因目前值為 `30000`。

- [x] **步驟 3：以最小修改更新共用預算**

```ts
maxRuntimeMs: 120_000,
```

- [x] **步驟 4：執行測試並確認綠燈**

執行：`npm test -- src/domain/outline-2.5d/types.test.ts`

預期：PASS。

### 任務 2：讓封裝採用同一預算來源

**檔案：**
- 修改：`src/workers/geometry.worker.ts:1-25,130`
- 測試：`src/workers/geometry-worker.browser.test.ts:450-459`

- [x] **步驟 1：擴充工作執行緒超時測試，保留明確 deadline 行為**

確認現有 `returns a typed TIME_LIMIT when the shared packaging deadline is exhausted`
測試仍會傳入 `packageOutline(runtime, 0)`，以保障明確 deadline 的超時行為不變。

- [x] **步驟 2：將封裝預設 deadline 接到共用常數**

在 `geometry.worker.ts` 匯入 `DEFAULT_OUTLINE_BUDGETS`，並改為：

```ts
async packageOutline(result, deadline = Date.now() + DEFAULT_OUTLINE_BUDGETS.maxRuntimeMs) {
```

- [x] **步驟 3：重跑相關測試並確認綠燈**

執行：`npm run test:browser -- --run src/workers/geometry-worker.browser.test.ts`

預期：PASS，且現有 `packageOutline(runtime, 0)` 仍回傳 `TIME_LIMIT`。

### 任務 3：驗證與提交

**檔案：**
- 修改：`src/domain/outline-2.5d/types.ts`
- 修改：`src/workers/geometry.worker.ts`
- 新增：`src/domain/outline-2.5d/types.test.ts`

- [ ] **步驟 1：執行型別與完整 Node 測試**

執行：`npm run typecheck && npm test -- --maxWorkers=1 --fileParallelism=false`

預期：退出碼 0。

- [ ] **步驟 2：執行全部 Browser Mode 測試及正式建置**

執行：`npm run test:browser -- --run && npm run build`

預期：退出碼 0。

- [ ] **步驟 3：檢查變更並提交**

執行：`git diff --check && git status --short`

提交：`git add src/domain/outline-2.5d/types.ts src/domain/outline-2.5d/types.test.ts src/workers/geometry.worker.ts src/workers/geometry-worker.browser.test.ts docs/superpowers/plans/2026-08-01-runtime-budget-120s.md && git commit -m "fix: extend local processing runtime budget"`
