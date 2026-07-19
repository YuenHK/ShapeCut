import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
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
