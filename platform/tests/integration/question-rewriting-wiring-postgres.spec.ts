import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresRunStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  BoundedQuestionRewriter,
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  RestrictedAnswerPublisher,
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
import { BudgetService } from '@ontology/core'
import type {
  BudgetLedgerPort,
  ConfirmedContext,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  ProfileRef,
  ResourceRef,
  RunPreferences,
  RuntimeEvent,
  ToolContext,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import {
  RecordingBudget,
  RecordingRuntimeSelector,
  ScriptedRuntime,
  StaticCapabilityFactory,
  ScriptedGateway,
  collectionCompleteEvent,
  evidenceEvent,
  evidenceRef,
  planEvent,
} from '../unit/workflow-fixtures'
import { gatewayContext } from '../unit/tool-gateway-fixtures'

/**
 * LOCAL-080 acceptance against a real containerised PostgreSQL.
 *
 * The rewrite step is driven by the **real `WorkflowController`** on the actual run path,
 * with the real `PostgresRunStore`/`RunService`/`RunPhaseDriver` and the real budget ledger.
 * The model is a deterministic double that reserves/settles against the same durable ledger,
 * so no real model call is made. The test proves:
 *
 *  - the controller invokes the rewrite once during preflight;
 *  - a successful rewrite is persisted on the durable run record and readable per run;
 *  - the runtime generates from the disambiguated question (original → rewrite → SQL);
 *  - an ambiguity takes the existing clarification path without recording a trace;
 *  - a rewrite failure fails the run explicitly and never routes the original question.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const SPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DIGEST = `sha256:${'a'.repeat(64)}`
const PROFILE_REF: ProfileRef = { id: 'home-energy-rewrite-demo', version: '1.0.0' }
const RUNTIME_REF = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }
const CONTEXT: ConfirmedContext = { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' }
const PREFERENCES: RunPreferences = { route: 'auto', allowWeb: false }
const ORIGINAL = 'which meters used the most energy'
const REWRITTEN = 'List the meters with the highest total energy_kwh'

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let database: ControlPostgresDatabase
let store: PostgresRunStore
let budget: BudgetService

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const databaseName = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${databaseName}`
}

function rewriteText(question: string): GenerationEvent {
  return { type: 'text_delta', text: JSON.stringify({ status: 'rewritten', question }) }
}

function clarifyText(reason: string): GenerationEvent {
  return { type: 'text_delta', text: JSON.stringify({ status: 'clarify', reason }) }
}

function completed(): GenerationEvent {
  return { type: 'completed', stopReason: 'stop', candidateOnly: true }
}

function evidenceRefOf(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'evidence' }
}

/** A deterministic generation double that reserves/settles against the real ledger. */
class BudgetedGeneration implements GenerationPort {
  readonly calls: GenerationRequest[] = []
  readonly #budget: BudgetLedgerPort
  readonly #ledgerId: () => string
  readonly #scripts: GenerationEvent[][]
  #counter = 0

  constructor(
    budget: BudgetLedgerPort,
    ledgerId: () => string,
    scripts: readonly (readonly GenerationEvent[])[],
  ) {
    this.#budget = budget
    this.#ledgerId = ledgerId
    this.#scripts = scripts.map((script) => [...script])
  }

  async *generate(request: GenerationRequest, ctx: ToolContext): AsyncIterable<GenerationEvent> {
    this.calls.push(request)
    this.#counter += 1
    const outcome = await this.#budget.reserve(
      {
        ledgerId: this.#ledgerId(),
        idempotencyKey: `rewrite-wiring-${String(this.#counter).padStart(4, '0')}-${randomUUID()}`,
        parallel: true,
        modelTokens: request.outputLimit.maxTokens,
        requestedDeadline: ctx.deadline,
      },
      ctx,
    )
    if (!outcome.granted || outcome.reservation === undefined) {
      throw new Error(`the shared budget denied the generation call: ${outcome.denial?.code ?? 'unknown'}`)
    }
    for (const event of this.#scripts.shift() ?? []) yield event
    await this.#budget.settle(
      {
        ledgerId: this.#ledgerId(),
        reservationId: outcome.reservation.reservationId,
        status: 'completed',
        usage: { durationMs: 1, modelTokens: 10 },
        evidenceRefs: [evidenceRefOf()],
      },
      ctx,
    )
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

interface Harness {
  readonly controller: WorkflowController
  readonly service: RunService
  readonly runtime: ScriptedRuntime
  readonly selector: RecordingRuntimeSelector
  readonly recordingBudget: RecordingBudget
  readonly rewriter: BoundedQuestionRewriter
  readonly generation: BudgetedGeneration
}

function normalScript(runId: string): RuntimeEvent[] {
  return [planEvent(runId), evidenceEvent(runId, [evidenceRef('a')]), collectionCompleteEvent(runId)]
}

function buildHarness(runId: string, scripts: readonly (readonly GenerationEvent[])[]): Harness {
  const recordingBudget = new RecordingBudget(budget)
  const generation = new BudgetedGeneration(recordingBudget, () => {
    const ledgerId = recordingBudget.openLedgerCalls.at(-1)
    if (ledgerId === undefined) throw new Error('the run budget ledger was not opened')
    return ledgerId
  }, scripts)
  const rewriter = new BoundedQuestionRewriter({
    generation,
    modelRef: { modelId: 'rewrite-model', version: '1.0.0' },
  })
  const control = new ControlPostgresRepository(database)
  const service = new RunService({ store, control, profiles: new FakeBinder() })
  const phase = new RunPhaseDriver({ store, control })
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const runtime = new ScriptedRuntime({ scripts: [normalScript(runId)] })
  const selector = new RecordingRuntimeSelector(runtime)
  const capabilities = new StaticCapabilityFactory({
    gateway: new ScriptedGateway(),
    checkpoints: createRunCheckpointPort(store),
  })
  const controller = new WorkflowController({
    runs: service,
    phase,
    budget: recordingBudget,
    manifests,
    runtimes: selector,
    capabilities,
    draftWriter: new RestrictedDraftWriter(),
    limited: new RestrictedLimitedAnswerComposer(),
    verifier: new RestrictedAnswerVerifier(),
    verifications,
    publisher: new RestrictedAnswerPublisher({ store, verifications }),
    validity: new StaticInputValidity(),
    rewriter,
  })
  return { controller, service, runtime, selector, recordingBudget, rewriter, generation }
}

function startInput(runId: string) {
  return {
    runId,
    profileRef: PROFILE_REF,
    question: ORIGINAL,
    context: CONTEXT,
    preferences: PREFERENCES,
    idempotencyKey: `rewrite-wiring-${runId}`,
  }
}

async function readPersistedRewrite(runId: string): Promise<unknown> {
  const result = await adminClient.query<{ question_rewrite: unknown }>(
    `SELECT question_rewrite FROM agent_platform.runs
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
    [TENANT_ID, SPACE_ID, runId],
  )
  return result.rows[0]?.question_rewrite
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'rewrite-wiring-tenant') ON CONFLICT DO NOTHING`,
    [TENANT_ID],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'rewrite-wiring-space') ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID],
  )
  // Seed the immutable resolved-profile rows the run store's composite FK requires.
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'rewrite-wiring-seed')
     ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID, PROFILE_REF.id, PROFILE_REF.version, DIGEST],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_ID, SPACE_ID, PROFILE_REF.id, PROFILE_REF.version, DIGEST],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)

  database = new ControlPostgresDatabase({
    connectionString: connectionStringFor(adminUrl, 'ontology_app', appPassword),
    maxPoolSize: 8,
  })
  store = new PostgresRunStore(database)
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    newId: () => randomUUID(),
  })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('question rewriting on the real controller run path against PostgreSQL', () => {
  it('persists the rewrite trace on the run record and drives generation from the rewritten question', async () => {
    const runId = randomUUID()
    const harness = buildHarness(runId, [[rewriteText(REWRITTEN), completed()]])
    const ctx = gatewayContext({ tenantId: TENANT_ID, spaceId: SPACE_ID, runId })

    const view = await harness.controller.startRun(startInput(runId), ctx)
    expect(view.state).toBe('published')

    // The controller invoked the rewrite exactly once, on the original question.
    expect(harness.generation.calls).toHaveLength(1)
    expect(harness.generation.calls[0]?.messages.at(-1)?.content).toBe(ORIGINAL)

    // The trace is readable back per run through the real store...
    const run = await harness.service.getRun(runId, ctx)
    expect(run.questionRewrite?.originalQuestion).toBe(ORIGINAL)
    expect(run.questionRewrite?.rewrittenQuestion).toBe(REWRITTEN)
    expect(run.questionRewrite?.version).toBe('1.0.0')
    expect(run.questionRewrite?.modelRef.modelId).toBe('rewrite-model')
    // ...and it is durably persisted in the run record, not just in memory.
    const persisted = (await readPersistedRewrite(runId)) as { rewrittenQuestion?: string } | null
    expect(persisted?.rewrittenQuestion).toBe(REWRITTEN)

    // The runtime generated from the disambiguated question: original → rewrite → SQL path.
    expect(harness.runtime.startQuestions).toEqual([REWRITTEN])
    // The original question stays immutable on the record.
    expect(run.question).toBe(ORIGINAL)
  }, 120_000)

  it('takes the existing clarification path on ambiguity without persisting a trace', async () => {
    const runId = randomUUID()
    const harness = buildHarness(runId, [
      [clarifyText('the billing period is not specified'), completed()],
    ])
    const ctx = gatewayContext({ tenantId: TENANT_ID, spaceId: SPACE_ID, runId })

    const waiting = await harness.controller.startRun(startInput(runId), ctx)
    expect(waiting.state).toBe('awaiting_input')
    expect(waiting.pendingClarificationId).toBeDefined()

    const run = await harness.service.getRun(runId, ctx)
    expect(run.questionRewrite).toBeUndefined()
    expect(await readPersistedRewrite(runId)).toBeNull()
    // No runtime was selected before the user answered.
    expect(harness.selector.selected).toHaveLength(0)

    const events = await harness.service.listEvents(runId, undefined, ctx)
    expect(events.some((event) => event.event === 'clarification.required')).toBe(true)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)

    // Answering resumes collection; the rewrite is not re-run (already past preflight).
    const clarificationId = waiting.pendingClarificationId
    if (clarificationId === undefined) throw new Error('no clarification to answer')
    const resumed = await harness.controller.respondToClarification(
      {
        runId,
        clarificationId,
        typedResponse: { period: '2026-01' },
        expectedRevision: waiting.revision,
      },
      ctx,
    )
    expect(resumed.state).toBe('published')
    expect(harness.generation.calls).toHaveLength(1)
    expect(harness.runtime.startQuestions).toEqual([ORIGINAL])
  }, 120_000)

  it('fails the run explicitly on a rewrite failure and never routes the original question', async () => {
    const runId = randomUUID()
    const harness = buildHarness(runId, [
      [
        {
          type: 'error',
          error: { code: 'MODEL_UNAVAILABLE', message: 'the rewrite model call failed', retryable: true },
        },
      ],
    ])
    const ctx = gatewayContext({ tenantId: TENANT_ID, spaceId: SPACE_ID, runId })

    const view = await harness.controller.startRun(startInput(runId), ctx)
    expect(view.state).toBe('failed')
    expect(view.answer).toBeUndefined()

    const run = await harness.service.getRun(runId, ctx)
    expect(run.questionRewrite).toBeUndefined()
    expect(await readPersistedRewrite(runId)).toBeNull()

    // No runtime was selected and no draft was attempted: no false success.
    expect(harness.selector.selected).toHaveLength(0)
    const events = await harness.service.listEvents(runId, undefined, ctx)
    expect(events.some((event) => event.event === 'run.failed')).toBe(true)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
  }, 120_000)
})
