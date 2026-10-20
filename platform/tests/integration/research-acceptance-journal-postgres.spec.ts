import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresResearchAcceptanceJournal,
} from '@ontology/adapter-control-postgres'
import type { ResearchAcceptanceRecord, ToolContext } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

let harness: JobDbHarness
let database: ControlPostgresDatabase
let journal: PostgresResearchAcceptanceJournal

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  journal = new PostgresResearchAcceptanceJournal(database)
}, 240_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

let counter = 0
async function freshScope(prefix: string): Promise<{ scope: JobTestScope; ctx: ToolContext; scopeRef: { tenantId: string; spaceId: string } }> {
  counter += 1
  const scope = await createJobScope(harness.adminClient, `${prefix}-${counter}`)
  return {
    scope,
    scopeRef: scope.scopeRef,
    ctx: toolContext(scope.tenantId, scope.spaceId, ['researcher', 'platform-admin'], `${prefix}-${counter}`),
  }
}

function record(researchId: string, runId: string, requestDigest = DIGEST_A, key = `key-${randomUUID().slice(0, 12)}`): ResearchAcceptanceRecord {
  return {
    researchId,
    runId,
    engine: 'agentic',
    requestDigest,
    idempotencyKey: key.length >= 8 ? key : `${key}-padded`,
    acceptedAt: '2026-10-19T00:00:00Z',
  }
}

describe('research acceptance journal (real PostgreSQL, migration 108)', () => {
  it('records the accepting engine once and replays the stored row', async () => {
    const { scopeRef, ctx } = await freshScope('journal-replay')
    const researchId = randomUUID()
    const runId = randomUUID()
    const first = await journal.record(scopeRef, record(researchId, runId, DIGEST_A, 'journal-replay-0001'), ctx)
    expect(first.created).toBe(true)
    expect(first.record).toMatchObject({ researchId, runId, engine: 'agentic', requestDigest: DIGEST_A })

    const replay = await journal.record(scopeRef, record(researchId, runId, DIGEST_A, 'journal-replay-0001'), ctx)
    expect(replay.created).toBe(false)
    expect(replay.record.researchId).toBe(researchId)

    expect(await journal.get(scopeRef, researchId, ctx)).toMatchObject({ engine: 'agentic', runId })
    expect(await journal.findByIdempotencyKey(scopeRef, 'journal-replay-0001', ctx)).toMatchObject({ researchId })
  })

  it('refuses a different engine or digest for the same research id', async () => {
    const { scopeRef, ctx } = await freshScope('journal-conflict')
    const researchId = randomUUID()
    await journal.record(scopeRef, record(researchId, randomUUID(), DIGEST_A, 'journal-conflict-0001'), ctx)

    await expect(journal.record(scopeRef, record(researchId, randomUUID(), DIGEST_B, 'journal-conflict-0002'), ctx))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(journal.record(scopeRef, {
      researchId,
      engine: 'legacy',
      requestDigest: DIGEST_A,
      idempotencyKey: 'journal-conflict-0003',
      acceptedAt: '2026-10-19T00:00:00Z',
    }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('resolves two concurrent acceptances of one request to exactly one engine and one run', async () => {
    const { scopeRef, ctx } = await freshScope('journal-race')
    const researchId = randomUUID()
    const runId = randomUUID()
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        journal.record(scopeRef, record(researchId, runId, DIGEST_A, 'journal-race-0001'), ctx)
          .catch((error: unknown) => error as Error)),
    )
    const errors = outcomes.filter((entry) => entry instanceof Error)
    expect(errors).toEqual([])
    const created = outcomes.filter((entry) => !(entry instanceof Error) && entry.created)
    expect(created).toHaveLength(1)
    const stored = await journal.get(scopeRef, researchId, ctx)
    expect(stored?.runId).toBe(runId)
  })

  it('isolates the journal across tenant/space scopes', async () => {
    const { scopeRef, ctx } = await freshScope('journal-scope-a')
    const other = await freshScope('journal-scope-b')
    const researchId = randomUUID()
    await journal.record(scopeRef, record(researchId, randomUUID(), DIGEST_A, 'journal-scope-0001'), ctx)

    expect(await journal.get(other.scopeRef, researchId, other.ctx)).toBeUndefined()
    expect(await journal.findByIdempotencyKey(other.scopeRef, 'journal-scope-0001', other.ctx)).toBeUndefined()
    // The same research id is free in another scope: the journal is per tenant/space, never global.
    const accepted = await journal.record(other.scopeRef, record(researchId, randomUUID(), DIGEST_B, 'journal-scope-0002'), other.ctx)
    expect(accepted.created).toBe(true)
  })
})
