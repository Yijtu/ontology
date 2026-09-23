import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { BudgetService } from '@ontology/core'
import type {
  BudgetLedgerPort,
  ConfirmedContext,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  ResourceRef,
  RunPreferences,
  ToolContext,
} from '@ontology/contracts'
import { BoundedQuestionRewriter, RunPlanner } from '@ontology/application'
import { CountingCompiler, PLANNING_RUN, multiHopPlanJson } from '../unit/workflow-planning-fixtures'
import { gatewayContext } from '../unit/tool-gateway-fixtures'
import { SCOPE_A } from '../unit/profile-resolver-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * LOCAL-074 acceptance against a real containerised PostgreSQL.
 *
 * The rewrite pre-step and the later SQL proposal both draw from the one real
 * `PostgresBudgetLedgerStore` ledger, so the test proves on the durable store that the
 * retry never resets the shared budget and that the original → rewrite → SQL chain is
 * replayable from the route record. The model is a deterministic double — no real model
 * call is made.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const INTEGRATION_NOW = '2026-09-21T00:00:00Z'
const CTX = gatewayContext({ runId: PLANNING_RUN })
const CONTEXT: ConfirmedContext = { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' }
const PREFERENCES: RunPreferences = { route: 'auto', allowWeb: false }
const MODEL_REF = { modelId: 'rewrite-model', version: '1.0.0' }
const ORIGINAL = 'which meters used the most energy and which site do they belong to'
const REWRITTEN = 'List the meters with the highest total energy_kwh and their site names'

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let database: ControlPostgresDatabase
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

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'evidence' }
}

/** A deterministic generation double that reserves/settles against the real ledger. */
class BudgetedGeneration implements GenerationPort {
  readonly calls: GenerationRequest[] = []
  readonly tokensRemainingAfter: number[] = []
  readonly #budget: BudgetLedgerPort
  readonly #ledgerId: string
  readonly #scripts: GenerationEvent[][]
  #counter = 0

  constructor(
    budget: BudgetLedgerPort,
    ledgerId: string,
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
        ledgerId: this.#ledgerId,
        idempotencyKey: `pg-rewrite-${String(this.#counter).padStart(4, '0')}`,
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
        ledgerId: this.#ledgerId,
        reservationId: outcome.reservation.reservationId,
        status: 'completed',
        usage: { durationMs: 1, modelTokens: 10 },
        evidenceRefs: [evidenceRef()],
      },
      ctx,
    )
    const remaining = await this.#budget.remaining(this.#ledgerId, ctx)
    this.tokensRemainingAfter.push(remaining.remaining.tokensRemaining ?? -1)
  }
}

function planRequest(question = ORIGINAL) {
  return { runId: PLANNING_RUN, question, context: CONTEXT, preferences: PREFERENCES }
}

async function openLedger(ledgerId: string, maxModelTokens: number): Promise<void> {
  await budget.openLedger(
    { ledgerId, kind: 'run', runId: PLANNING_RUN, overrideLimits: { maxModelTokens } },
    CTX,
  )
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
     VALUES ($1, 'rewrite-tenant-a')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'rewrite-space-a')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId],
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
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control: new ControlPostgresRepository(database),
    now: () => INTEGRATION_NOW,
    newId: () => randomUUID(),
  })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('question rewriting against a real PostgreSQL budget ledger', () => {
  it('draws the rewrite retry and the SQL proposal from one durable budget without resetting it', async () => {
    const ledgerId = randomUUID()
    await openLedger(ledgerId, 4096)

    const generation = new BudgetedGeneration(budget, ledgerId, [
      [{ type: 'text_delta', text: 'malformed' }, completed()],
      [rewriteText(REWRITTEN), completed()],
      [
        {
          type: 'tool_call_delta',
          callId: randomUUID(),
          toolId: 'data_query',
          argumentsDelta: multiHopPlanJson(),
        },
        completed(),
      ],
    ])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF, maxAttempts: 2 })
    const planner = new RunPlanner({ compiler: new CountingCompiler(), generation, rewriter })

    const decision = await planner.route(planRequest(), CTX)

    expect(decision.route).toBe('small_plan')
    expect(generation.calls).toHaveLength(3)
    expect(generation.tokensRemainingAfter).toHaveLength(3)
    const [first = -1, second = -1, third = -1] = generation.tokensRemainingAfter
    expect(second).toBeLessThan(first)
    expect(third).toBeLessThan(second)

    // The durable store holds all three reservations on the one ledger, so the retry
    // never opened or reset it.
    const reservations = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, ledgerId],
    )
    expect(reservations.rows[0]?.count).toBe('3')

    // The route record replays original -> rewrite -> generated SQL.
    expect(decision.rewrite?.originalQuestion).toBe(ORIGINAL)
    expect(decision.rewrite?.rewrittenQuestion).toBe(REWRITTEN)
    expect(generation.calls[0]?.messages.at(-1)?.content).toBe(ORIGINAL)
    expect(generation.calls[2]?.messages.at(-1)?.content).toBe(REWRITTEN)
    expect(decision.plan?.steps[0]?.toolId).toBe('data_query')
  }, 120_000)

  it('clarifies an ambiguous question on the real path without proposing SQL', async () => {
    const ledgerId = randomUUID()
    await openLedger(ledgerId, 4096)

    const generation = new BudgetedGeneration(budget, ledgerId, [
      [clarifyText('the billing period is not specified'), completed()],
    ])
    const rewriter = new BoundedQuestionRewriter({ generation, modelRef: MODEL_REF })
    const planner = new RunPlanner({ compiler: new CountingCompiler(), generation, rewriter })

    const decision = await planner.route(planRequest('compare the energy strategies'), CTX)

    expect(decision.route).toBe('clarify')
    expect(decision.clarification?.prompt).toContain('billing period')
    expect(decision.plan).toBeUndefined()
    expect(generation.calls).toHaveLength(1)
  }, 120_000)
})
