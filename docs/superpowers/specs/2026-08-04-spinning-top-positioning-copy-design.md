# ShapeCut 3D 陀螺定位文案設計

## 目標

消除「一般 3D 模型轉換工具」的含糊印象，讓使用者在工具首頁、瀏覽器／搜尋結果、安裝資訊、README 及 GitHub repository 首頁都能立即理解：ShapeCut 專門把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案。

## 核心定位

採用不涉及品牌的用語「3D 陀螺 STL 模型」，不把工具限定為 Beyblade 或戰鬥陀螺。

主要標題：

> 把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片

主要說明：

> 放入 3D 陀螺 STL 模型，ShapeCut 會自動分析、簡化和分層切片，並準備可供 Laser Cut 使用的平面外形與製作檔案。

GitHub repository 簡介：

> 把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。

## 修改範圍

1. 首頁上載畫面的主標題與說明改用上述定位。
2. README 首段以相同語意介紹工具，並保留「檔案只在本機處理」的私隱說明。
3. `index.html` 的頁面標題改為 `ShapeCut｜3D 陀螺模型轉 Laser Cut 切片`，並新增搜尋引擎 description。
4. Web App Manifest 的 description 改為明確的 3D 陀螺定位。
5. GitHub `YuenHK/ShapeCut` repository description 改用上述簡介。

不修改轉換流程、幾何演算法、支援格式、三爪結構、安全規則或其他功能。

## 一致性及可存取性

- 首頁仍只有一個 `h1`，內容直接描述輸入、處理與輸出。
- 所有介面均使用「3D 陀螺 STL 模型」及「Laser Cut 平面切片」兩個核心詞組。
- 不宣稱輸出已包含雷射功率、速度或機器認證；現有安全提示維持不變。
- 中文文案保持繁體中文；`STL`、`Laser Cut` 保留常見英文技術名稱。

## 驗收

- 單元／瀏覽器測試更新為核對新的首頁標題及文案。
- `npm run typecheck`、相關測試及 `SHAPECUT_BASE_PATH=/ShapeCut/ npm run build` 通過。
- production HTML 包含新的 title、meta description 及 `/ShapeCut/` base path。
- 公開部署後首頁、manifest、README 與 GitHub repository description 的定位一致。
- `shapecut-outline.zip` 與 `shapecut-outline/` 繼續保持未追蹤及不上傳。
