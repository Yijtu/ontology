import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createToolGatewayComposition } from '@ontology/app-api'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import type {
  BudgetPort,
  PlanSpec,
  RuntimeDependencies,
  RuntimeEvent,
  ScopeRef,
  ToolContext,
  ToolGateway,
} from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import type { RunToolBinding } from '@ontology/tool-services'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import {
  RecordingHandler,
  canonicalToolValidator,
  fullProfile,
  observation,
  operationRegistry,
} from '../unit/tool-gateway-fixtures'
import {
  InMemoryCheckpoints,
  RUN_ID,
  SCOPE,
  StaticPlanResolver,
  forbiddenDecision,
  forbiddenGeneration,
  publishedPlan,
  runtimeInput,
  runtimeManifest,
  templateContext,
} from '../unit/template-runtime-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEDGER_ID = '88888888-8888-4888-8888-888888888888'
const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-09-21T00:00:00Z'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function lookupHandler(): RecordingHandler {
  return new RecordingHandler('ontology_lookup', {
    payload: {
      items: [
        {
          kind: 'definition',
          ref: { id: 'backup', version: '1.0.0', digest: DIGEST },
          label: 'backup',
        },
      ],
      gaps: [],
      definitionVersion: { id: 'home-energy-definitions', version: '0.1.0', digest: DIGEST },
      autoPublished: false,
    },
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
  })
}

function searchHandler(): RecordingHandler {
  return new RecordingHandler('document_search', {
    payload: {
      spans: [],
      scoreKind: 'bm25',
      indexVersion: {
        indexRef: { id: 'home-energy-index', version: '1.0.0', digest: DIGEST },
        generation: 1,
        builtAt: NOW,
      },
      completeness: 'complete',
    },
    status: 'empty',
    coverage: { returned: 0, truncated: false },
    sources: [observation()],
  })
}

/** A real published plan: a lookup, then a document search whose query comes from it. */
function integrationPlan(): PlanSpec {
  return {
    planRef: {
      id: 'plan-integration',
      version: '1.0.0',
      digest: sha256DigestOf('plan-integration'),
      kind: 'plan',
    },
    steps: [
      {
        stepId: 'lookup',
        toolId: 'ontology_lookup',
        readOnly: true,
        args: [
          { name: 'scopeRef', required: true, source: { kind: 'literal', value: SCOPE } },
          { name: 'intent', required: true, source: { kind: 'literal', value: 'definitions' } },
        ],
        dependsOn: [],
        failureBehaviour: 'abort',
      },
      {
        stepId: 'search',
        toolId: 'document_search',
        readOnly: true,
        args: [
          {
            name: 'query',
            required: true,
            source: { kind: 'predecessor', stepId: 'lookup', pointer: '/items/0/label' },
          },
          {
            name: 'allowedCollectionRefs',
            required: true,
            source: { kind: 'literal', value: ['home-energy/manuals'] },
          },
          { name: 'mode', required: true, source: { kind: 'literal', value: 'keyword' } },
        ],
        dependsOn: ['lookup'],
        failureBehaviour: 'abort',
      },
    ],
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let budget: BudgetService
let evidenceStore: PostgresEvidenceStore
let gateway: ToolGateway
let lookup: RecordingHandler
let search: RecordingHandler

function binding(): RunToolBinding {
  return {
    runId: RUN_ID,
    ledgerId: LEDGER_ID,
    resolvedProfile: fullProfile(),
    operations: operationRegistry(),
  }
}

function runtimeDependencies(ctx: ToolContext): RuntimeDependencies {
  const runtimeBudget: BudgetPort = {
    reserve: () => Promise.reject(new Error('the runtime must not reserve budget directly')),
    settle: () => Promise.reject(new Error('the runtime must not settle budget directly')),
    remaining: async () => (await budget.remaining(LEDGER_ID, ctx)).remaining,
  }
  return {
    ctx,
    gateway,
    generation: forbiddenGeneration,
    decision: forbiddenDecision,
    checkpoints: new InMemoryCheckpoints(),
    budget: runtimeBudget,
    signal: new AbortController().signal,
  }
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'template-tenant') ON CONFLICT DO NOTHING`,
    [TENANT_ID],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'template-space') ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'template-runtime-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)
  lookup = lookupHandler()
  search = searchHandler()

  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [lookup, search],
  })
  gateway = composition.forRun(binding())
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('template runtime against a real containerised PostgreSQL + tool gateway + blob-local', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string; current_database: string }>(
      'SELECT version() AS version, current_database() AS current_database',
    )
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      expect(container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[template-runtime] image=${container.image} container=${container.containerName} database=${result.rows[0]?.current_database ?? ''}\n`,
      )
    }
  })

  it('executes the plan through the gateway, binds from the real predecessor output and archives evidence', async () => {
    const ctx = templateContext({ runId: RUN_ID })
    await budget.openLedger(
      { ledgerId: LEDGER_ID, kind: 'run', runId: RUN_ID, overrideLimits: { maxRows: 1000 } },
      ctx,
    )

    const plan = integrationPlan()
    const adapter = new TemplateRuntimeAdapter({
      manifest: runtimeManifest(),
      plans: new StaticPlanResolver(publishedPlan(plan)),
    })

    const events: RuntimeEvent[] = []
    for await (const event of adapter.start(
      runtimeInput({ runId: RUN_ID, planRef: plan.planRef }),
      runtimeDependencies(ctx),
    )) {
      events.push(event)
    }

    // Both real tool calls happened, in dependency order.
    expect(lookup.calls).toHaveLength(1)
    expect(search.calls).toHaveLength(1)
    // The second call's query is bound from the first call's real archived output.
    expect(search.calls[0]?.arguments.query).toBe('backup')
    expect(search.calls[0]?.arguments.allowedCollectionRefs).toEqual(['home-energy/manuals'])
    expect(events.map((event) => event.type)).toContain('plan_proposed')
    expect(events.filter((event) => event.type === 'step_started')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'evidence_added')).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('collection_complete')

    // Evidence is durably archived in the control database, in scope.
    const records = await evidenceStore.listByRun(SCOPE as ScopeRef, RUN_ID, ctx)
    expect(records).toHaveLength(2)

    // Each evidence payload is a real immutable blob whose integrity verifies.
    for (const record of records) {
      const blobRef = record.envelope.payloadRef
      if (blobRef === undefined) throw new Error('evidence carried no payloadRef')
      const authorized = await blobStore.getAuthorized({ scopeRef: SCOPE as ScopeRef, blobRef }, ctx)
      expect(authorized.integrityVerified).toBe(true)
    }

    // The shared budget ledger consumed exactly two calls and settled them.
    const ledger = await adminClient.query<{ tool_calls_consumed: number }>(
      `SELECT tool_calls_consumed FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_ID, SPACE_ID, LEDGER_ID],
    )
    expect(ledger.rows[0]?.tool_calls_consumed).toBe(2)
    const reservations = await adminClient.query<{ status: string }>(
      `SELECT status FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [TENANT_ID, SPACE_ID, LEDGER_ID],
    )
    expect(reservations.rows.map((row) => row.status)).toEqual(['settled', 'settled'])
  })

  it('returns a typed clarification through the real gateway when a required argument is missing', async () => {
    const ctx = templateContext({ runId: RUN_ID })
    const plan: PlanSpec = {
      planRef: {
        id: 'plan-clarify',
        version: '1.0.0',
        digest: sha256DigestOf('plan-clarify'),
        kind: 'plan',
      },
      steps: [
        {
          stepId: 'lookup',
          toolId: 'ontology_lookup',
          readOnly: true,
          args: [
            { name: 'scopeRef', required: true, source: { kind: 'literal', value: SCOPE } },
            { name: 'intent', required: true, source: { kind: 'literal', value: 'definitions' } },
            { name: 'siteRef', required: true },
          ],
          dependsOn: [],
          failureBehaviour: 'abort',
        },
      ],
    }
    const adapter = new TemplateRuntimeAdapter({
      manifest: runtimeManifest(),
      plans: new StaticPlanResolver(publishedPlan(plan)),
    })
    const before = lookup.calls.length
    const events: RuntimeEvent[] = []
    for await (const event of adapter.start(
      runtimeInput({ runId: RUN_ID, planRef: plan.planRef }),
      runtimeDependencies(ctx),
    )) {
      events.push(event)
    }

    expect(lookup.calls.length).toBe(before)
    expect(events.filter((event) => event.type === 'clarification_requested')).toHaveLength(1)
    expect(events.some((event) => event.type === 'collection_complete')).toBe(false)
  })
})
