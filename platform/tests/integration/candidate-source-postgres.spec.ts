import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresAssetWorkspaceStore, PostgresCandidateSourceStore, PostgresJobStore } from '@ontology/adapter-control-postgres'
import { JobService } from '@ontology/application'
import { CandidateSourceError } from '@ontology/contracts'
import type { CandidateSource, CreateIndustryWorkspaceInput, ResourceRef, ToolContext, Uuid } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const RECORDED_AT = '2026-10-13T00:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let store: PostgresCandidateSourceStore
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let otherCtx: ToolContext
let workspaceId: Uuid

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: sha('a'), kind: 'artifact' }
}

function source(overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    schemaVersion: 'candidate-source@1',
    sourceId: randomUUID(),
    workspaceId,
    kind: 'web_fetch',
    trustTier: 'agent_researched',
    origin: { url: 'https://example.org/standard', fetchedAt: RECORDED_AT },
    contentRef: resourceRef(),
    contentDigest: sha('b'),
    freshness: { retrievedAt: RECORDED_AT },
    reviewState: 'proposed',
    proposedBy: 'researcher',
    recordedAt: RECORDED_AT,
    ...overrides,
  }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'candidate-source')
  otherScope = await createJobScope(harness.adminClient, 'candidate-source-other')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
  otherCtx = toolContext(otherScope.tenantId, otherScope.spaceId, ['platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresCandidateSourceStore(database)
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const jobStore = new PostgresJobStore(database)
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  const jobId = randomUUID()
  await jobService.createJob({ jobId, kind: 'ingestion', sourceRef: 'candidate-source-test', documentRef: randomUUID(), pipelineVersion: '1.0.0', idempotencyKey: `anchor-${jobId.slice(0, 12)}` }, ctx)
  workspaceId = randomUUID()
  const createInput: CreateIndustryWorkspaceInput = {
    workspace: { workspaceId, namespace: 'test.industry', displayName: 'Candidate source workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, headRevision: '1', state: 'draft' },
    firstDraft: { workspaceId, revision: '1', digest: sha('d'), documentSetRef: resourceRef(), candidateRefs: [] },
    idempotencyKey: `ws-${randomUUID().slice(0, 12)}`,
    requestDigest: sha('1'),
    actor: 'tester',
    recordedAt: RECORDED_AT,
    outbox: { outboxId: randomUUID(), topic: 'asset.workspace.created', payload: { workspaceId }, idempotencyKey: `ob-${randomUUID().slice(0, 12)}`, availableAt: RECORDED_AT, createdAt: RECORDED_AT },
    outboxJobId: jobId,
  }
  await workspaceStore.createWorkspace(createInput, scope.scopeRef, ctx)
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('candidate source store (real PostgreSQL)', () => {
  it('persists a proposed source and reads it back with its tier and origin', async () => {
    const proposed = source()
    const written = await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    expect(written.reviewState).toBe('proposed')
    expect(written.trustTier).toBe('agent_researched')
    expect(written.origin.url).toBe('https://example.org/standard')

    const read = await store.getSource(scope.scopeRef, proposed.sourceId, ctx)
    expect(read?.sourceId).toBe(proposed.sourceId)
    expect(read?.freshness?.retrievedAt).toBe(RECORDED_AT)
  })

  it('replays an identical propose key and rejects a reused key for another source', async () => {
    const proposed = source()
    const key = `cs-${randomUUID().slice(0, 12)}`
    const first = await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: key }, ctx)
    const replay = await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: key }, ctx)
    expect(replay.sourceId).toBe(first.sourceId)
    await expect(store.putSource(scope.scopeRef, { source: { ...proposed, sourceId: randomUUID() }, idempotencyKey: key }, ctx))
      .rejects.toBeInstanceOf(CandidateSourceError)
  })

  it('promotes a proposed source with an expected revision and is idempotent on replay', async () => {
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    const approved = await store.reviewSource(scope.scopeRef, { sourceId: proposed.sourceId, reviewState: 'approved', reviewedBy: 'expert', expectedRevision: '1', idempotencyKey: `rv-${randomUUID().slice(0, 12)}` }, ctx)
    expect(approved.reviewState).toBe('approved')
    expect(approved.reviewedBy).toBe('expert')
    const replay = await store.reviewSource(scope.scopeRef, { sourceId: proposed.sourceId, reviewState: 'approved', reviewedBy: 'expert', expectedRevision: '2', idempotencyKey: `rv-${randomUUID().slice(0, 12)}` }, ctx)
    expect(replay.reviewedBy).toBe('expert')
  })

  it('promotes an agent-researched source to a publishable standard tier', async () => {
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    const promoted = await store.reviewSource(scope.scopeRef, { sourceId: proposed.sourceId, reviewState: 'approved', trustTier: 'public_standard', reviewedBy: 'expert', expectedRevision: '1', idempotencyKey: `rv-${randomUUID().slice(0, 12)}` }, ctx)
    expect(promoted.reviewState).toBe('approved')
    expect(promoted.trustTier).toBe('public_standard')
  })

  it('rejects a review against a stale expected revision', async () => {
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    await expect(store.reviewSource(scope.scopeRef, { sourceId: proposed.sourceId, reviewState: 'rejected', reviewedBy: 'expert', expectedRevision: '9', idempotencyKey: `rv-${randomUUID().slice(0, 12)}` }, ctx))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('lists by review state and never leaks across scope', async () => {
    const workspace = randomUUID()
    void workspace
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    const list = await store.listSources(scope.scopeRef, workspaceId, { reviewState: 'proposed' }, ctx)
    expect(list.some((row) => row.sourceId === proposed.sourceId)).toBe(true)
    expect(await store.getSource(otherScope.scopeRef, proposed.sourceId, otherCtx)).toBeUndefined()
    const otherList = await store.listSources(otherScope.scopeRef, workspaceId, {}, otherCtx)
    expect(otherList).toHaveLength(0)
  })
})
