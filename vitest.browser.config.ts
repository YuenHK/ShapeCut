import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['comlink', 'dexie', 'jszip', 'three', 'three/examples/jsm/controls/OrbitControls.js', 'zustand', 'zustand/vanilla'] },
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      instances: [{
        browser: 'chromium',
        context: { permissions: ['clipboard-read', 'clipboard-write'] },
      }],
      headless: true,
    },
  },
})
