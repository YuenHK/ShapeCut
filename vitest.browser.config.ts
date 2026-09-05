import react from '@vitejs/plugin-react'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['comlink', 'dexie', 'jszip', 'pdf-lib', 'three', 'three/examples/jsm/controls/OrbitControls.js', 'zustand', 'zustand/vanilla'] },
  test: {
    testTimeout: 15_000,
    include: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    browser: {
      enabled: true,
      provider: playwright({
        contextOptions: { permissions: ['clipboard-read', 'clipboard-write'] },
      }),
      instances: [{
        browser: 'chromium',
      }],
      headless: true,
    },
  },
})
