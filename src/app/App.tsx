const steps = [
  '匯入與修復',
  '軸心與尺寸',
  '自動拆件',
  '紋理與材料',
  '排版與輸出',
]

export function App() {
  return (
    <main>
      <h1>陀螺 Laser Kit</h1>
      <ol>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </main>
  )
}
