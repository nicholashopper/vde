import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the packaged main process via Playwright's Electron
 * support. They require a build first (`pnpm build`), which the global setup
 * does not do for you — running them against a stale `out/` is a worse failure
 * mode than an explicit missing-build error.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
