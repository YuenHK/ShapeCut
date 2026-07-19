import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
