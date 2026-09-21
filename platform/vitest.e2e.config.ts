import { defineConfig } from 'vitest/config'

/**
 * Browser E2E configuration. It is intentionally separate from the default test run:
 * `pnpm run verify` must stay green without the Playwright browser binaries or a web build.
 * Run `pnpm run build:web && pnpm run test:e2e`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
