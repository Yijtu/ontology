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
  PostgresAnswerStore,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  PostgresRunStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import { createToolGatewayComposition } from '@ontology/app-api'
import {
  AnswerPublicationService,
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  RestrictedAnswerVerifier,
  RestrictedDraftWriter,
  RestrictedLimitedAnswerComposer,
  RunPhaseDriver,
  RunService,
  StaticInputValidity,
  WorkflowController,
  createRunCheckpointPort,
} from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import type {
  AnswerVerifierPort,
  EvidenceStorePort,
  PublicationBlockReason,
  PublicationValidityPort,
  PublicationValidityReport,
  PublicationValidityRequest,
  PlanSpec,
  ProfileRef,
  RunStore,
  RuntimeAdapter,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  ToolContext,
  Uuid,
  VerificationResult,
  VerifierRequest,
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
  StaticPlanResolver,
  forbiddenGeneration,
  publishedPlan,
  runtimeManifest,
  templateContext,
} from '../unit/template-runtime-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE = { tenantId: TENANT_ID, spaceId: SPACE_ID }
const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-09-21T00:00:00Z'

const PROFILE: ProfileRef = { id: 'home-energy-answer-demo', version: '1.0.0' }
const TEMPLATE_RUNTIME: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }

const RUN_PUBLISH = '11111111-aaaa-4aaa-8aaa-000000000001'
const RUN_CANCEL = '11111111-aaaa-4aaa-8aaa-000000000002'
const RUN_UNVERIFIABLE = '11111111-aaaa-4aaa-8aaa-000000000003'
const RUN_STALE = '11111111-aaaa-4aaa-8aaa-000000000004'

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

function integrationPlan(): PlanSpec {
  return {
    planRef: { id: 'plan-answer', version: '1.0.0', digest: sha256DigestOf('plan-answer'), kind: 'plan' },
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

class FakeBinder implements RunProfileBinder {
  bindProfileForRun(profileRef: ProfileRef): Promise<RunProfileBinding> {
    return Promise.resolve({
      profileRef,
      resolvedProfileHash: DIGEST,
      resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash: DIGEST },
      runtimeRef: TEMPLATE_RUNTIME,
    })
  }
}

class Selector implements RuntimeSelectorPort {
  readonly selected: string[] = []
  constructor(private readonly adapter: RuntimeAdapter) {}
  select(runtimeRef: VersionRef): Promise<RuntimeAdapter> {
    this.selected.push(runtimeRef.id)
    return Promise.resolve(this.adapter)
  }
}

class Capabilities implements RuntimeCapabilityFactoryPort {
  constructor(
    private readonly composition: ReturnType<typeof createToolGatewayComposition>,
    private readonly checkpoints: RuntimeCapabilitySet['checkpoints'],
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
      generation: forbiddenGeneration,
      decision: {
        decide: () => Promise.reject(new Error('the template runtime must not call the decision port')),
      },
      checkpoints: this.checkpoints,
    })
  }
}

/**
 * A verifier that can block inside `verify`, so a test can invalidate the run (cancel it,
 * or remove its evidence) between verification and publication on the real stores.
 */
class BlockingVerifier implements AnswerVerifierPort {
  readonly #inner: AnswerVerifierPort
  #entered: Promise<void>
  #markEntered: () => void = () => undefined
  #gate: Promise<void> | undefined
  #release: (() => void) | undefined

  constructor(inner: AnswerVerifierPort) {
    this.#inner = inner
    this.#entered = new Promise<void>((resolve) => {
      this.#markEntered = resolve
    })
  }

  entered(): Promise<void> {
    return this.#entered
  }

  block(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve
    })
  }

  release(): void {
    this.#release?.()
    this.#release = undefined
    this.#gate = undefined
  }

  async verify(request: VerifierRequest, ctx: ToolContext): Promise<VerificationResult> {
    this.#markEntered()
    if (this.#gate !== undefined) await this.#gate
    return this.#inner.verify(request, ctx)
  }
}

/** A real-store validity checker: evidence re-readability against the real archive + blob. */
class TestPublicationValidity implements PublicationValidityPort {
  readonly revoked = new Set<string>()
  readonly stale = new Map<string, string>()

  constructor(
    private readonly evidence: EvidenceStorePort,
    private readonly blob: LocalImmutableBlobStore,
  ) {}

  async check(
    request: PublicationValidityRequest,
    ctx: ToolContext,
  ): Promise<PublicationValidityReport> {
    const reasons: PublicationBlockReason[] = []
    const details: string[] = []
    if (this.revoked.has(request.runId)) {
      reasons.push('permission_revoked')
      details.push('the publisher permission was revoked')
    }
    for (const ref of request.evidenceRefs) {
      const record = await this.evidence.get(SCOPE, ref.id, ctx)
      if (record === undefined) {
        reasons.push('evidence_retracted')
        details.push(`evidence ${ref.id} is gone`)
        continue
      }
      const payloadRef = record.envelope.payloadRef
      if (payloadRef === undefined) {
        reasons.push('evidence_unverifiable')
        details.push(`evidence ${ref.id} has no archived payload`)
        continue
      }
      try {
        const authorized = await this.blob.getAuthorized({ scopeRef: SCOPE, blobRef: payloadRef }, ctx)
        if (!authorized.integrityVerified) {
          reasons.push('evidence_unverifiable')
          details.push(`evidence ${ref.id} failed integrity verification`)
        }
      } catch {
        reasons.push('evidence_unverifiable')
        details.push(`evidence ${ref.id} could not be re-read`)
      }
    }
    const stale = this.stale.get(request.runId)
    if (stale !== undefined) {
      reasons.push('data_stale')
      details.push('the source advanced after verification')
    }
    const unique = [...new Set(reasons)]
    const historyLimited = unique.length > 0 && unique.every((reason) => reason === 'data_stale')
    return {
      publishable: unique.length === 0,
      blockedReasons: unique,
      historyLimited,
      ...(historyLimited && stale !== undefined ? { asOf: stale } : {}),
      details,
    }
  }
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let objectStore: FileSystemObjectStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let store: RunStore
let evidenceStore: PostgresEvidenceStore
let answerStore: PostgresAnswerStore
let service: RunService
let phase: RunPhaseDriver
let budget: BudgetService
let selector: Selector
let capabilities: Capabilities

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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'answer-tenant') ON CONFLICT DO NOTHING`,
    [TENANT_ID],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'answer-space') ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'answer-seed')
     ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID, PROFILE.id, PROFILE.version, DIGEST],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID, PROFILE.id, PROFILE.version, DIGEST],
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

  objectDir = await mkdtemp(join(tmpdir(), 'answer-publication-blob-'))
  objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  store = new PostgresRunStore(controlDatabase)
  evidenceStore = new PostgresEvidenceStore(controlDatabase)
  answerStore = new PostgresAnswerStore(controlDatabase)
  const control = new ControlPostgresRepository(controlDatabase)
  budget = new BudgetService({ store: new PostgresBudgetLedgerStore(controlDatabase), control })
  service = new RunService({ store, control, profiles: new FakeBinder() })
  phase = new RunPhaseDriver({ store, control })

  const composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [lookupHandler(), searchHandler()],
  })
  const templateAdapter = new TemplateRuntimeAdapter({
    manifest: runtimeManifest(),
    plans: new StaticPlanResolver(publishedPlan(integrationPlan())),
  })
  selector = new Selector(templateAdapter)
  capabilities = new Capabilities(composition, createRunCheckpointPort(store))
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

function buildController(): {
  readonly controller: WorkflowController
  readonly blocking: BlockingVerifier
  readonly validity: TestPublicationValidity
} {
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const blocking = new BlockingVerifier(new RestrictedAnswerVerifier())
  const validity = new TestPublicationValidity(evidenceStore, blobStore)
  const publisher = new AnswerPublicationService({
    runs: store,
    answers: answerStore,
    verifications,
    manifests,
    validity,
  })
  const controller = new WorkflowController({
    runs: service,
    phase,
    budget,
    manifests,
    runtimes: selector,
    capabilities,
    draftWriter: new RestrictedDraftWriter(),
    limited: new RestrictedLimitedAnswerComposer(),
    verifier: blocking,
    verifications,
    publisher,
    validity: new StaticInputValidity(),
  })
  return { controller, blocking, validity }
}

function startInput(runId: Uuid): Parameters<WorkflowController['startRun']>[0] {
  return {
    runId,
    profileRef: PROFILE,
    question: 'compare tomorrow backup strategies',
    context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    preferences: { route: 'auto', allowWeb: false },
    idempotencyKey: `answer-${runId}`,
  }
}

async function answerRow(runId: Uuid): Promise<Record<string, unknown> | undefined> {
  const result = await adminClient.query<Record<string, unknown>>(
    `SELECT * FROM agent_platform.answer_publications
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
    [TENANT_ID, SPACE_ID, runId],
  )
  return result.rows[0]
}

async function runEventTypes(runId: Uuid): Promise<string[]> {
  const result = await adminClient.query<{ sse_type: string }>(
    `SELECT sse_type FROM agent_platform.run_events
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 ORDER BY sequence`,
    [TENANT_ID, SPACE_ID, runId],
  )
  return result.rows.map((row) => row.sse_type)
}

describe('answer publication against a real containerised PostgreSQL', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      process.stdout.write(
        `[answer-publication] image=${container.image} container=${container.containerName}\n`,
      )
    }
  })

  it('publishes a verified answer and persists every binding', async () => {
    const { controller } = buildController()
    const ctx = templateContext({ runId: RUN_PUBLISH })
    const view = await controller.startRun(startInput(RUN_PUBLISH), ctx)
    expect(view.state).toBe('published')
    expect(view.answer?.publicationKind).toBe('verified')
    expect(view.answer?.body?.schemaVersion).toBe('answer-draft@1')
    expect(view.answer?.body?.blocks).toHaveLength(1)
    expect(view.answer?.body?.blocks[0]).toMatchObject({ kind: 'summary', question: 'compare tomorrow backup strategies' })
    expect(await controller.getAnswer(RUN_PUBLISH, ctx)).toBeDefined()

    const row = await answerRow(RUN_PUBLISH)
    expect(row).toBeDefined()
    expect(row?.['content_hash']).toBe(view.answer?.contentHash)
    expect(row?.['evidence_manifest_hash']).toBe(view.answer?.evidenceManifestHash)
    expect(row?.['scenario_manifest_hash']).toBe(view.answer?.scenarioManifestHash)
    expect(row?.['verification_id']).toBe(view.answer?.verificationId)
    expect(row?.['publication_kind']).toBe('verified')
    expect(row?.['as_of']).toBeNull()
    expect(row?.['body']).toEqual(view.answer?.body)

    const events = await runEventTypes(RUN_PUBLISH)
    expect(events[events.length - 1]).toBe('answer.published')
    expect(events).not.toContain('unverified_answer.delta')
    expect(events.some((event) => event.includes('draft'))).toBe(false)
  })

  it('blocks publication when the run is cancelled after verification', async () => {
    const { controller, blocking } = buildController()
    const ctx = templateContext({ runId: RUN_CANCEL })
    blocking.block()
    const running = controller.startRun(startInput(RUN_CANCEL), ctx)
    await blocking.entered()

    const run = await service.getRun(RUN_CANCEL, ctx)
    await controller.cancel({ runId: RUN_CANCEL, reason: 'user cancelled', expectedRevision: run.revision }, ctx)
    blocking.release()
    await expect(running).rejects.toMatchObject({ code: 'PUBLICATION_REJECTED' })

    expect(await answerRow(RUN_CANCEL)).toBeUndefined()
    const events = await runEventTypes(RUN_CANCEL)
    expect(events).not.toContain('answer.published')
  })

  it('blocks publication when the supporting evidence becomes unreadable after verification', async () => {
    const { controller, blocking } = buildController()
    const ctx = templateContext({ runId: RUN_UNVERIFIABLE })
    blocking.block()
    const running = controller.startRun(startInput(RUN_UNVERIFIABLE), ctx)
    await blocking.entered()

    const records = await evidenceStore.listByRun(SCOPE, RUN_UNVERIFIABLE, ctx)
    expect(records.length).toBeGreaterThanOrEqual(1)
    for (const record of records) {
      const payloadRef = record.envelope.payloadRef
      if (payloadRef !== undefined) await objectStore.remove(payloadRef.digest)
    }
    blocking.release()
    await expect(running).rejects.toMatchObject({ code: 'PUBLICATION_REJECTED' })

    expect(await answerRow(RUN_UNVERIFIABLE)).toBeUndefined()
  })

  it('publishes a stale-but-supported result only as an explicitly history-limited answer', async () => {
    const { controller, validity } = buildController()
    validity.stale.set(RUN_STALE, '2026-09-20T00:00:00Z')
    const ctx = templateContext({ runId: RUN_STALE })
    const view = await controller.startRun(startInput(RUN_STALE), ctx)
    expect(view.state).toBe('published')
    expect(view.answer?.publicationKind).toBe('history_limited')
    expect(Date.parse(view.answer?.asOf ?? '')).toBe(Date.parse('2026-09-20T00:00:00Z'))

    const row = await answerRow(RUN_STALE)
    expect(row?.['publication_kind']).toBe('history_limited')
    expect(row?.['as_of']).toBeInstanceOf(Date)
  })
})
