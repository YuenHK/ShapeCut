# ShapeCut GitHub Pages 公開部署設計

**日期：** 2026-08-04
**狀態：** 待使用者批准書面規格

## 目標

把現有 ShapeCut Vite 網頁工具放到公開 GitHub repository `ShapeCut`，使用 GitHub Actions 自動部署至 GitHub Pages。公開網站使用 GitHub Pages 預設專案網址：

`https://yuenhk.github.io/ShapeCut/`

同時公開兩個已獲授權分享的 STL 範例，讓使用者可從網站下載並測試 ShapeCut 工作流程。

## Repository 與部署架構

- repository 名稱固定為 `ShapeCut`，可見性為 public。
- repository owner 固定為 GitHub 帳戶 `YuenHK`；GitHub Pages 網址使用 GitHub 的大小寫不敏感 hostname `yuenhk.github.io`。
- `main` 是 GitHub Pages 的唯一部署來源。
- GitHub Actions 在每次推送 `main` 時執行：
  1. checkout repository；
  2. 設定 Node.js LTS 與 npm cache；
  3. 執行 `npm ci`；
  4. 執行 `npm run typecheck`；
  5. 執行 `npm run build`；
  6. 上傳 `dist/` Pages artifact；
  7. 部署至 GitHub Pages environment。
- 不提交 `dist/` 或建立 `gh-pages` 分支。
- workflow 使用 GitHub 官方 Pages Actions，權限只限讀取 repository 內容、寫入 Pages 及取得部署 identity token。

## Vite base path

- production build 的 base path 固定為 `/ShapeCut/`，確保 JS、CSS、Web Worker 與公開範例在 project Pages 子路徑正確載入。
- 本機 `npm run dev` 保持根路徑 `/`，不改變現有本機使用方式。
- 所有公開範例連結以 Vite base path 組合，不硬編碼完整 GitHub 帳戶網址。

## 公開 STL 範例

使用者已確認擁有公開分享及提供下載的權利。檔案對應固定為：

- `Copy of Beyblade X Knight Fortress Group.stl` → `public/samples/sample1.stl`
- `Copy of Beyblade X Knight Fortress.stl` → `public/samples/sample2.stl`

兩個新檔名使用無空格的小寫格式，原始長檔名不會加入 Git 歷史。網站首頁選檔區加入「範例模型」區域，提供：

- 下載 sample1
- 下載 sample2

旁邊顯示簡短提示：範例只供測試 ShapeCut 工作流程，實際切割前仍須檢查尺寸、材料、刀縫與結構安全。下載連結不會自動開始處理；使用者下載後仍由現有本機選檔流程開啟 STL。

## 私隱與資料流

- STL 轉換繼續完全在使用者瀏覽器本機執行。
- GitHub Pages 不接收或儲存使用者上載的 STL。
- IndexedDB／本機儲存行為維持現狀。
- 網站不加入分析、追蹤、登入、後端 API 或第三方上載服務。

## 不納入公開 repository 的檔案

以下現有未追蹤輸出不會被加入 Git：

- `shapecut-outline.zip`
- `shapecut-outline/`

除上述兩個已改名的 STL 範例外，不會批量加入其他未追蹤檔案。

## 失敗處理

- typecheck 或 build 失敗時，workflow 必須停止，不能部署損壞 artifact。
- 新部署失敗時，上一個成功 Pages 版本保持可用。
- 若 repository 名稱、帳戶或 Pages base path 不一致，部署前停止並修正設定，不能以猜測網址交付。
- 若 GitHub 尚未登入，建立 repository 前讓使用者在 GitHub 網頁完成登入；不要求使用者在對話中提供密碼或 token。

## 驗證與驗收

本機／提交前：

- `npm run typecheck` 退出碼 0。
- `npm run build` 退出碼 0。
- build 後 `dist/` 內包含兩個 STL 範例。
- production HTML、JS、CSS、worker 及範例 URL 均以 `/ShapeCut/` 為 base。
- 相關 React／瀏覽器測試覆蓋兩個下載連結和 base path。
- `git diff --check` 無錯誤。
- Git staged scope 不包含原始長檔名 STL、ZIP 或輸出資料夾。

GitHub／部署後：

- public repository 名稱及 owner 與最終 Pages URL 一致。
- GitHub Actions workflow 成功完成。
- Pages 公開網址回傳成功並顯示 ShapeCut 首頁。
- `sample1.stl`、`sample2.stl` 可從頁面下載，檔案位元組與本機來源一致。
- 首頁選檔、中央 loading、Web Worker 及至少一個範例模型處理流程在公開網址正常。
- 瀏覽器 console 沒有 base path、worker、404 或跨來源錯誤。

## 完成標準

只有在 repository 已公開、Actions 部署成功、公開網址與兩個範例下載均經實際驗證後，才可宣稱託管任務完成。
