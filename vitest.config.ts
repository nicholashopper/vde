import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // The engine tests walk real git history; a few seconds is normal and a
    // 5s default would make them flaky rather than fast.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters: ['default']
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@analyzer': resolve('src/analyzer'),
      '@renderer': resolve('src/renderer')
    }
  }
})
