# Material and laser safety

## ShapeCut 2.5D 外形的意義

ShapeCut 的 `outline-2.5d` 結果是近似外形工作流程，不代表原 STL 已被修復為安全的封閉 3D 實體。每層以最大封閉外輪廓為基礎；只有符合尺寸、封閉、包含、間距及近軸規則的中央孔，以及有足夠可靠幾何證據的相對深淺特徵，才會保留。其他孔洞、內部細節、不可靠特徵及較小分離元件可能被省略。製作者必須逐層核對平面預覽及爆炸圖；警告代表需要人工檢查，不代表軟件已補回缺失幾何。

黑、紅、藍只表示切割與相對深淺角色，並不是實際雷射功率、速度或 passes。輸出不依賴材料厚度；因此實際堆疊高度會隨板材厚度改變，不會自動重建原始 3D 高度。所有機器設定必須在 ShapeCut 之外，依照確定的機器、材料、批次和實測厚度設定；每一種組合都必須先做少量、低風險試切。

Material profiles and process recipes in this application are starting points only. They are not certifications, universal machine settings, or permission to process a sheet. Use a profile only for the exact laser machine, identified material and batch, and measured thickness recorded in it.

Before any laser operation:

- Follow the laser manufacturer and the material manufacturer's current instructions, permitted-material list, power limits, focus procedure, ventilation/extraction requirements, fire precautions, cleaning and supervision rules.
- Never leave an operating laser unattended. Keep the required extinguishing equipment available and use the machine only under a qualified operator's supervision.
- Treat unknown coatings, glues, adhesives, laminates, fillers, pigments and other additives as unsafe until their complete composition and laser suitability are confirmed by reliable manufacturer evidence.
- Do not process PVC/vinyl, PVB, PTFE/Teflon, carbon fibre, beryllium oxide, chromium(VI) leather, halogen-containing materials, epoxy resin, phenolic resin, or another material prohibited by the machine or material manufacturer.
- Generate and physically cut the calibration coupon for this exact machine/material/batch/thickness combination. Begin with low-risk test cuts, verify focus and extraction, inspect the result, and record measured kerf, fit and engraving behaviour before marking the profile calibrated.

A filled date or checkbox cannot establish that an unidentified sheet is safe. Custom materials require reliable product identity and manufacturer laser-safety evidence; unknown composition remains blocked. Even an allowlisted category is only a conservative starting category, not blanket approval for every product or machine.

Official guidance checked on 2026-07-19:

- [Trotec: Unsuitable materials for laser processing](https://www.troteclaser.com/en-gb/resources/faqs/unsuitable-materials-for-laser-processing)
- [Trotec Q400 operating manual (PDF)](https://www.troteclaser.com/static/pdf/q-series/8060-Q400-operating-manual-EN.pdf)
- [Glowforge Performance Series safety guidance](https://support.glowforge.com/hc/en-us/articles/360033633314-safety-glowforge-performance-series)

These sources must be read together with the exact machine's current manual and the exact material manufacturer's current safety data. This application does not certify a material or replace ventilation, fire safety, focus checks, physical calibration, low-risk test cuts, or human supervision.
