import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresCandidateSubmissionStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import { publishGroundingDocumentSet } from '@ontology/adapter-extraction-document'
import { IndustryWorkspaceService } from '@ontology/application'
import type {
  CandidateSourceLink,
  CandidateSubmissionRecord,
  ScopeRef,
  SubmitCandidatesReceipt,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 120_000 })

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

let db: JobDbHarness
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let jobs: PostgresJobStore
let workspaces: PostgresAssetWorkspaceStore
let objectDir = ''
let objectStore: FileSystemObjectStore

beforeAll(async () => {
  db = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: db.appUrl, maxPoolSize: 4 })
  registry = new PostgresArtifactRegistry({ connectionString: db.appUrl, maxPoolSize: 2 })
  jobs = new PostgresJobStore(database)
  workspaces = new PostgresAssetWorkspaceStore(database)
  objectDir = await mkdtemp(join(tmpdir(), 'ontology-submission-'))
  objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  blobs = new LocalImmutableBlobStore({ objectStore, registry })
}, 300_000)

afterAll(async () => {
  await registry?.close()
  await database?.close()
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
  await db?.stop()
})

interface Fixture {
  readonly scope: JobTestScope
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
  readonly workspaceId: Uuid
  readonly store: PostgresCandidateSubmissionStore
}

async function fixture(prefix: string): Promise<Fixture> {
  const scope = await createJobScope(db.adminClient, prefix)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['profile-editor', 'platform-admin'], `${prefix}-editor`)
  const workspaceId = randomUUID()
  const setRef = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', workspaceId, scopeRef: scope.scopeRef, sources: [] }, ctx)
  const ids = [workspaceId]
  await new IndustryWorkspaceService({ store: workspaces, jobs, newId: () => ids.shift() ?? randomUUID() }).createWorkspace(
    { namespace: `sub_${workspaceId.replaceAll('-', '')}`, displayName: 'Submission', boundary: { goals: ['model'], included: [], excluded: [], applicability: {} }, documentSetRef: setRef },
    randomUUID(), 'integration', ctx,
  )
  return { scope, scopeRef: scope.scopeRef, ctx, workspaceId, store: new PostgresCandidateSubmissionStore(database) }
}

function record(f: Fixture, runId: Uuid, idempotencyKey: string, commandDigest: string, candidateId: Uuid): CandidateSubmissionRecord {
  const receipt: SubmitCandidatesReceipt = {
    schemaVersion: 'submit-candidates-receipt@1', runId, workspaceId: f.workspaceId, commandDigest,
    accepted: [{ submissionIndex: 0, candidateId, kind: 'definition', state: 'pending_confirmation', pendingConfirmation: true, issues: [], sourceRefs: [{ id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' }] }],
    rejected: [], replayed: false, recordedAt: '2026-10-16T01:00:00Z',
  }
  const link: CandidateSourceLink = {
    candidateId, candidateKind: 'definition', submissionIndex: 0, evidenceIndex: 0,
    sourceRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' },
    trustTier: 'agent_researched', parserVersion: '1.0.0', pendingConfirmation: true, recordedAt: '2026-10-16T01:00:00Z',
  }
  return {
    schemaVersion: 'candidate-submission-record@1', runId, workspaceId: f.workspaceId, idempotencyKey,
    commandDigest, receipt, links: [link], createdBy: f.ctx.principal.subjectId, recordedAt: '2026-10-16T01:00:00Z',
  }
}

describe('candidate submission receipt store (PostgreSQL, migration 095)', () => {
  it('persists a receipt with its candidate-source links and replays idempotently', async () => {
    const f = await fixture('submission_a')
    const runId = randomUUID()
    const candidateId = randomUUID()
    const first = await f.store.record(f.scopeRef, { record: record(f, runId, 'idem-key-0001', DIGEST_A, candidateId) }, f.ctx)
    expect(first.replayed).toBe(false)

    const found = await f.store.findByKey(f.scopeRef, { runId, idempotencyKey: 'idem-key-0001' }, f.ctx)
    expect(found?.receipt.accepted[0]?.candidateId).toBe(candidateId)
    expect(found?.links).toHaveLength(1)

    const replay = await f.store.record(f.scopeRef, { record: record(f, runId, 'idem-key-0001', DIGEST_A, candidateId) }, f.ctx)
    expect(replay.replayed).toBe(true)

    await expect(f.store.record(f.scopeRef, { record: record(f, runId, 'idem-key-0001', DIGEST_B, candidateId) }, f.ctx))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const links = await f.store.listLinksForCandidate(f.scopeRef, candidateId, f.ctx)
    expect(links.map((link) => link.trustTier)).toEqual(['agent_researched'])
  })

  it('reports unconfirmed candidates for the workspace and keeps tenant/space isolation', async () => {
    const f = await fixture('submission_b')
    const runId = randomUUID()
    await f.store.record(f.scopeRef, { record: record(f, runId, 'idem-key-0002', DIGEST_A, randomUUID()) }, f.ctx)
    const pending = await f.store.listUnconfirmedByWorkspace(f.scopeRef, f.workspaceId, f.ctx)
    expect(pending).toHaveLength(1)

    const other = toolContext('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888', ['platform-admin'], 'other')
    await expect(f.store.findByKey(f.scopeRef, { runId, idempotencyKey: 'idem-key-0002' }, other)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})
