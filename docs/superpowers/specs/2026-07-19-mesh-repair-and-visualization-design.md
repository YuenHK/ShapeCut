# STL 網格修復與問題視覺化設計

日期：2026-07-19

## 目標

讓使用者匯入 STL 後，工具能準確區分讀檔錯誤與網格拓撲問題，自動執行不改變外形的安全修復，並在仍然不合格時提供有明確警告、可回復的進階修復。使用者可以在 3D 預覽查看問題位置、比較修復前後統計，以及下載修復後 STL。

## 已確認範圍

- 使用純瀏覽器方案，所有分析與修復在本機 Web Worker 執行，STL 不會上傳。
- 預設自動執行安全修復。
- 安全修復仍有 blocking 問題時，才顯示進階修復選項。
- 進階修復必須由使用者確認「可能改變模型細節」後執行。
- 永遠保留原始網格，可隨時復原；不覆寫原始 STL。
- 支援下載修復後的 binary STL。
- 顯示修復前後的問題數量、三角形數、尺寸和體積差異。
- 以 `Copy of Beyblade X Knight Fortress.stl` 作真實驗收案例。該檔案可正常解析，包含 37,116 個三角形、105 條非流形邊和 63 個退化三角形。

## 不在本次範圍

- 不建立伺服器端修復服務。
- 不呼叫 Blender、MeshLab 或其他桌面軟件。
- 不保證任何任意損壞模型都能自動修復。
- 不會在修復後自動批准生產；既有材料、kerf 與實體校準關卡仍然有效。

## 架構

新增獨立的 mesh repair domain 模組，負責分析問題位置、執行安全修復、執行受限制的進階修復，以及計算修復差異。Worker API 接收 STL buffer，回傳原始預覽、修復結果、統計和可視化標記；React wizard 只負責狀態、確認流程與下載操作。Three.js scene controller 只接收問題幾何，不自行判斷拓撲。

原始網格和目前採用網格在工作流程中分開保存。任何修復例外、資源限制或超出形狀容差的結果都不會取代目前網格。

## 資料模型

`MeshProblemReport` 包含：

- `inspection`：既有 `MeshInspection`。
- `duplicateTriangleCount`。
- `boundaryEdges`、`nonManifoldEdges`：問題邊端點座標；回傳數量設上限，完整計數仍保留。
- `degenerateTriangles`、`duplicateTriangles`：問題三角形座標；回傳數量設上限。

`MeshRepairResult` 包含：

- `mode`：`safe` 或 `advanced`。
- `mesh`：修復後網格。
- `before`、`after`：`MeshProblemReport`。
- `changes`：移除、焊接、拆分和補合項目數量。
- `comparison`：三軸 bounding-box 尺寸、絕對體積、尺寸變化百分比和體積變化百分比。
- `accepted`：是否通過拓撲與形狀容差。
- `blockingReasons`：未通過時的具體原因。

## 安全修復

安全修復會按固定次序：

1. 移除索引重複或面積低於現有 scale-aware tolerance 的退化三角形。
2. 移除由相同三個頂點構成的重複三角形，不論 winding。
3. 以相對模型 bounding-box 的小容差焊接極接近頂點；容差不得大於最長邊的 `1e-7`。
4. 清除未被任何三角形引用的孤立頂點並重新編號。
5. 重新檢查網格。

安全修復不得補洞、刪除非退化外表面、改變面 winding 或合併分離外殼。若仍有 boundary edge 或 non-manifold edge，結果保持 blocking。

## 進階修復

進階修復只在安全修復後仍有 blocking 拓撲時提供，並要求明確確認。第一版採受限制策略：

1. 對 incidence 大於 2 的非流形邊，保留能維持一致外表面方向的兩個 incident faces，移除完全重合或位於封閉外殼內的多餘面。
2. 將仍然共用非流形邊的獨立 surface fan 拆分頂點，使每個 manifold sheet 有獨立拓撲。
3. 只補合由單一、小型平面邊界環形成的缺口；環周長不得超過模型最長邊的 2%，頂點不得超過 12 個。
4. 重新定向連通外殼，使其 signed volume 為正。
5. 重新檢查並計算形狀差異。

進階修復通過條件：boundary edge、non-manifold edge、degenerate triangle 和 duplicate triangle 均為 0；任一軸 bounding-box 尺寸變化不超過 0.5%；絕對體積變化不超過 1%。超出任何限制即保持 blocking，使用者仍可下載結果作外部檢查，但不能直接進入自動拆件。

## 使用者流程

1. 使用者選擇 STL 並按「分析模型」。
2. Worker 解析檔案；解析失敗顯示原始、具體錯誤訊息。
3. 工具顯示原始統計並自動安全修復。
4. 安全修復合格時顯示前後比較，採用修復網格並進入軸心步驟。
5. 安全修復未合格時留在匯入步驟，顯示問題位置及「進階修復」選項。
6. 使用者確認警告後執行進階修復。
7. 合格結果可「使用修復模型」；任何修復結果均可下載；「復原原始模型」會恢復原始報告和預覽。

## 3D 問題視覺化

- 正常模型使用現有材質。
- boundary edge 使用紅色線段。
- non-manifold edge 使用洋紅色線段。
- degenerate triangle 使用橙色標記。
- duplicate triangle 使用黃色半透明面。
- 問題清單每項有穩定 `regionId`；點擊後由 scene controller 聚焦該標記的 bounding box。
- 為控制記憶體，預覽最多回傳每類 2,000 個標記，介面同時顯示完整問題總數和「只顯示首 2,000 個」提示。

## 錯誤與資源限制

- 修復在既有 Comlink worker 邊界執行，避免阻塞主執行緒。
- 沿用 128 MiB、500,000 triangles、300,000 unique vertices 的解析上限。
- 修復產生的 triangles 不得超過原始數量的 110% 或 500,000，以較小者為準。
- Worker 失敗時保留原始網格，顯示具體錯誤，不切換 wizard step。
- 「網格有開放邊界」拆分成開放邊界、非流形、退化及重複面訊息；可成功解析的檔案不得顯示為「讀不到檔案」。

## STL 下載

下載採 binary STL，檔名為原檔名加 `-repaired.stl`。Header 記錄修復模式，但不加入來源 STL。輸出前再次解析並檢查下載 buffer，確保 triangle count、byte length 和目前修復網格一致。

## 測試與驗收

- Domain unit tests：退化面、重複面、孤立頂點、近距離頂點、非流形 edge fan、小型平面缺口、超限缺口、形狀差異與資源限制。
- Worker browser tests：transfer、取消／失敗後保留原始資料、問題標記上限。
- React browser tests：自動安全修復、進階確認、前後比較、問題聚焦、復原和下載。
- E2E：Knight Fortress 可正常讀取；介面準確顯示 105 條非流形邊和 63 個退化三角形；安全修復後如仍有 blocking，進階按鈕出現而軸心步驟保持鎖定。
- Regression：既有有效 STL 直接通過，開放 STL 仍保持 blocking，所有現有 unit、Chromium、E2E、typecheck、build 和 performance tests 通過。

## 成功標準

- 使用者不再將拓撲問題誤認為讀檔失敗。
- 可安全修復的模型自動完成清理並繼續流程。
- 不可安全修復的問題在 3D 預覽有準確位置與類型。
- 進階修復必須明確確認、可比較、可復原、可下載，且超出形狀容差時不能進入自動拆件。
