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

// The contracts project shells out to the schema-generation script. Under a loaded
// machine (the integration suites are starting containers in parallel) that child
// process can exceed vitest's 5s default, which made `pnpm run verify` intermittently
// red. Give the unit/contracts project one explicit, generous budget too.
const UNIT_TEST_TIMEOUT_MS = 30_000

// Container-backed suites contend for the Docker daemon, host ports and child
// processes. At the machine's default file parallelism they fight each other (and the
// other worktrees sharing the host), which is what produced the intermittent timeouts.
// Cap the integration project's workers and give it its own sequence group so the
// unit/contracts/architecture projects keep running at full parallelism.
const INTEGRATION_MAX_WORKERS = 4
const INTEGRATION_GROUP_ORDER = 1

// The load/evaluation harness (LOCAL-050) starts its own PostgreSQL container, real stdio MCP
// children and a full workflow, and deliberately measures wall-clock latency under load. It
// runs in its own sequence group after the integration project so it never competes with the
// other container-backed suites for the Docker daemon, and it keeps a small worker count so a
// P95 is not distorted by the machine's own scheduling noise.
const LOAD_TEST_TIMEOUT_MS = 180_000
const LOAD_HOOK_TIMEOUT_MS = 300_000
const LOAD_MAX_WORKERS = 2
const LOAD_GROUP_ORDER = 2

// The cross-layer acceptance suite (LOCAL-054) starts its own PostgreSQL container, runs the
// real ingestion worker, the real workflow controller with both runtimes and the real HTTP
// host. It runs in its own sequence group after the load harness so the two container-backed
// suites never compete for the Docker daemon or the host's ports.
const ACCEPTANCE_TEST_TIMEOUT_MS = 180_000
const ACCEPTANCE_HOOK_TIMEOUT_MS = 300_000
const ACCEPTANCE_MAX_WORKERS = 2
const ACCEPTANCE_GROUP_ORDER = 3

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
          testTimeout: UNIT_TEST_TIMEOUT_MS,
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
          include: ['tests/integration/**/*.spec.ts', 'tests/composition/**/*.spec.ts'],
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
          maxWorkers: INTEGRATION_MAX_WORKERS,
          sequence: { groupOrder: INTEGRATION_GROUP_ORDER },
        },
      },
      {
        extends: true,
        test: {
          name: 'load',
          include: ['tests/load/**/*.spec.ts'],
          testTimeout: LOAD_TEST_TIMEOUT_MS,
          hookTimeout: LOAD_HOOK_TIMEOUT_MS,
          maxWorkers: LOAD_MAX_WORKERS,
          sequence: { groupOrder: LOAD_GROUP_ORDER },
        },
      },
      {
        extends: true,
        test: {
          name: 'acceptance',
          include: ['tests/e2e/acceptance/**/*.acceptance.spec.ts'],
          testTimeout: ACCEPTANCE_TEST_TIMEOUT_MS,
          hookTimeout: ACCEPTANCE_HOOK_TIMEOUT_MS,
          maxWorkers: ACCEPTANCE_MAX_WORKERS,
          sequence: { groupOrder: ACCEPTANCE_GROUP_ORDER },
        },
      },
    ],
  },
})
