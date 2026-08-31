import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const base = process.env.SHAPECUT_BASE_PATH ?? '/'
const geometryWasmPath = new URL('./src/wasm/generated/geometry_wasm_bg.wasm', import.meta.url)

function ensureGeometryWasmAsset(): Plugin {
  return {
    name: 'ensure-geometry-wasm-asset',
    generateBundle(_options, bundle) {
      const wasmAssets = Object.values(bundle)
        .filter((entry) => entry.fileName.endsWith('.wasm'))
      if (wasmAssets.length > 1) {
        throw new Error(`Expected one geometry WASM asset, received ${wasmAssets.length}`)
      }
      const source = wasmAssets.length === 0
        ? readFileSync(geometryWasmPath)
        : (() => {
            const asset = wasmAssets[0]
            if (!('source' in asset)) throw new Error('Geometry WASM bundle entry is not an asset')
            return Buffer.from(asset.source)
          })()
      for (const forbidden of ['/Users/', '/private/', 'sourceMappingURL=']) {
        if (source.includes(Buffer.from(forbidden))) {
          throw new Error(`Geometry WASM asset contains forbidden build material: ${forbidden}`)
        }
      }
      if (wasmAssets.length === 0) {
        this.emitFile({
          type: 'asset',
          name: 'geometry_wasm_bg.wasm',
          source,
        })
      }
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), ensureGeometryWasmAsset()],
  assetsInclude: ['**/*.wasm'],
  build: {
    assetsInlineLimit: 0,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 530,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'geometry'
          if (id.includes('/node_modules/pdf-lib/')) return 'pdf'
          if (id.includes('/node_modules/jszip/')) return 'archive'
          if (id.includes('/node_modules/dexie/')) return 'storage'
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/zustand/')) return 'react'
        },
      },
    },
  },
})
