# ShapeCut

ShapeCut 是一個在瀏覽器內將 STL 轉成通用 Laser Cut 外形切片的一鍵工具。檔案只在本機處理，不會上載到伺服器。

## 開始使用

需要 Node.js 20 或以上版本。

```bash
npm install
npm run dev
```

開啟頁面後，只需拖放 STL 或按「選擇模型」。選擇檔案會立即開始完整流程：

- 「成功」：安全模型已用精確切片完成。
- 「需注意」：已自動使用 2.5D 外形簡化，內部、孔洞及較小分離零件已移除。
- 「失敗」：檔案無法讀取、沒有有效外形，或超出時間／資源上限；可立即選擇另一個檔案。

成功或需注意時，可下載已對齊同一組外形及來源 fingerprint 的 ZIP、SVG、DXF、PDF 及 JSON。輸出是以 mm 為單位的「CUT」外輪廓，不包含材料厚度、卡榫、功率、速度或 passes。

## 開發與驗證

```bash
npm test
npm run test:browser
npm run test:e2e
npm run validate:fixtures
npm run test:performance
npm run typecheck
npm run build
```

Production build 位於 `dist/`。應用包含 Web App Manifest 與只快取同源靜態 shell 的 service worker；使用者選取的 STL 不會進入離線 cache。

## 安全與限制

- 2.5D 是可驗證的外形近似，不是已修復的封閉 3D 實體。
- 每層只保留最大外輪廓；孔洞、內部細節和較小斷開零件會被忽略。
- 實際堆疊高度取決於使用者的材料厚度，不會自動等於模型原高度。
- 工具不提供或認證雷射功率與速度；正式製作前必須根據機器及已確認材料進行少量試切。

更完整的操作要求見 [材料與雷射安全](docs/materials/safety.md)。
