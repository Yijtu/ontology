import { defineConfig } from 'vitest/config'

// Container-backed integration suites start a real PostgreSQL container (and some a
// stdio server or an HTTP fixture). Under a loaded machine the wait for the container
// to become ready easily exceeds the 5s default, which is what made `pnpm run verify`
// intermittently red. Give the whole project one explicit, generous budget instead of
// sprinkling magic numbers through individual tests.
const INTEGRATION_TEST_TIMEOUT_MS = 120_000
const INTEGRATION_HOOK_TIMEOUT_MS = 300_000

// The architecture suite parses every workspace source file. It is CPU/IO heavy but
// has no container dependency, so it only needs a larger per-test budget.
const ARCHITECTURE_TEST_TIMEOUT_MS = 60_000

// Container-backed suites contend for the Docker daemon, host ports and child
// processes. At the machine's default file parallelism they fight each other (and the
// other worktrees sharing the host), which is what produced the intermittent timeouts.
// Cap the integration project's workers and give it its own sequence group so the
// unit/contracts/architecture projects keep running at full parallelism.
const INTEGRATION_MAX_WORKERS = 4
const INTEGRATION_GROUP_ORDER = 1

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'tests/unit/**/*.spec.ts',
            'tests/contracts/**/*.spec.ts',
            'tests/ui/**/*.spec.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'architecture',
          include: ['tests/architecture/**/*.spec.ts'],
          testTimeout: ARCHITECTURE_TEST_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.spec.ts'],
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
          maxWorkers: INTEGRATION_MAX_WORKERS,
          sequence: { groupOrder: INTEGRATION_GROUP_ORDER },
        },
      },
    ],
  },
})
