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
  PostgresRunStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import { createToolGatewayComposition } from '@ontology/app-api'
import {
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  RestrictedAnswerPublisher,
  RestrictedAnswerVerifier,
  RestrictedDraftWriter,
  RunPhaseDriver,
  RunService,
  StaticInputValidity,
  WorkflowController,
  createRunCheckpointPort,
} from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import type {
  GenerationPort,
  PlanSpec,
  ProfileRef,
  RunStore,
  RuntimeAdapter,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
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
  SCOPE,
  ScriptedGeneration,
  completedEvent,
  events,
  forbiddenDecision,
  piConfig,
  toolCallDelta,
} from '../unit/pi-runtime-fixtures'
import {
  StaticPlanResolver,
  forbiddenGeneration,
  publishedPlan,
  runtimeManifest,
  templateContext,
} from '../unit/template-runtime-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PI_RUN = '11111111-aaaa-4aaa-8aaa-111111111111'
const TEMPLATE_RUN = '22222222-bbbb-4bbb-8bbb-222222222222'
const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-09-21T00:00:00Z'

const PI_PROFILE: ProfileRef = { id: 'home-energy-pi-demo', version: '1.0.0' }
const TEMPLATE_PROFILE: ProfileRef = { id: 'home-energy-template-demo', version: '1.0.0' }
const PI_RUNTIME: VersionRef = { id: 'runtime-pi', version: '1.0.0', digest: DIGEST }
const TEMPLATE_RUNTIME: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }

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
        { kind: 'definition', ref: { id: 'backup', version: '1.0.0', digest: DIGEST }, label: 'backup' },
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

/** A published template plan: a lookup, then a document search bound from its output. */
function integrationPlan(): PlanSpec {
  return {
    planRef: { id: 'plan-integration', version: '1.0.0', digest: sha256DigestOf('plan-integration'), kind: 'plan' },
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
          { name: 'allowedCollectionRefs', required: true, source: { kind: 'literal', value: ['home-energy/manuals'] } },
          { name: 'mode', required: true, source: { kind: 'literal', value: 'keyword' } },
        ],
        dependsOn: ['lookup'],
        failureBehaviour: 'abort',
      },
    ],
  }
}

class FakeBinder implements RunProfileBinder {
  bindProfileForRun(profileRef: ProfileRef): Promise<RunProfileBinding> {
    const runtimeRef = profileRef.id === PI_PROFILE.id ? PI_RUNTIME : TEMPLATE_RUNTIME
    return Promise.resolve({
      profileRef,
      resolvedProfileHash: DIGEST,
      resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash: DIGEST },
      runtimeRef,
    })
  }
}

class Selector implements RuntimeSelectorPort {
  readonly selected: string[] = []
  constructor(private readonly adapters: ReadonlyMap<string, RuntimeAdapter>) {}
  select(runtimeRef: VersionRef): Promise<RuntimeAdapter> {
    this.selected.push(runtimeRef.id)
    const adapter = this.adapters.get(runtimeRef.id)
    if (adapter === undefined) throw new Error(`no runtime adapter for ${runtimeRef.id}`)
    return Promise.resolve(adapter)
  }
}

class Capabilities implements RuntimeCapabilityFactoryPort {
  constructor(
    private readonly composition: ReturnType<typeof createToolGatewayComposition>,
    private readonly checkpoints: RuntimeCapabilitySet['checkpoints'],
    private readonly generationByRun: ReadonlyMap<Uuid, GenerationPort>,
  ) {}
  forRun(context: {
    readonly runId: Uuid
    readonly budgetLedgerId: Uuid
  }): Promise<RuntimeCapabilitySet> {
    const binding: RunToolBinding = {
      runId: context.runId,
      ledgerId: context.budgetLedgerId,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    }
    return Promise.resolve({
      gateway: this.composition.forRun(binding),
      generation: this.generationByRun.get(context.runId) ?? forbiddenGeneration,
      decision: forbiddenDecision,
      checkpoints: this.checkpoints,
    })
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let store: RunStore
let budget: BudgetService
let evidenceStore: PostgresEvidenceStore
let lookup: RecordingHandler
let search: RecordingHandler
let controller: WorkflowController
let selector: Selector

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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'workflow-tenant') ON CONFLICT DO NOTHING`,
    [TENANT_ID],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'workflow-space') ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID],
  )
  // Seed the immutable resolved-profile rows the run store's composite FK requires. The
  // profile resolver's own behaviour is covered by run-events-api.spec.ts; this suite
  // exercises the workflow controller, so the manifest only needs to exist.
  for (const profileRef of [PI_PROFILE, TEMPLATE_PROFILE]) {
    await adminClient.query(
      `INSERT INTO agent_platform.profile_versions
         (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'workflow-seed')
       ON CONFLICT DO NOTHING`,
      [TENANT_ID, SPACE_ID, profileRef.id, profileRef.version, DIGEST],
    )
    await adminClient.query(
      `INSERT INTO agent_platform.resolved_profiles
         (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
          resolved_profile, checked_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
       ON CONFLICT DO NOTHING`,
      [TENANT_ID, SPACE_ID, profileRef.id, profileRef.version, DIGEST],
    )
  }

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'workflow-controller-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  store = new PostgresRunStore(controlDatabase)
  const control = new ControlPostgresRepository(controlDatabase)
  budget = new BudgetService({ store: new PostgresBudgetLedgerStore(controlDatabase), control })
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

  const piGeneration = new ScriptedGeneration(
    [
      events(toolCallDelta('call-1', 'ontology_lookup', { scopeRef: SCOPE, intent: 'definitions' }), completedEvent('tool_calls')),
      events(
        toolCallDelta('call-2', 'document_search', {
          query: 'backup',
          allowedCollectionRefs: ['home-energy/manuals'],
          mode: 'keyword',
        }),
        completedEvent('tool_calls'),
      ),
      events(completedEvent('stop')),
    ],
    { signal: new AbortController().signal },
  )

  const piAdapter = new PiRuntimeAdapter(piConfig())
  const templateAdapter = new TemplateRuntimeAdapter({
    manifest: runtimeManifest(),
    plans: new StaticPlanResolver(publishedPlan(integrationPlan())),
  })
  const adapters = new Map<string, RuntimeAdapter>([
    ['runtime-pi', piAdapter],
    ['runtime-template', templateAdapter],
  ])
  selector = new Selector(adapters)

  const runs = new RunService({ store, control, profiles: new FakeBinder() })
  const phase = new RunPhaseDriver({ store, control })
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const capabilities = new Capabilities(composition, createRunCheckpointPort(store), new Map([[PI_RUN, piGeneration]]))
  controller = new WorkflowController({
    runs,
    phase,
    budget,
    manifests,
    runtimes: selector,
    capabilities,
    draftWriter: new RestrictedDraftWriter(),
    verifier: new RestrictedAnswerVerifier(),
    verifications,
    publisher: new RestrictedAnswerPublisher({ store, verifications }),
    validity: new StaticInputValidity(),
  })
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

async function runEventTypes(runId: Uuid): Promise<string[]> {
  const result = await adminClient.query<{ sse_type: string }>(
    `SELECT sse_type FROM agent_platform.run_events
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 ORDER BY sequence`,
    [TENANT_ID, SPACE_ID, runId],
  )
  return result.rows.map((row) => row.sse_type)
}

async function ledgerConsumed(ledgerId: Uuid): Promise<number | undefined> {
  const result = await adminClient.query<{ tool_calls_consumed: number }>(
    `SELECT tool_calls_consumed FROM agent_platform.budget_ledgers
      WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
    [TENANT_ID, SPACE_ID, ledgerId],
  )
  return result.rows[0]?.tool_calls_consumed
}

async function lifecycle(runId: Uuid, profileRef: ProfileRef, ctx: ToolContext): Promise<Uuid> {
  const view = await controller.startRun(
    {
      runId,
      profileRef,
      question: 'compare tomorrow backup strategies',
      context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
      preferences: { route: 'auto', allowWeb: false },
      idempotencyKey: `workflow-${runId}`,
    },
    ctx,
  )
  expect(view.state).toBe('published')
  expect(view.answer?.runId).toBe(runId)
  expect(await controller.getAnswer(runId, ctx)).toBeDefined()

  const records = await evidenceStore.listByRun(SCOPE, runId, ctx)
  expect(records).toHaveLength(2)
  for (const record of records) {
    const blobRef = record.envelope.payloadRef
    if (blobRef === undefined) throw new Error('evidence carried no payloadRef')
    const authorized = await blobStore.getAuthorized({ scopeRef: SCOPE, blobRef }, ctx)
    expect(authorized.integrityVerified).toBe(true)
  }

  expect(await ledgerConsumed(view.budgetLedgerId)).toBe(2)
  const events = await runEventTypes(runId)
  expect(events[events.length - 1]).toBe('answer.published')
  return view.budgetLedgerId
}

describe('WorkflowController against a real containerised PostgreSQL + tool gateway', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      process.stdout.write(
        `[workflow-controller] image=${container.image} container=${container.containerName}\n`,
      )
    }
  })

  it('drives a full lifecycle with the Pi runtime through the real gateway', async () => {
    const ctx = templateContext({ runId: PI_RUN })
    await lifecycle(PI_RUN, PI_PROFILE, ctx)
    expect(lookup.calls.length).toBeGreaterThanOrEqual(1)
    expect(search.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('drives a full lifecycle with the Template runtime through the real gateway', async () => {
    const ctx = templateContext({ runId: TEMPLATE_RUN })
    await lifecycle(TEMPLATE_RUN, TEMPLATE_PROFILE, ctx)
  })

  it('selected exactly one runtime per run and never opened a second ledger', () => {
    expect(selector.selected).toEqual(['runtime-pi', 'runtime-template'])
    expect([...new Set(selector.selected)]).toHaveLength(2)
  })
})
