# ShapeCut A3 Rust WASM 幾何加速設計

日期：2026-08-31  
狀態：已批准直接實作  
模式：A3（GitHub Pages 本機瀏覽器運算，無雲端幾何後台）

## 目標

在不改變 ShapeCut 現有製作幾何、官方三爪孔、六種輸出及視覺樣式的前提下，把重型 STL 的主要切片熱點移入 Rust WebAssembly，並以 2 至 4 個獨立 Web Workers 平行處理互不依賴的 Z 層。第一階段正式目標為 Knight Fortress 端到端中位數至少加速 2 倍、峰值可歸因記憶體降低至少 30%，同時保持 canonical geometry 一致及 fail-closed。

## 不變條件

- GitHub Pages 繼續提供學生前台；STL 不上載、不進 service worker cache、不離開用戶裝置。
- 不加入 Render、Neon、WebSocket 或其他後端依賴。
- 不修改字體、大小、字型、顏色、版面或既有操作流程。
- 官方三爪孔維持頂部兩層、固定 Knight Fortress 樣板、配合微調、外框擴大上限、結構衝突封鎖及跨格式一致性。
- preview、SVG、DXF、PDF、ZIP及launcher-fit coupon必須源自同一 canonical result。
- Rust/WASM只取代有明確contract及差異測試的幾何熱點；TypeScript仍負責工作流程、材料驗證、三爪孔、canonical merge、artifact生成及安全訊息。
- 沒有WASM或裝置資源不足時必須使用受測的單worker TypeScript相容路徑，不得產生不同幾何決定。
- 所有新數值輸入拒絕NaN、Infinity、越界索引、非三角形indices、過大allocation及不安全整數。

## 已觀察基線

在隔離工作樹的初次serial基線中，型別檢查通過；Node suite為65/68檔、1665通過、4跳過、12失敗。5項失敗源自工作樹內vite-node可執行檔缺失，7項為重型pipeline超過既有5秒測試timeout。此狀態不能稱為clean baseline。實作第一項必須先修復可重現依賴contract，將重型測試改用有證據的檔案級timeout而非放寬production deadline，並記錄未修改演算法的fresh基準。

## 架構

```text
React / OneClickConverter
  └─ GeometryClient
       └─ Orchestrator Worker
            ├─ validated STL / mesh ownership
            ├─ device capability policy
            ├─ deterministic layer partitioner
            ├─ 1–4 Slice Workers
            │    └─ Rust WASM batch slice kernel
            └─ canonical TypeScript reducer
                 ├─ contour topology and validation
                 ├─ feature/depth evidence
                 ├─ official three-prong plan
                 └─ package/preview/artifacts
```

GitHub Pages不能依賴自訂COOP/COEP response headers，因此第一階段不使用SharedArrayBuffer或shared WebAssembly memory。每個worker只取得其分區所需的typed arrays，透過transferable ArrayBuffer移交ownership；不得把完整mesh無條件複製到每個worker。

## Rust WASM 核心邊界

Rust crate只提供純函式、無檔案系統、無網絡、無隨機數：

```text
slice_layer_batch(
  positions: Float32Array,
  indices: Uint32Array,
  planes: Float64Array,
  deadline_check_interval: u32
) -> SliceBatchResult
```

輸出為規範化typed arrays：每個plane的segment offset、segment endpoints、退化／共面／非有限統計及狀態碼。Rust不得決定材料、三爪孔、裝飾省略、輪廓角色、警告文字或artifact內容。

結果順序固定為plane index、triangle index、edge index；canonical reducer在形成輪廓前再排序及驗證，確保worker完成順序不影響輸出。

WASM 公開邊界接收未經 JavaScript 數值轉型的 `deadline_check_interval`，只接受有限、安全、正整數且不大於 4,096，然後才轉為 `u32`。同一個 strict boolean deadline hook 必須在輸入 allocation 前、每段最多 4,096 items 的 reserve/resize/copy、有限值與 index validation、triangle degeneracy prepass、獨立 plane traversal 及後續大型工作中 fail closed。Rust 輸入 buffer 只先 reserve capacity；不可在 checkpoint 前一次過 resize 或清零完整 maximum buffer，每個 chunk 必須先 checkpoint，才 resize/初始化該 chunk 並複製。

Rust pointer/length 結果只可進入唯一受控 JavaScript wrapper。Wrapper 必須同步驗證 view bounds，複製為 owned typed arrays，並在 `finally` 恰好釋放 raw result；raw views 不得跨越該邊界。JavaScript `TypedArray(length)` 會同步初始化整段連續記憶體，因此唯一允許的 bounded allocator primitive 必須硬性限制每次 allocation 不超過 8 MiB，並在該 primitive 緊接之前及之後各執行一次同一 strict checkpoint。除此以外，所有 output copy 及 validation 仍須以最多 4,096 items 分段；不得擴大 8 MiB cap。

## Worker與裝置策略

- `hardwareConcurrency <= 2`：1個slice worker。
- `hardwareConcurrency 3–5`：2個slice workers。
- `hardwareConcurrency >= 6`：最多4個slice workers。
- 任何時候只允許一個conversion job；新工作先終止全部舊workers。
- worker建立、WASM載入或batch執行失敗時，整個平行嘗試終止；只有在尚未發布任何canonical結果時才可從頭使用TypeScript相容路徑。
- 取消後1秒內所有slice workers終止，遲到訊息不得更新UI。
- 分區器以估算byte成本和triangle-plane overlap平衡工作，不只按層數平均分配。

## 記憶體策略

- STL bytes只保留一份供同一轉換需要；解析後不建立無必要的Float64 mesh副本。
- 預覽mesh使用受界限的簡化副本，不保留完整第二份mesh。
- 分區輸入在transfer後由orchestrator放棄ownership，完成後立即釋放worker與WASM linear memory。
- PDF、ZIP及其他artifact沿既有順序生成；每項完成後釋放中間buffer。
- 量測只記錄byte數、triangle數、layer數、stage時間及估算live bytes，不記錄STL內容、檔名或幾何hash。

## 幾何品質與失敗策略

同一輸入在TypeScript及WASM路徑必須具有：

- 相同axis、layer schedule及layer order；
- 相同輪廓數、孔洞角色、bounds及面積（容差不超過既有canonical tolerance）；
- 相同launcher template version/fingerprint、rotation、fit offset及exterior expansion decision；
- 相同protected-cut／decoration omission決定；
- 所有artifact通過既有reconciliation及mutation tests。

WASM遇到退化、共面、開放或非manifold資料時只回傳證據；最終success、warning或fail仍由現有TypeScript規則決定。任何差異超出容差均fail closed並停用該次WASM結果。

## 效能驗收

量測環境固定為同一部Apple Silicon Mac及同一Chromium major version，先預熱一次，再各執行5次並比較中位數：

- Knight Fortress A及B：端到端中位數至少2倍加速，或兩者均不高於15秒。
- 200k、500k及1M triangles合成模型：主線程不得出現100ms以上long task；1M模型須在120秒安全邊界內完成或回傳typed resource failure。
- 峰值可歸因live bytes比基線降低至少30%。
- worker取消後1秒內active worker為0。
- 若任何canonical差異、browser crash或記憶體回歸，WASM路徑不得成為預設。
- 若2倍目標未達但幾何完全一致，只能報告實測數字，不能宣稱階段完成。

## 完成定義

Rust unit tests、wasm boundary tests、Node differential tests、Chromium worker tests、兩個Knight reference、合成大型模型、artifact reconciliation、取消／替換、typecheck、production build及GitHub Pages bundle inspection全部通過；production bundle包含受hash的WASM資產，不含絕對路徑、source map或模型資料。只有取得上述fresh evidence及獨立review批准，才可稱A3完成。
