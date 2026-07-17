import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    exclude: ['**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
