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
import { createToolGatewayComposition } from '@ontology/app-api'
import {
  DraftVerificationService,
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  RestrictedAnswerPublisher,
  RestrictedLimitedAnswerComposer,
  RunPhaseDriver,
  RunService,
  StaticInputValidity,
  WorkflowController,
  answerDraftContentHash,
  createRunCheckpointPort,
} from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import type {
  AnswerDraft,
  AnswerVerifierPort,
  DraftClaim,
  DraftWriterPort,
  DraftWriterRequest,
  DraftWriterResult,
  ProfileRef,
  ResourceRef,
  RunStore,
  RuntimeAdapter,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  Sha256Digest,
  ToolContext,
  Uuid,
  VerificationResult,
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
  RESULT_PAYLOAD,
  SCOPE_A,
  buildClaim,
  toolContext,
  verificationPolicy,
} from '../unit/verification-fixtures'
import {
  ScriptedRuntime,
  collectionCompleteEvent,
  evidenceEvent,
  planEvent,
} from '../unit/workflow-fixtures'
import { forbiddenDecision, forbiddenGeneration } from '../unit/template-runtime-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROFILE_REF: ProfileRef = { id: 'home-energy-feedback-demo', version: '1.0.0' }
const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }
const RUN_REPAIR = '33333333-3333-4333-8333-333333333333'
const RUN_BLOCKED = '66666666-6666-4666-8666-666666666666'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function lookupHandler(): RecordingHandler {
  return new RecordingHandler('ontology_lookup', {
    payload: RESULT_PAYLOAD,
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
  })
}

function lookupCall(): { readonly callId: string; readonly toolId: 'ontology_lookup'; readonly arguments: Record<string, unknown> } {
  return {
    callId: randomUUID(),
    toolId: 'ontology_lookup',
    arguments: { scopeRef: SCOPE_A, intent: 'definitions' },
  }
}

function draftFor(
  runId: Uuid,
  evidenceManifestHash: Sha256Digest,
  claims: readonly DraftClaim[],
  blocks: readonly unknown[],
): AnswerDraft {
  return {
    draftId: randomUUID(),
    runId,
    blocks,
    claims,
    evidenceManifestHash,
    contentHash: answerDraftContentHash(runId, blocks, evidenceManifestHash, claims),
    limitations: [],
    producedInPhase: 'drafting',
    createdAt: '2026-09-21T00:00:00Z',
  }
}

/**
 * A bounded draft writer that produces a claim bound to the real archived evidence. The
 * first attempt uses a deliberately wrong unit; a repair attempt uses the correct unit
 * (or, in `alwaysWrong` mode, repeats the mistake so the cap can be proven).
 */
class FeedbackDraftWriter implements DraftWriterPort {
  readonly calls: DraftWriterRequest[] = []
  evidenceRef: ResourceRef | undefined
  resultDigest: Sha256Digest | undefined
  alwaysWrong = false

  writeDraft(request: DraftWriterRequest): Promise<DraftWriterResult> {
    this.calls.push(request)
    const evidenceRef = this.evidenceRef
    const resultDigest = this.resultDigest
    if (evidenceRef === undefined || resultDigest === undefined) {
      throw new Error('the feedback draft writer was not bound to the persisted evidence')
    }
    const wrong = this.alwaysWrong || request.attempt === 1
    const claim = buildClaim({
      evidenceRef,
      resultDigest,
      unit: wrong ? 'MWh' : RESULT_PAYLOAD.unit,
    })
    const blocks: readonly unknown[] = [{ kind: 'claim', claimId: claim.claimId }]
    const draft = draftFor(request.runId, request.inputManifest.digest, [claim], blocks)
    const draftRef: ResourceRef = {
      id: draft.draftId,
      version: '1.0.0',
      digest: draft.contentHash,
      kind: 'artifact',
    }
    return Promise.resolve({
      draft,
      usage: { durationMs: 1, calls: 0, modelTokens: 32 },
      evidenceRefs: [draftRef],
    })
  }
}

/** Counts verification calls so a repair can be proven to have been re-verified. */
class CountingVerifier implements AnswerVerifierPort {
  calls = 0
  readonly #inner: AnswerVerifierPort

  constructor(inner: AnswerVerifierPort) {
    this.#inner = inner
  }

  verify(
    request: Parameters<AnswerVerifierPort['verify']>[0],
    ctx: ToolContext,
  ): Promise<VerificationResult> {
    this.calls += 1
    return this.#inner.verify(request, ctx)
  }
}

class FakeBinder implements RunProfileBinder {
  bindProfileForRun(profileRef: ProfileRef): Promise<RunProfileBinding> {
    return Promise.resolve({
      profileRef,
      resolvedProfileHash: DIGEST,
      resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash: DIGEST },
      runtimeRef: RUNTIME_REF,
    })
  }
}

class Selector implements RuntimeSelectorPort {
  constructor(private readonly adapter: RuntimeAdapter) {}
  select(): Promise<RuntimeAdapter> {
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
let composition: ReturnType<typeof createToolGatewayComposition>
let runs: RunService

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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'feedback-tenant') ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'feedback-space') ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'feedback-seed')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, PROFILE_REF.version, DIGEST],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_REF.id, PROFILE_REF.version, DIGEST],
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

  objectDir = await mkdtemp(join(tmpdir(), 'feedback-loop-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  store = new PostgresRunStore(controlDatabase)
  const control = new ControlPostgresRepository(controlDatabase)
  budget = new BudgetService({ store: new PostgresBudgetLedgerStore(controlDatabase), control })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)
  composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [lookupHandler()],
  })
  runs = new RunService({ store, control, profiles: new FakeBinder() })
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

function ctxFor(runId: Uuid): ToolContext {
  return toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', runId)
}

/** Persist one real evidence row through the real gateway and return its reference. */
async function invokeAndPersist(runId: Uuid, ctx: ToolContext): Promise<ResourceRef> {
  const ledgerId = randomUUID()
  await budget.openLedger({ ledgerId, kind: 'run', runId }, ctx)
  const result = await composition
    .forRun({
      runId,
      ledgerId,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    })
    .invoke(lookupCall(), ctx)
  expect(result.status).toBe('ok')
  expect(result.evidenceRefs).toHaveLength(1)
  const evidenceRef = result.evidenceRefs[0]
  if (evidenceRef === undefined) throw new Error('the tool call returned no evidence reference')
  return evidenceRef
}

function buildController(input: {
  readonly writer: DraftWriterPort
  readonly verifier: AnswerVerifierPort
  readonly runtime: RuntimeAdapter
}): WorkflowController {
  const control = new ControlPostgresRepository(controlDatabase)
  const phase = new RunPhaseDriver({ store, control })
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const capabilities = new Capabilities(composition, createRunCheckpointPort(store))
  return new WorkflowController({
    runs,
    phase,
    budget,
    manifests,
    runtimes: new Selector(input.runtime),
    capabilities,
    draftWriter: input.writer,
    limited: new RestrictedLimitedAnswerComposer(),
    verifier: input.verifier,
    verifications,
    publisher: new RestrictedAnswerPublisher({ store, verifications }),
    validity: new StaticInputValidity(),
  })
}

function startInput(runId: Uuid): Parameters<WorkflowController['startRun']>[0] {
  return {
    runId,
    profileRef: PROFILE_REF,
    question: 'compare tomorrow backup strategies',
    context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    preferences: { route: 'auto', allowWeb: false },
    idempotencyKey: `feedback-${runId}`,
  }
}

describe('failed-checks feedback loop against real PostgreSQL, blob store and verification', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      process.stdout.write(
        `[failed-checks-feedback] image=${container.image} container=${container.containerName}\n`,
      )
    }
  })

  it('repairs a verification failure with located feedback and re-verifies before publishing', async () => {
    const ctx = ctxFor(RUN_REPAIR)
    const evidenceRef = await invokeAndPersist(RUN_REPAIR, ctx)
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, ctx)
    if (record === undefined) throw new Error('the evidence was not recorded')

    const writer = new FeedbackDraftWriter()
    writer.evidenceRef = evidenceRef
    writer.resultDigest = record.envelope.resultDigest
    const verifier = new CountingVerifier(
      new DraftVerificationService({
        evidence: evidenceStore,
        artifacts: blobStore,
        policy: verificationPolicy({ semanticReview: 'disabled' }),
        now: () => record.recordedAt,
      }),
    )
    const runtime = new ScriptedRuntime({
      scripts: [
        [
          planEvent(RUN_REPAIR),
          evidenceEvent(RUN_REPAIR, [evidenceRef]),
          collectionCompleteEvent(RUN_REPAIR, 1),
        ],
      ],
    })
    const controller = buildController({ writer, verifier, runtime })

    const view = await controller.startRun(startInput(RUN_REPAIR), ctx)
    expect(view.state).toBe('published')

    // The first draft failed; the repair was told exactly which claim/field/evidence failed.
    expect(writer.calls).toHaveLength(2)
    expect(writer.calls[0]?.failedChecks).toBeUndefined()
    const repair = writer.calls[1]
    expect(repair?.attempt).toBe(2)
    const unitFinding = repair?.failedChecks?.find((check) => check.code === 'unit_mismatch')
    expect(unitFinding?.field).toBe('unit')
    expect(unitFinding?.claimId).toBeDefined()
    expect(unitFinding?.evidenceRef?.id).toBe(evidenceRef.id)
    expect(unitFinding?.pointer).toBe('/unit')
    expect(unitFinding?.expected).toBe('kWh')
    expect(unitFinding?.actual).toBe('MWh')

    // The repaired draft was re-verified by the real verifier and then published.
    expect(verifier.calls).toBe(2)
    const answer = await controller.getAnswer(RUN_REPAIR, ctx)
    expect(answer?.runId).toBe(RUN_REPAIR)

    // One shared ledger: the repair drew from it and did not reset it.
    const remaining = await budget.remaining(view.budgetLedgerId, ctx)
    expect(remaining.remaining.repairAttemptsRemaining).toBe(1)

    // No draft body and no located feedback leaks onto the business event stream.
    const events = await runs.listEvents(RUN_REPAIR, undefined, ctx)
    expect(events.map((event) => event.event)).toContain('answer.published')
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('unit_mismatch')
    expect(serialized).not.toContain('"attempt"')
  }, 120_000)

  it('caps the repair rounds and blocks instead of publishing unverified prose', async () => {
    const ctx = ctxFor(RUN_BLOCKED)
    const evidenceRef = await invokeAndPersist(RUN_BLOCKED, ctx)
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, ctx)
    if (record === undefined) throw new Error('the evidence was not recorded')

    const writer = new FeedbackDraftWriter()
    writer.evidenceRef = evidenceRef
    writer.resultDigest = record.envelope.resultDigest
    writer.alwaysWrong = true
    const verifier = new CountingVerifier(
      new DraftVerificationService({
        evidence: evidenceStore,
        artifacts: blobStore,
        policy: verificationPolicy({ semanticReview: 'disabled' }),
        now: () => record.recordedAt,
      }),
    )
    const runtime = new ScriptedRuntime({
      scripts: [
        [
          planEvent(RUN_BLOCKED),
          evidenceEvent(RUN_BLOCKED, [evidenceRef]),
          collectionCompleteEvent(RUN_BLOCKED, 1),
        ],
      ],
    })
    const controller = buildController({ writer, verifier, runtime })

    const view = await controller.startRun(startInput(RUN_BLOCKED), ctx)
    expect(view.state).toBe('blocked')
    expect(view.answer).toBeUndefined()
    // Bounded: the draft was attempted at most maxDraftAttempts times.
    expect(writer.calls).toHaveLength(2)
    expect(writer.calls[1]?.failedChecks?.some((check) => check.code === 'unit_mismatch')).toBe(true)
    expect(await controller.getAnswer(RUN_BLOCKED, ctx)).toBeUndefined()

    const events = await runs.listEvents(RUN_BLOCKED, undefined, ctx)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
  }, 120_000)
})
