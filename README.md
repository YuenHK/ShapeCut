# 陀螺 Laser Kit

瀏覽器工具，將旋轉對稱 STL 分析成可雷射切割的零件、3–5 級雕刻區及製作文件。支援 plywood、實木、紙、cardboard、cork、經確認的 cast acrylic，以及自訂但未驗證的材料設定檔。

## 開發與測試

需要 Node.js 20 或以上版本。

```bash
npm install
npm run dev
npm test
npm run test:browser
npm run test:e2e
npm run typecheck
npm run build
```

Production build 位於 `dist/`。應用包含 Web App Manifest 與只快取同源靜態 shell 的 service worker；專案資料留在 IndexedDB，使用者選取的 STL 不會上傳或加入離線 cache。

## 操作流程

1. 匯入 ASCII 或 binary STL（上限 128 MiB、500,000 triangles、300,000 unique vertices）。
2. 檢查封閉／non-manifold 網格並確認旋轉軸。
3. 編輯骨架數、環層數、軸徑及卡榫配合。
4. 選擇已校準材料及 3–5 級雕刻。
5. 通過加工前檢查後，下載包含 SVG、DXF、PDF、JSON 的 ZIP。

輸出以 mm 為單位，使用 `CUT`、`SCORE`、`ENGRAVE_1` 至 `ENGRAVE_5` 圖層。專案 JSON 保存 STL SHA-256，但預設不嵌入 STL；重開時必須重新選擇指紋相同的原檔。

## 安全警告

- 功率、速度及 passes 只可作起始建議；必須遵從機器及材料製造商指引。
- 禁止 PVC、vinyl、PTFE／Teflon、含鹵素材料、epoxy／phenolic resin、chromium-VI leather、carbon fibre 及身份不明塑膠。
- 必須使用合適抽氣、消防監察、正確焦點及清潔鏡片；切割期間不可無人看管。
- 軟件平衡結果只是假設密度一致的靜態估算。成品必須低速試轉、檢查結構及做實物平衡。
- 凹多邊形切縫補償在未接入經驗證 polygon kernel 前會 fail closed，不能強行匯出。

## 第一版限制

- 最適合單一主要旋轉軸的陀螺／旋轉體；高度非對稱或有複雜內腔的模型可能需要返回 CAD 修改。
- STL 本身沒有材質或紋理；雕刻只由表面高度差推算。
- 自動排版採決定性 first-fit-decreasing；不保證全球最省料。
- 材料批次、kerf、配合及雕刻效果必須以實體 calibration coupon 驗證。
